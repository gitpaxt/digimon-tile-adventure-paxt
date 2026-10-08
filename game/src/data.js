// Data layer: loads the scraped Wikimon dataset and exposes game-friendly
// lookups (stage buckets, evolution resolution, icon paths).
//
// The scraper stores evolution *stage* using Japanese-convention terms
// (level_jp). We bucket those into the six playable stages used by the game.
const LEVEL_JP_TO_STAGE = {
  "Baby I": "baby1",
  "Baby II": "baby2",
  "Child": "rookie",
  "Adult": "champion",
  "Armor": "armor",
  "Perfect": "ultimate",
  "Ultimate": "mega",
};

const STAGE_ORDER = ["baby1", "baby2", "rookie", "champion", "armor", "ultimate", "mega", "giga", "tera", "peta"];

// my_official_digimon_data.json is hand-edited directly (see the "level"
// field), so its "level" values drift toward whatever's natural to type —
// the plain English stage names you actually see in-game (Champion, Mega,
// Giga, Tera, Peta, Armor, Rookie...), in any casing — rather than the raw
// scraper's Japanese-convention vocabulary above. Both are accepted, case-
// insensitively; this is a pure superset, nothing above stops working.
// "Ultimate" (capitalized exactly like that) stays reserved for the raw
// scrape's legacy meaning (-> mega) for backward compatibility with a
// fresh pipeline run; every other casing of "ultimate" means the Ultimate
// stage itself, same as "Perfect".
const STAGE_NAME_ALIASES = (() => {
  const map = new Map();
  for (const [k, v] of Object.entries(LEVEL_JP_TO_STAGE)) map.set(k.toLowerCase(), v);
  for (const s of STAGE_ORDER) map.set(s, s); // "mega"/"giga"/"tera"/"peta"/"armor"/... already lowercase
  map.set("ultimate", "ultimate"); // overrides the lowercased "Ultimate"->mega alias above on purpose
  return map;
})();
function resolveStage(level) {
  if (!level) return null;
  return STAGE_NAME_ALIASES.get(String(level).toLowerCase()) || null;
}

// Power TIER, as opposed to raw STAGE_ORDER position: Armor sits at the
// same tier as Champion (it's "treated as if it were an Adult/Champion"
// per spec), so both only lead to Ultimate next, and Rookie leads to
// *either* of them. Every other stage is its own tier. This is what
// "one level higher" (see possibleEvolutions) and nextStage actually key
// off of — STAGE_ORDER's linear position stays around only for ordinal
// "who outranks who" comparisons elsewhere, which never see "armor" on
// the wild-enemy side since no Sector weights spawn it.
const STAGE_TIER = {
  baby1: 0, baby2: 1, rookie: 2, champion: 3, armor: 3,
  ultimate: 4, mega: 5, giga: 6, tera: 7, peta: 8,
};

// Official level names per my_official_digimon_data.json's own convention
// (Baby I, Baby II, Child, Adult, Perfect, Mega, Giga, Tera) — see the
// identical STAGE_SHORT_LABEL in config.js, which is what actually gets
// displayed; "rookie"/"champion"/"ultimate" are internal stage keys only.
const STAGE_LABEL = {
  baby1: "Baby I",
  baby2: "Baby II",
  rookie: "Child",
  champion: "Adult",
  armor: "Armor",
  ultimate: "Perfect",
  mega: "Mega",
  giga: "Giga",
  tera: "Tera",
  peta: "Peta",
};

const DG_DATA = (() => {
  let byName = new Map();
  let byStage = { baby1: [], baby2: [], rookie: [], champion: [], armor: [], ultimate: [], mega: [], giga: [], tera: [], peta: [] };
  let starters = [];
  let ready = false;
  // "What evolves directly FROM X" — the reverse of evolves_to, built once
  // at load time (evolves_to is the single source of truth now; see
  // build_my_digimon_data.py). A plain Map<name, string[]> of parent names.
  const parentsByChild = new Map();

  async function load() {
    const [entries, manifest] = await Promise.all([
      // my_official_digimon_data.json is the ONE file the game actually
      // reads — a one-time copy of build_my_digimon_data.py's output that
      // is then yours to hand-edit freely. build_my_digimon_data.py never
      // writes to this file, so re-running it (which regenerates
      // my_digimon_data.json / my_digimon_data_nogiga.json from the raw
      // scrape) can never clobber your edits here. To pull in a fresh
      // pipeline run, copy my_digimon_data.json over this file yourself.
      fetch("data/my_official_digimon_data.json").then((r) => r.json()),
      fetch("data/icons_manifest.json").then((r) => r.json()),
    ]);

    const iconByName = new Map();
    for (const m of manifest) iconByName.set(m.name, "data/icons/" + m.file);

    for (const e of entries) {
      const stage = resolveStage(e.level);
      const iconPath = iconByName.get(e.name);
      if (!stage || !iconPath) continue; // skip Hybrid/"No Level"/unclassified/no-icon entries
      const augmented = { ...e, stage, iconPath };
      byName.set(e.name, augmented);
    }

    for (const entry of byName.values()) {
      byStage[entry.stage].push(entry);
    }

    for (const entry of byName.values()) {
      for (const childName of entry.evolves_to) {
        if (!byName.has(childName)) continue; // only real, validated targets
        if (!parentsByChild.has(childName)) parentsByChild.set(childName, []);
        parentsByChild.get(childName).push(entry.name);
      }
    }

    // Every Baby I is a valid starter choice — sorted for a scannable picker.
    starters = byStage.baby1.map((e) => e.name).sort((a, b) => a.localeCompare(b));
    ready = true;
    console.log(
      `[data] loaded ${byName.size} playable Digimon`,
      Object.fromEntries(STAGE_ORDER.map((s) => [s, byStage[s].length]))
    );
  }

  function getEntry(name) {
    return byName.get(name) || null;
  }

  function stageIndex(stage) {
    return STAGE_ORDER.indexOf(stage);
  }

  // Tier-aware, unlike plain STAGE_ORDER position: Champion and Armor share
  // a tier, so nextStage("champion") correctly skips over "armor" and
  // lands on "ultimate" (first stage found at tier+1, in STAGE_ORDER's own
  // order) rather than treating armor as a lesser in-between step.
  function nextStage(stage) {
    const tier = STAGE_TIER[stage];
    if (tier === undefined) return null;
    return STAGE_ORDER.find((s) => STAGE_TIER[s] === tier + 1) || null;
  }

  function pickRandom(arr, rng) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor((rng ? rng() : Math.random()) * arr.length)];
  }

  function pickRandomByStage(stage, rng) {
    return pickRandom(byStage[stage], rng);
  }

  // The Attribute (Vaccine/Data/Virus) the player has eaten the most food
  // toward, or null if no clear preference yet.
  function topAffinityAttribute(affinity) {
    let best = null, bestVal = 0;
    for (const [attr, val] of Object.entries(affinity || {})) {
      if (val > bestVal) { bestVal = val; best = attr; }
    }
    return best;
  }

  // The real, hand-edited evolves_to list (see my_digimon_data_nogiga.json)
  // trimmed down to only the names that are exactly one TIER higher than
  // `name`'s own tier (see STAGE_TIER) — e.g. Botamon's evolves_to may
  // list a Baby II, a Champion, an Armor, an Ultimate and a Mega all at
  // once, but only the Baby II entries are a real "next step" and get
  // returned here. No fallback substitute if nothing qualifies — this is
  // the single source of truth for both what the player can evolve into
  // (pickEvolution) and what the Evolutions panel displays, so they can
  // never disagree.
  function possibleEvolutions(name) {
    const entry = getEntry(name);
    if (!entry) return [];
    const myTier = STAGE_TIER[entry.stage];
    return entry.evolves_to.filter((childName) => {
      const child = getEntry(childName);
      return child && STAGE_TIER[child.stage] === myTier + 1;
    });
  }

  // Resolve what `currentName` evolves into next, picking only among real,
  // validated, exactly-one-tier-higher candidates (see possibleEvolutions)
  // — no stage-ceiling fallback beyond that, no random-by-stage substitute.
  // If nothing qualifies, there's simply nothing to evolve into yet. When
  // several real candidates tie, `affinity` (built from eating typed
  // digifood) biases the pick toward whichever shares the player's
  // favored Attribute.
  function pickEvolution(currentName, rng, affinity) {
    let pool = possibleEvolutions(currentName);
    if (!pool.length) return null;
    if (pool.length > 1) {
      const topAttr = topAffinityAttribute(affinity);
      if (topAttr) {
        const matching = pool.filter((childName) => getEntry(childName)?.attribute === topAttr);
        if (matching.length) pool = matching;
      }
    }
    return pickRandom(pool, rng);
  }

  function attributeProjectileColor(attribute) {
    if (attribute === "Virus") return "#7fd8ff"; // light blue
    return "#ffe066"; // yellow default (Vaccine/Data/Free/Variable/unknown)
  }

  // Is `b` reachable from `a` by following evolves_to edges, at any
  // distance? Some wiki entries have their whole descendant chain
  // reachable directly, so a candidate that's itself an ancestor of
  // another candidate in the same list is a grandchild (or further), not
  // a direct link.
  function isAncestor(a, b) {
    if (a === b) return false;
    const seen = new Set([a]);
    const queue = [...(getEntry(a)?.evolves_to || [])];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === b) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const c of getEntry(cur)?.evolves_to || []) queue.push(c);
    }
    return false;
  }

  // Direct parents only: drop any candidate in `name`'s parent list that
  // is itself an ancestor of another candidate in that same list.
  function getDirectParents(name) {
    const candidates = parentsByChild.get(name) || [];
    return candidates.filter((p) => !candidates.some((q) => q !== p && isAncestor(p, q)));
  }

  // What evolves directly FROM `name` — straight from its own evolves_to,
  // collapsed to direct links only (mirrors getDirectParents).
  function getChildren(name) {
    const candidates = (getEntry(name)?.evolves_to || []).filter((c) => byName.has(c));
    return candidates.filter((c) => !candidates.some((d) => d !== c && isAncestor(d, c)));
  }

  // Case-insensitive substring match against the Digimon's name, for the
  // DigiEvolution Tree Search. Returns every match — an exact match is
  // sorted first, the rest alphabetically.
  function searchByName(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results = [];
    for (const entry of byName.values()) {
      if (entry.name.toLowerCase().includes(q) || (entry.english_name || "").toLowerCase().includes(q)) {
        results.push(entry);
      }
    }
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q || (a.english_name || "").toLowerCase() === q;
      const bExact = b.name.toLowerCase() === q || (b.english_name || "").toLowerCase() === q;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return results;
  }

  return {
    load,
    getEntry,
    stageIndex,
    nextStage,
    pickRandomByStage,
    pickEvolution,
    possibleEvolutions,
    topAffinityAttribute,
    attributeProjectileColor,
    getChildren,
    getDirectParents,
    searchByName,
    get starters() {
      return starters;
    },
    get byStage() {
      return byStage;
    },
    get ready() {
      return ready;
    },
    STAGE_ORDER,
    STAGE_LABEL,
  };
})();
