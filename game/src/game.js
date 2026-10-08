// Main loop: input -> physics/collision -> AI -> combat -> render.
// Character-select / HUD / toasts are plain DOM; the canvas only draws the
// tile world + entities + projectiles.

const PACIFIC_CHANCE = 0.55;

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// Viewport grows with the player's stage: 7x7 normally, 11x11 at Mega,
// 13x13 at Giga/Tera. Kept mutable (unlike the base VIEWPORT_TILES config
// constant) since it changes live as the player evolves.
let currentViewportTiles = VIEWPORT_TILES;
function applyViewportSize(tiles) {
  currentViewportTiles = tiles;
  canvas.width = TILE_SIZE * tiles;
  canvas.height = TILE_SIZE * tiles;
}
applyViewportSize(VIEWPORT_TILES);

function updateViewportForStage() {
  const tiles = VIEWPORT_BY_STAGE[state.player.stage] || VIEWPORT_TILES;
  if (tiles !== currentViewportTiles) applyViewportSize(tiles);
}

const TILE_COLORS = {
  [TILE.RIVER]: "#3a7bd5",
  [TILE.FIRE]: "#8a2b12",
  [TILE.ICE]: "#bfe9f7",
  [TILE.SEA]: "#123a63",
  [TILE.ROCK]: "#4a4a4a",
  [TILE.VILLAGE]: "#c9a86a",
  [TILE.PORTAL]: "#140a1f",
  [TILE.GATE_LOCKED]: "#3a3540",
  [TILE.TREE]: "#0d2e12",
  [TILE.BURNING_TREE]: "#3a1a0a",
  [TILE.VOID]: "#000000",
  [TILE.GLASS]: "#9fd8e8",
};

// Tracks the current frame's timestamp (as passed to loop()) so charge/flee
// timers stay driven by the simulation clock rather than calling
// performance.now() again from event handlers/update code.
let currentFrameNow = performance.now();

const state = {
  mode: "charselect", // charselect | playing | respawning | victory | cutscene | paused | deepExplanation
  currentPlace: "village",
  placeCache: {},
  guardianDefeated: {},
  starterEntry: null,
  player: null,
  enemies: [],
  projectiles: [],
  items: [],
  camX: 0, camY: 0,
  keys: new Set(),
  settingsOpen: false,
  lastPlayerTileKey: null,
  lastTime: 0,
  fireTickAccum: 0,
  sectorsConquered: new Set(),
  finaleGateRevealed: false,
  finale: null, // set only while inside the True Yggdrasil finale scene
  cutscene: null, // { type, startTime, duration, data, onComplete } — freezes gameplay for a scripted moment
  digimentalUsed: false,
  // { text, color, until } — a big message in the lower part of the grid,
  // see showBanner/drawBannerOverlay. Purely cosmetic on its own; whether
  // it coincides with frozen gameplay is entirely up to whatever state.mode
  // is doing at the time (e.g. "You Died!"/"You Won!" freeze because
  // mode leaves "playing", "You Defeated the Guardian!" doesn't because
  // it never touches mode at all).
  banner: null,
  spriteScale: 1.0, // global Digimon render size, tunable via the settings panel
  nameLanguage: "english", // "english" | "japanese" — tunable via the settings panel, see digiName()
  gameTimerMs: 0, // elapsed time since the current life hatched; frozen whenever mode !== "playing"
  de: null, // { seq, idx, phaseStart, onComplete } — active "Deep Explanation" story beat
  seenIntroDE: false,
  pacificKills: 0,
  accidentalPacificKills: 0,
  lastAggressiveCombatMs: -Infinity, // last time player<->hostile damage was exchanged; used to judge "accidental" pacific kills
  everReachedMega: false, // once true, stays true across death/rebirth — gates the M key debug mega-evolve
  debugMode: false, // set by the D key, only if debug_mode.py is present on the server (see tryActivateDebugMode)
  wind: null, // { dx, dy, changeAt } — only set/used in a hasWind place (see updateWind)
};

// Single source of truth for which name to show for a Digimon, everywhere
// in the UI — the Pause panel's English/Japanese toggle flips state.
// nameLanguage, and every caller of this function updates instantly since
// nothing caches a resolved display name anywhere. `entry.name` is the
// Japanese-origin name (e.g. "Omegamon"); `entry.english_name` is the
// English dub name (e.g. "Omnimon").
function digiName(entry) {
  if (!entry) return "";
  if (state.nameLanguage === "japanese") return entry.name;
  return entry.english_name || entry.name;
}

const ACCIDENTAL_PACIFIC_WINDOW_MS = 5000;

function weightedPick(weights, rng = Math.random) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    if (r < w) return k;
    r -= w;
  }
  return entries[entries.length - 1][0];
}

function tileAt(levelData, tx, ty) {
  if (levelData.wrap) {
    const wx = ((tx % levelData.size) + levelData.size) % levelData.size;
    const wy = ((ty % levelData.size) + levelData.size) % levelData.size;
    return levelData.tiles[wy][wx];
  }
  if (tx < 0 || ty < 0 || tx >= levelData.size || ty >= levelData.size) return TILE.SEA;
  return levelData.tiles[ty][tx];
}

function isWalkableAt(levelData, px, py) {
  const tx = Math.floor(px / TILE_SIZE), ty = Math.floor(py / TILE_SIZE);
  const t = tileAt(levelData, tx, ty);
  // Crystal Palace's three keyed doors sit on otherwise-permanent GLASS
  // tiles — checked before the generic GLASS block below, since a door is
  // only ever open (walkable) once its matching key is held.
  const doorColor = levelData.crystalDoors?.get(`${tx},${ty}`);
  if (doorColor) return !!state.player.keys?.[doorColor];
  if (t === TILE.SEA || t === TILE.GLASS) return false; // Glass never breaks — always blocks
  if (t === TILE.ROCK || t === TILE.TREE) return (levelData.rockHP.get(`${tx},${ty}`) ?? 0) <= 0;
  if (t === TILE.GATE_LOCKED) return true; // walkable but non-functional until the Guardian falls
  if (machineAt(levelData, tx, ty)) return false; // Factorial Town's moving machines block like a wall
  return true;
}

// A crystal or key drop lands at the dying enemy's exact position — which
// can be sitting on an indestructible Glass tile (Hall of Mirrors, Crystal
// Palace, Chaos Zone, Mirror Dimension) or any other permanently-blocked
// tile, since enemies are never guaranteed to die somewhere walkable.
// Relocates to the nearest walkable tile's center instead, so a drop can
// never land somewhere the player could never actually reach.
function nearestWalkablePoint(levelData, px, py) {
  if (isWalkableAt(levelData, px, py)) return { x: px, y: py };
  const tx0 = Math.floor(px / TILE_SIZE), ty0 = Math.floor(py / TILE_SIZE);
  for (let r = 1; r <= 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only — interior already checked at smaller r
        const wx = (tx0 + dx) * TILE_SIZE + TILE_SIZE / 2, wy = (ty0 + dy) * TILE_SIZE + TILE_SIZE / 2;
        if (isWalkableAt(levelData, wx, wy)) return { x: wx, y: wy };
      }
    }
  }
  return { x: px, y: py }; // shouldn't happen on a real map — last-resort fallback
}

// Factorial Town: find the (at most one) machine currently occupying tile (tx,ty).
function machineAt(levelData, tx, ty) {
  if (!levelData.machines || levelData.machines.length === 0) return null;
  for (const m of levelData.machines) {
    if (m.hp > 0 && m.x === tx && m.y === ty) return m;
  }
  return null;
}

function getPlaceCfg(placeId) {
  if (placeId === "village") return VILLAGE;
  // A safe stub so generic per-frame code (HUD labels, Guardian checks,
  // settings) doesn't need to special-case the finale scene individually —
  // it just has no guardianStage/enemyStageWeights, so those paths no-op.
  if (placeId === "yggdrasil_finale") return { id: "yggdrasil_finale", name: "True Yggdrasil", isFinale: true };
  if (placeId === "void_dimension") {
    return {
      // recoilOnFire used to be true here — uncapped, never-decaying
      // recoil (frictionless has no friction to bleed it off) combined
      // with wraparound could rocket the player clear across the toroidal
      // world in a single shot, making their own attack appear to spawn
      // behind them. Removed outright rather than tuned, since nothing
      // about this place calls for a kickback mechanic in the first place.
      // `secret: true` here isn't about hiding it (it's not in
      // ALL_SECTORS at all, so it was never counted either way) — it's
      // what stops onEnemyKilled's generic isGuardian path from also
      // dropping a Sector crystal when the Dark Area's boss falls: the
      // boss should drop only the blue key, keeping the real total at 21.
      id: "void_dimension", name: "Dark Area", isFinale: true, frictionless: true, wrap: true, secret: true,
      // createEnemy() multiplies these into HP/damage — without them here
      // every Giga Digimon in the void ended up with NaN stats (undefined
      // * anything is NaN), which cascaded into NaN velocity via recoil and
      // then a console.warn flood every single frame — the real cause of
      // the "freeze" once an enemy actually attacked.
      hpMult: 1, dmgMult: 1, guardianHpMult: 1,
      // Just enough for the Village Gate-info tooltip (updateGateInfo) to
      // resolve "Max foes: Giga" correctly — the actual void spawns are
      // hardcoded in enterVoidDimension(), not driven by this field.
      enemyStageWeights: { giga: 1 },
      typicality: "Abandon all hope, ye who enter here.",
    };
  }
  return ALL_SECTORS.find((s) => s.id === placeId);
}

function seedForPlace(placeId) {
  return placeId === "village" ? 999 : 1000 + (placeId + 1) * 7919;
}

function getLevelData(placeId) {
  if (placeId === "yggdrasil_finale") {
    if (!state.placeCache[placeId]) state.placeCache[placeId] = buildFinaleLevelData();
    return state.placeCache[placeId];
  }
  if (placeId === "void_dimension") {
    if (!state.placeCache[placeId]) state.placeCache[placeId] = buildVoidLevelData();
    return state.placeCache[placeId];
  }
  if (!state.placeCache[placeId]) {
    const data = generateLevel(getPlaceCfg(placeId), seedForPlace(placeId));
    data.decorByKey = buildDecorByKey(data.decorations);
    state.placeCache[placeId] = data;
  }
  return state.placeCache[placeId];
}

function regeneratePlace(placeId) {
  const data = generateLevel(getPlaceCfg(placeId), Date.now() & 0xffffffff);
  data.decorByKey = buildDecorByKey(data.decorations);
  state.placeCache[placeId] = data;
}

// Several decorations can now share a tile (e.g. 10 corn stalks, or
// Botanical Garden's 12-flower stamp) — so this groups into arrays instead
// of the old one-decoration-per-tile Map.
function buildDecorByKey(decorations) {
  const map = new Map();
  for (const d of decorations) {
    const key = `${d.x},${d.y}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
const toastEl = document.getElementById("toasts");
// A floor of 6s on every toast, regardless of what each call site asks
// for — many were vanishing well before they could actually be read.
// Call sites that deliberately want longer (e.g. 6500ms) still get that;
// this only ever raises a duration, never shortens one.
const TOAST_MIN_MS = 6000;
function toast(msg, ms = 2400) {
  ms = Math.max(ms, TOAST_MIN_MS);
  const div = document.createElement("div");
  div.className = "toast";
  div.textContent = msg;
  toastEl.appendChild(div);
  setTimeout(() => div.classList.add("fade"), ms - 500);
  setTimeout(() => div.remove(), ms);
}

// ---------------------------------------------------------------------------
// Place population
// ---------------------------------------------------------------------------
// Sorts walkable tiles by distance from spawn (farthest first) and returns
// a shuffled slice of the farthest ~35% (or 3x what's needed, whichever is
// bigger) — self-scaling to the place's actual size instead of a fixed tile
// threshold, which broke down on small maps like the Village.
function pickFarSpawnPool(levelData, needed) {
  const sorted = levelData.allWalkable.slice().sort((a, b) => {
    const da = (a.x - levelData.spawn.x) ** 2 + (a.y - levelData.spawn.y) ** 2;
    const db = (b.x - levelData.spawn.x) ** 2 + (b.y - levelData.spawn.y) ** 2;
    return db - da;
  });
  const farSlice = sorted.slice(0, Math.max(needed * 3, Math.ceil(sorted.length * 0.35)));
  shuffle(farSlice, Math.random);
  return farSlice;
}

// The Guardian doesn't spawn up front — it appears (with a "red alert") only
// once every regular enemy in the Sector has been defeated. This tracks
// that per-place so re-entering doesn't repeat the alert pointlessly.
const placeGuardianState = {}; // placeId -> { spawned: bool }

function populatePlace(placeId, { far } = {}) {
  const levelData = getLevelData(placeId);
  const cfg = getPlaceCfg(placeId);
  const override = DG_DIFFICULTY_OVERRIDES[placeId];

  // If the Guardian's already marked defeated (a real kill, or the debug C
  // key), make sure this Sector's own Gate is actually open when entered —
  // it only ever gets flipped on inside the kill handler otherwise, so a
  // fresh/uncached visit would show it locked despite the flag.
  if (state.guardianDefeated[placeId] && levelData.sectorGate && !levelData.sectorGate.active) {
    levelData.sectorGate.active = true;
    levelData.tiles[levelData.sectorGate.y][levelData.sectorGate.x] = TILE.PORTAL;
  }

  // The Nightfall Lands' sunset-to-darkness sweep restarts fresh every
  // time you enter, rather than staying wherever it was from a previous
  // visit (levelData itself is cached and persists between visits).
  if (cfg.nightfall) levelData.nightfallStart = currentFrameNow;

  let enemyPts, itemPts;
  if (far) {
    const pool = pickFarSpawnPool(levelData, cfg.enemyCount + cfg.itemCount);
    enemyPts = pool.slice(0, cfg.enemyCount);
    itemPts = pool.slice(cfg.enemyCount, cfg.enemyCount + cfg.itemCount);
  } else {
    enemyPts = levelData.enemySpawns;
    itemPts = levelData.itemSpawns;
  }

  state.enemies = [];
  const spawns = enemyPts.slice();
  const count = Math.max(0, Math.round(spawns.length * override.enemyCountMult));

  for (let i = 0; i < Math.min(count, spawns.length); i++) {
    const sp = spawns[i];
    const stage = weightedPick(cfg.enemyStageWeights);
    const entry = DG_DATA.pickRandomByStage(stage);
    if (!entry) continue;
    let alignment = Math.random() < PACIFIC_CHANCE ? "pacific" : "hostile";
    if (cfg.forcePacificStages && cfg.forcePacificStages.includes(stage)) alignment = "pacific";
    const px = sp.x * TILE_SIZE + TILE_SIZE / 2, py = sp.y * TILE_SIZE + TILE_SIZE / 2;
    state.enemies.push(createEnemy(entry, alignment, false, px, py, cfg, override));
  }

  // A fixed number of guaranteed-stage extras (e.g. Yggdrasil Sector's 3
  // Giga, the Labyrinth's 10) on top of the normal weighted population above
  // — not a chance, an addition.
  if (cfg.guaranteedStageSpawns) {
    const safeR2 = (cfg.safeRadius ?? 4) ** 2;
    const farPool = levelData.allWalkable.filter(({ x, y }) => {
      const dx = x - levelData.spawn.x, dy = y - levelData.spawn.y;
      return dx * dx + dy * dy >= safeR2 * 1.5;
    });
    for (const [stage, num] of Object.entries(cfg.guaranteedStageSpawns)) {
      for (let i = 0; i < num && farPool.length > 0; i++) {
        const sp = farPool[Math.floor(Math.random() * farPool.length)];
        const entry = DG_DATA.pickRandomByStage(stage);
        if (!entry) continue;
        const alignment = Math.random() < PACIFIC_CHANCE ? "pacific" : "hostile";
        const px = sp.x * TILE_SIZE + TILE_SIZE / 2, py = sp.y * TILE_SIZE + TILE_SIZE / 2;
        state.enemies.push(createEnemy(entry, alignment, false, px, py, cfg, override));
      }
    }
  }

  state.items = itemPts.map((sp) => createItem(sp.x * TILE_SIZE + TILE_SIZE / 2, sp.y * TILE_SIZE + TILE_SIZE / 2, cfg.foodWeightOverrides, cfg.customFoodTypes));

  // Sushi Island: a dense SECOND layer of sushi on top of the normal
  // fruits above — 90% of whichever grass tiles the fruits didn't already
  // claim — each one eaten for exactly +1 digicharge / -1 HP (see
  // updateItems and drawItem's iconScale handling).
  if (cfg.sushiOverlay) {
    const occupied = new Set(state.items.map((it) => `${Math.floor(it.x / TILE_SIZE)},${Math.floor(it.y / TILE_SIZE)}`));
    for (let y = 0; y < levelData.size; y++) {
      for (let x = 0; x < levelData.size; x++) {
        if (levelData.tiles[y][x] !== TILE.GRASS) continue;
        const key = `${x},${y}`;
        if (occupied.has(key) || Math.random() >= cfg.sushiOverlay.coverage) continue;
        const px = x * TILE_SIZE + TILE_SIZE / 2, py = y * TILE_SIZE + TILE_SIZE / 2;
        const item = createItem(px, py, null, cfg.sushiOverlay.types);
        item.iconScale = cfg.sushiOverlay.iconScale;
        item.isSushiOverlay = true;
        state.items.push(item);
      }
    }
  }

  state.projectiles = [];
  placeGuardianState[placeId] = { spawned: false };

  // Cloning City's recurring nemesis: every (re-)entry refreshes its
  // presence if it should still be around — state.enemies was just wiped
  // above, so without this it wouldn't come back until its next death,
  // even though it logically never actually left.
  if (cfg.cloningCity) spawnCloningRecurringGuardian(levelData);
}

// Find a walkable spot roughly `radiusTiles` away from (px,py) — used to
// make the Guardian's "red alert" entrance appear near the player without
// spawning literally on top of them.
// Picks the tile from the place's (connectivity-filtered, so always
// reachable) walkable list whose distance from (px,py) is closest to the
// requested radius — rather than raw random-angle probing, which could
// land on a tile that's technically "grass" but stranded on a disconnected
// pocket (e.g. across a river or on a tiny coastline island).
function findWalkableNear(levelData, px, py, radiusTiles) {
  const targetDistPx = radiusTiles * TILE_SIZE;
  let best = null, bestDiff = Infinity;
  for (const { x, y } of levelData.allWalkable) {
    const wx = x * TILE_SIZE + TILE_SIZE / 2, wy = y * TILE_SIZE + TILE_SIZE / 2;
    const diff = Math.abs(Math.hypot(wx - px, wy - py) - targetDistPx);
    if (diff < bestDiff) { bestDiff = diff; best = { x: wx, y: wy }; }
  }
  return best || { x: px, y: py };
}

// Once every regular (non-Guardian) enemy in a Guardian Sector is dead, a
// red alert fires and the Guardian appears near the player — slower, but a
// level stronger than its normal stats.
// The Guardian's stage is always one stage above the Sector's own hostile
// ceiling (forcePacific stages don't count toward that ceiling — a
// "gentle giant" doesn't make the Sector any more dangerous). Skips over
// any stage with zero real Digimon in the data (e.g. Tera is currently
// empty), so it always resolves to something spawnable.
function computeGuardianStage(cfg) {
  const hostile = Object.keys(cfg.enemyStageWeights || {}).filter((s) => !(cfg.forcePacificStages || []).includes(s));
  let maxIdx = -1, maxStage = "rookie";
  for (const s of hostile) {
    const idx = DG_DATA.stageIndex(s);
    if (idx > maxIdx) { maxIdx = idx; maxStage = s; }
  }
  let next = DG_DATA.nextStage(maxStage);
  while (next && DG_DATA.byStage[next].length === 0) next = DG_DATA.nextStage(next);
  return next || maxStage;
}

function checkGuardianTrigger(levelData) {
  // Redundant, hardcoded belt-and-suspenders: Cloning City (id 6) must
  // NEVER spawn a Guardian through this generic system, full stop,
  // regardless of whatever getPlaceCfg(6) happens to report.
  if (state.currentPlace === 6) return;
  const cfg = getPlaceCfg(state.currentPlace);
  // Crystal Palace and Cloning City don't use the normal Guardian system
  // at all — their own custom sequences live in checkCrystalPalaceProgress
  // and checkCloningCityBoss respectively.
  if (cfg.isVillage || cfg.isFinale || cfg.isCrystalPalace || cfg.cloningCity || state.guardianDefeated[state.currentPlace]) return;
  const gs = placeGuardianState[state.currentPlace];
  if (!gs || gs.spawned) return;

  // A Sector can pin its Guardian's stage directly (e.g. the Labyrinth,
  // whose "Tera" Guardian falls back to Giga — see the note on that field
  // in config.js) instead of the normal "one stage above the ceiling" rule.
  const guardianStage = cfg.guardianStageOverride || computeGuardianStage(cfg);
  // Pacific Digimon never have to die for the Guardian to appear — only the
  // *aggressive* ones (hostile, or a pacific one that's been provoked) are
  // ever required, everywhere. `requireFullClear` (Sarba Continent and
  // every Sector past it, see config.js) only removes the outrank shortcut:
  // those Guardians wait for the aggressive Digimon to fall regardless of
  // how strong the player already is; Native Forest and the
  // beginner-friendly Sectors still let it appear right away if you
  // outrank it.
  const requireFullClear = cfg.requireFullClear === true;
  // The immediate-appearance shortcut is now reserved for Mega-stage
  // players specifically — anyone below Mega no longer skips the line
  // just by outranking a low Guardian; everyone else always waits for
  // every aggressive Digimon to fall first. "At least Mega" includes
  // Mega I/II/III, Giga, and Tera.
  const outranksGuardian = !requireFullClear && DG_DATA.stageIndex(state.player.stage) >= DG_DATA.stageIndex("mega") && DG_DATA.stageIndex(state.player.stage) >= DG_DATA.stageIndex(guardianStage);
  const aggressiveAlive = state.enemies.some((e) => !e.dead && !e.isGuardian && (e.alignment === "hostile" || e.provoked));
  if (!outranksGuardian && aggressiveAlive) return;

  gs.spawned = true;
  const override = DG_DIFFICULTY_OVERRIDES[state.currentPlace];
  const guardianEntry = DG_DATA.pickRandomByStage(guardianStage);
  if (!guardianEntry) return;
  // The Labyrinth's Guardian waits inside its sealed cube rather than
  // appearing near the player like every other Sector's Guardian.
  const spot = levelData.guardianCubeCenter || findWalkableNear(levelData, state.player.x, state.player.y, 4.5);
  const guardian = createEnemy(guardianEntry, "guardian", true, spot.x, spot.y, cfg, override);
  guardian.maxHp = Math.round(guardian.maxHp * 1.4); // "a level stronger"
  guardian.hp = guardian.maxHp;
  guardian.dmgMult *= 1.25;
  guardian.moveSpeedMult = 0.5; // "...but slow"
  // The Digital Abyss's and Chaos Zone's Guardians each drop one of the
  // three keys Crystal Palace needs (see onEnemyKilled/updateKeyDrops) —
  // the Dark Area's own "boss" is tagged separately in enterVoidDimension.
  if (state.currentPlace === 12) guardian.dropsKey = "red";
  else if (state.currentPlace === 11) guardian.dropsKey = "green";
  state.enemies.push(guardian);

  triggerRedAlert();
  toast(`⚠ RED ALERT — the Guardian of ${cfg.name} appears!`, 3400);
  updateHUDPlaceLabel();
}

let redAlertUntil = 0;
function triggerRedAlert() {
  redAlertUntil = currentFrameNow + 1400;
}

// Cloning City's own boss sequence — fully separate from the generic
// Guardian system (see the cloningCity bypass in checkGuardianTrigger).
// The 4 Cloning Machines' own clones are ordinary fodder, not the boss;
// the real boss only appears once every clone is dead AND all 4 Machines
// are fully destroyed (not just momentarily clone-free, since a still-
// powered Machine will just make another the moment the last one falls).
// It alone drops the crystal — handled for free by the normal isGuardian
// path in onEnemyKilled, since this boss is tagged isGuardian too.
// Cloning City's recurring nemesis: always the one memorized species
// (levelData.cloningBossSpecies), reappearing at a random still-powered
// Cloning Machine every time it's killed — see the respawn call in
// onEnemyKilled. Never flagged isGuardian (so it never opens the Gate or
// drops the crystal itself); once every Machine is destroyed it simply
// stops being able to reappear at all.
function spawnCloningRecurringGuardian(levelData) {
  const cfg = getPlaceCfg(state.currentPlace);
  if (!cfg.cloningCity || !levelData.cloningBossSpecies || levelData.cloningBossSpawned) return;
  const poweredMachines = levelData.cloningMachines.filter((cm) => levelData.machines.some((m) => m.cloningIndex === cm.index && m.hp > 0));
  if (poweredMachines.length === 0) return;
  const cm = poweredMachines[Math.floor(Math.random() * poweredMachines.length)];
  const override = DG_DIFFICULTY_OVERRIDES[state.currentPlace];
  const px = cm.x * TILE_SIZE + TILE_SIZE / 2, py = cm.y * TILE_SIZE + TILE_SIZE / 2;
  const guardian = createEnemy(levelData.cloningBossSpecies, "hostile", false, px, py, cfg, override);
  guardian.maxHp = Math.round(guardian.maxHp * 1.4);
  guardian.hp = guardian.maxHp;
  guardian.dmgMult *= 1.25;
  guardian.isCloningRecurringGuardian = true;
  state.enemies.push(guardian);
}

// The final boss only appears once every Cloning Machine is destroyed AND
// every enemy (the recurring nemesis included) is dead — it's the exact
// same species as that recurring nemesis, and it alone is flagged
// isGuardian, so it alone opens the Gate and drops the crystal (at its
// own death position, via the normal onEnemyKilled path — a real drop,
// not an instant hand-off to the player).
function checkCloningCityBoss(levelData) {
  const cfg = getPlaceCfg(state.currentPlace);
  if (!cfg.cloningCity || levelData.cloningBossSpawned) return;
  if (levelData.machines?.some((m) => m.hp > 0)) return;
  const aggressiveAlive = state.enemies.some((e) => !e.dead && (e.alignment === "hostile" || e.alignment === "guardian" || e.provoked));
  if (aggressiveAlive) return;
  levelData.cloningBossSpawned = true;
  const override = DG_DIFFICULTY_OVERRIDES[state.currentPlace];
  const entry = levelData.cloningBossSpecies || DG_DATA.pickRandomByStage("giga");
  if (!entry) return;
  const spot = findWalkableNear(levelData, state.player.x, state.player.y, 4.5);
  const boss = createEnemy(entry, "guardian", true, spot.x, spot.y, cfg, override);
  boss.maxHp = Math.round(boss.maxHp * 1.4); // "a level stronger", same bump every other Sector's Guardian gets
  boss.hp = boss.maxHp;
  boss.dmgMult *= 1.25;
  boss.moveSpeedMult = 0.5;
  state.enemies.push(boss);
  triggerRedAlert();
  toast(`⚠ RED ALERT — the true overseer of ${cfg.name} emerges!`, 3400);
  updateHUDPlaceLabel();
}

// Crystal Palace's fully custom encounter — no normal Guardian at all.
// Phases, tracked on the levelData itself (so they persist across visits
// via the place cache): "locked" -> "arenaRevealed" -> "bossSpawned" ->
// cleared (handled by the normal onEnemyKilled isGuardian path, since the
// boss itself IS flagged isGuardian).
function checkCrystalPalaceProgress(levelData) {
  const cfg = getPlaceCfg(state.currentPlace);
  if (!cfg.isCrystalPalace) return;
  if (!levelData.crystalPalacePhase) levelData.crystalPalacePhase = "locked";
  const keys = state.player.keys;

  if (levelData.crystalPalacePhase === "locked") {
    if (keys?.red && keys?.green && keys?.blue) {
      revealCrystalPalaceArena(levelData, cfg);
      levelData.crystalPalacePhase = "arenaRevealed";
    }
    return;
  }
  if (levelData.crystalPalacePhase === "arenaRevealed") {
    const waveAlive = state.enemies.some((e) => e.cpArenaWave && !e.dead);
    if (!waveAlive) {
      spawnCrystalPalaceBoss(levelData, cfg);
      levelData.crystalPalacePhase = "bossSpawned";
    }
  }
}

// All three keys held: the inner 20x20 stops being solid glass and
// becomes a polished mirror arena (see levelData.mirrorArenaTiles, read by
// render()), and 8 Giga appear inside it.
function revealCrystalPalaceArena(levelData, cfg) {
  const b = levelData.castleBounds;
  if (!b) return;
  levelData.mirrorArenaTiles = new Set();
  const spots = [];
  for (let y = b.innerStartY; y < b.innerEndY; y++) {
    for (let x = b.innerStartX; x < b.innerEndX; x++) {
      levelData.tiles[y][x] = TILE.GRASS;
      levelData.mirrorArenaTiles.add(`${x},${y}`);
      spots.push({ x, y });
    }
  }
  toast("The three keys align — the Castle's heart opens into a polished arena!", 4200);
  triggerRedAlert();
  const override = DG_DIFFICULTY_OVERRIDES[state.currentPlace] || FAKE_FINALE_CFG;
  for (let i = 0; i < 8; i++) {
    const spot = spots[Math.floor(Math.random() * spots.length)];
    const entry = DG_DATA.pickRandomByStage("giga");
    if (!entry) continue;
    const enemy = createEnemy(entry, "hostile", false, spot.x * TILE_SIZE + TILE_SIZE / 2, spot.y * TILE_SIZE + TILE_SIZE / 2, cfg, override);
    enemy.cpArenaWave = true;
    state.enemies.push(enemy);
  }
}

// The 8 Giga are down — the real boss appears. It's flagged isGuardian so
// its death goes through the normal crystal-drop/Gate-unlock path in
// onEnemyKilled exactly like any other Sector's Guardian.
function spawnCrystalPalaceBoss(levelData, cfg) {
  const b = levelData.castleBounds;
  const bossX = ((b.innerStartX + b.innerEndX) / 2) * TILE_SIZE + TILE_SIZE / 2;
  const bossY = ((b.innerStartY + b.innerEndY) / 2) * TILE_SIZE + TILE_SIZE / 2;
  const override = DG_DIFFICULTY_OVERRIDES[state.currentPlace] || FAKE_FINALE_CFG;
  const bossEntry = DG_DATA.pickRandomByStage("giga");
  if (!bossEntry) return;
  const boss = createEnemy(bossEntry, "guardian", true, bossX, bossY, cfg, override);
  boss.maxHp = Math.round(boss.maxHp * 2);
  boss.hp = boss.maxHp;
  boss.dmgMult *= 1.5;
  state.enemies.push(boss);
  triggerRedAlert();
  toast("⚠ The Castle's true guardian emerges!", 3600);
}

// `arriveAt` places the player at a specific tile (the Gate just used)
// instead of the place's default spawn point — so warping through a Gate
// drops you right back at a Gate on the other side, not somewhere random.
function placePlayerAtSpawn(placeId, arriveAt) {
  const levelData = getLevelData(placeId);
  const tile = arriveAt || levelData.spawn;
  state.player.x = tile.x * TILE_SIZE + TILE_SIZE / 2;
  state.player.y = tile.y * TILE_SIZE + TILE_SIZE / 2;
}

// The Yggdrasil Tera Guardians (see spawnFinaleTeraSwarm) are tagged to
// follow the player through any Gate instead of being left behind like
// every other enemy when the place changes — pulled out of the OLD
// place's enemy list right before it gets wiped, then grafted onto
// whatever's next once that's settled.
function extractGateFollowers() {
  return state.enemies.filter((e) => e.isYggdrasilTeraGuardian && !e.dead);
}
function placeGateFollowers(followers) {
  for (const f of followers) {
    f.x = state.player.x + (Math.random() * 2 - 1) * TILE_SIZE * 2;
    f.y = state.player.y + (Math.random() * 2 - 1) * TILE_SIZE * 2;
    state.enemies.push(f);
  }
}

function enterPlace(placeId, { keepEntities, far, arriveAt } = {}) {
  const followers = extractGateFollowers();
  if (placeId === "yggdrasil_finale") { enterFinale(); placeGateFollowers(followers); return; }
  if (placeId === "void_dimension") { enterVoidDimension(); placeGateFollowers(followers); return; }
  // Wind (and its streak trails) is local to whichever Windy-Desert-like
  // place set it — never let a gust in progress leak into wherever the
  // Gate takes you next (the stray-streak bug: this frame's render() may
  // still be mid-flight with the OLD place's levelData, which still has
  // its streaks array — but drawWindStreaks also requires state.wind, so
  // nulling it here is what actually stops them from ever being drawn
  // again, no matter which levelData reference a transition frame holds).
  state.wind = null;
  state.currentPlace = placeId;
  placePlayerAtSpawn(placeId, arriveAt);
  if (!keepEntities) populatePlace(placeId, { far });
  placeGateFollowers(followers);
  // Seed lastPlayerTileKey with the tile we just landed on (rather than
  // null) so arriving exactly on a Gate doesn't instantly re-trigger it —
  // you have to step off and back on to use it again.
  const tx = Math.floor(state.player.x / TILE_SIZE), ty = Math.floor(state.player.y / TILE_SIZE);
  state.lastPlayerTileKey = `${tx},${ty}`;
  updateHUDPlaceLabel();
}

// Stepping onto a Gate tile: in the Village, warps to that Gate's Sector
// (arriving right at that Sector's own Gate); in a Sector, an active Gate
// (there's only ever one) warps back to the Village, arriving at the
// specific Village Gate that leads to that Sector. Triggers once per
// tile-entry so it doesn't spam a toast while standing on a locked Gate,
// and doesn't ping-pong you back and forth on arrival.
function checkPortalInteraction(levelData) {
  const tx = Math.floor(state.player.x / TILE_SIZE), ty = Math.floor(state.player.y / TILE_SIZE);
  const key = `${tx},${ty}`;
  if (key === state.lastPlayerTileKey) return;
  state.lastPlayerTileKey = key;
  const tile = tileAt(levelData, tx, ty);

  if (state.currentPlace === "village") {
    if (tile !== TILE.PORTAL) return;
    const portal = levelData.portals.find((p) => p.x === tx && p.y === ty);
    if (!portal) return;
    const destData = getLevelData(portal.targetSectorId);
    enterPlace(portal.targetSectorId, { arriveAt: destData.sectorGate });
    toast(`Warped ${portal.label}.`);
    return;
  }

  if (tile === TILE.PORTAL) {
    const fromSector = state.currentPlace;
    const villageData = getLevelData("village");
    const homeGate = villageData.portals.find((p) => p.targetSectorId === fromSector);
    enterPlace("village", { arriveAt: homeGate });
    toast("The Gate carries you back to the Village.");
  } else if (tile === TILE.GATE_LOCKED) {
    toast("This Gate is sealed — defeat this Sector's Guardian first.", 1800);
  }
}

// Energy never piles up past the current stage's own threshold — without
// this, a Digimon with no further evolution target (Tera with no real
// Peta to become, or any other dead end) would just accumulate energy
// forever past the point it means anything. For Tera specifically,
// hitting the cap is the trigger for the All Delete ability (Ctrl+A) —
// a one-time toast announces it the instant the cap is first reached.
function gainEnergy(amount) {
  const p = state.player;
  const cap = ENERGY_THRESHOLDS[p.stage];
  const wasAtCap = Number.isFinite(cap) && p.energy >= cap;
  p.energy += amount;
  if (Number.isFinite(cap)) p.energy = Math.min(p.energy, cap);
  if (p.stage === "tera" && !wasAtCap && p.energy >= cap) {
    toast("⚡ Digicharge full — press Ctrl+A to unleash All Delete!", 6000);
  }
}

// ---------------------------------------------------------------------------
// Evolution / death
// ---------------------------------------------------------------------------
function checkEvolution() {
  const p = state.player;
  const threshold = ENERGY_THRESHOLDS[p.stage];
  if (p.energy < threshold) return;
  // Whatever's hand-written in this Digimon's own evolves_to (see
  // my_official_digimon_data.json — the one file the game actually reads,
  // see data.js) is the candidate pool, trimmed to targets exactly one
  // tier higher (DG_DATA.possibleEvolutions) — no random-by-stage
  // fallback beyond that. Empty/no-qualifying evolves_to just means it
  // can't evolve yet.
  const nextName = DG_DATA.pickEvolution(p.name, Math.random, p.affinity);
  const nextEntry = nextName && DG_DATA.getEntry(nextName);
  if (!nextEntry) return;
  p.energy -= threshold;
  const fromName = digiName(p.entryData);
  const toName = digiName(nextEntry);
  startCutscene("evolve", 10000, { fromName, toName }, () => {
    evolvePlayer(p, nextEntry);
    updateViewportForStage();
    if (DG_DATA.stageIndex(p.stage) >= DG_DATA.stageIndex("mega")) state.everReachedMega = true;
    toast(`${digiName(p.entryData)} evolved to ${STAGE_SHORT_LABEL[p.stage]}!`);
  });
}

// Mega I -> II -> III via the power meter (red/green/yellow/white fruit).
// Instance-only — doesn't touch the species' data, doesn't apply once past
// Mega (Giga/Tera already have Mega III's abilities and more).
function gainMegaPower(amount) {
  const p = state.player;
  if (p.stage !== "mega" || p.megaTier >= 3) return;
  p.megaPower += amount;
  const need = MEGA_TIER.thresholds[p.megaTier - 1];
  if (p.megaPower >= need) {
    p.megaPower -= need;
    p.megaTier += 1;
    toast(`${digiName(p.entryData)} surges with power — now Mega ${["I", "II", "III"][p.megaTier - 1]}!`, 3000);
  }
}

// Aura: Mega III+ (and always Giga/Tera) reduces incoming damage and burns
// nearby enemies, "so the enemies stay outside".
function currentAura(player) {
  if (player.stage === "mega") {
    if (player.megaTier < MEGA_TIER.auraMinTier) return null;
    return { radiusPx: MEGA_TIER.auraRadiusTiles.mega * TILE_SIZE };
  }
  if (player.stage === "giga") return { radiusPx: MEGA_TIER.auraRadiusTiles.giga * TILE_SIZE };
  if (player.stage === "tera") return { radiusPx: MEGA_TIER.auraRadiusTiles.tera * TILE_SIZE };
  if (player.stage === "peta") return { radiusPx: MEGA_TIER.auraRadiusTiles.peta * TILE_SIZE };
  return null;
}

let auraTickAccum = 0;
function updateAura(dt) {
  const p = state.player;
  const aura = currentAura(p);
  if (!aura) return;
  auraTickAccum += dt;
  if (auraTickAccum < 0.5) return;
  auraTickAccum = 0;
  const dmg = Math.round(MEGA_TIER.auraDamagePerSecond * 0.5);
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    if (Math.hypot(enemy.x - p.x, enemy.y - p.y) <= aura.radiusPx) damageEnemy(enemy, dmg, p.stage, true, p.megaTier);
  }
}

// Real death resets all Sector progress — every Crystal, every key, and
// every Sector's own state (its enemies, its Guardian, Cloning Machines,
// etc.) are lost, restoring the whole world to how it was before any
// Sector was ever visited. wiping placeCache forces every place (the
// Village included) to regenerate from scratch next time it's entered;
// guardianDefeated/sectorsConquered/finaleGateRevealed are the separate
// one-time flags that would otherwise outlive that wipe and leave things
// inconsistent (a Guardian that can never reappear, a Yggdrasil gate that
// can never re-open). Only the player's own stage/stats/score survive.
function resetSectorProgressOnDeath() {
  state.sectorsConquered = new Set();
  state.guardianDefeated = {};
  state.finaleGateRevealed = false;
  if (state.player.keys) state.player.keys = { red: false, green: false, blue: false };
  state.placeCache = {};
  // Without this, a Yggdrasil Tera Guardian mid-chase (see
  // extractGateFollowers) would survive the death and follow the
  // freshly-hatched DigiEgg straight into the "safe" Village.
  state.enemies = state.enemies.filter((e) => !e.isYggdrasilTeraGuardian);
}

// Shared by every real "dies and comes back as a DigiEgg" path (ordinary
// death, and a repeat Endgame loss after the Digimental's already been
// used — NOT the first Endgame loss, which grants the Digimental instead
// of actually respawning). Freezes on a big red "You Died!" banner for
// 3s before resetting Sector progress and cutting to the hatch cutscene.
function respawnAsDigiEgg(toastMsg, extraReset) {
  state.mode = "respawning";
  showBanner("You Died!", "#ff1a1a", 3000);
  toast(toastMsg, 1400);
  setTimeout(() => {
    resetSectorProgressOnDeath();
    evolvePlayer(state.player, state.starterEntry);
    updateViewportForStage();
    state.player.energy = 0;
    state.player.affinity = { Vaccine: 0, Data: 0, Virus: 0 };
    state.player.sprinting = false;
    if (extraReset) extraReset();
    enterPlace("village", { far: true });
    startCutscene("hatch", 10000, { name: digiName(state.starterEntry) }, () => { state.gameTimerMs = 0; });
  }, 3000);
}

function killPlayerAndRespawn(attackerStage) {
  // "Endgame, or later" — the 32-at-once swarm, the core siege, and the 7
  // Tera defenders that join partway through it all count; only the
  // one-by-one "sequential" phase before that is a normal death.
  const inFinaleEndgameOrLater = state.currentPlace === "yggdrasil_finale" && state.finale && state.finale.phase !== "sequential";
  // Dying to any Tera-or-higher attacker ALSO grants the Digimental
  // (if not already used), wherever that happens — e.g. the Crossing
  // Fields' own Guardian, which is dynamically one tier above its Giga
  // ceiling (see computeGuardianStage), making it Tera-level.
  const killedByTeraOrHigher = attackerStage === "tera" || attackerStage === "peta";
  if (inFinaleEndgameOrLater || killedByTeraOrHigher) {
    handleEndgameLoss(inFinaleEndgameOrLater);
    return;
  }
  respawnAsDigiEgg("Your Digimon was destroyed...");
}

// A deliberate pacific kill costs this many times the Score it would have
// earned as a hostile kill — a real penalty, not just "no reward".
const PACIFIC_KILL_SCORE_PENALTY_MULT = 5;

function onEnemyKilled(enemy) {
  gainEnergy(enemy.energyReward);
  const isPacific = enemy.alignment === "pacific";
  if (!isPacific) state.player.score += enemy.scoreReward;
  if (isPacific) {
    state.pacificKills += 1;
    // "Accidental" = this death landed within 5s of any player<->hostile
    // damage exchange — a stray shot during a real fight, not a deliberate
    // act. That's a cheap but reasonable proxy for intent.
    if (currentFrameNow - state.lastAggressiveCombatMs < ACCIDENTAL_PACIFIC_WINDOW_MS) {
      state.accidentalPacificKills += 1;
    } else {
      // No Score reward either way — deliberate killing on top of that
      // costs a real chunk of Score.
      state.player.score = Math.max(0, state.player.score - enemy.scoreReward * PACIFIC_KILL_SCORE_PENALTY_MULT);
    }
  }
  if (enemy.dropsKey) {
    const levelData = getLevelData(state.currentPlace);
    levelData.keyDrops = levelData.keyDrops || [];
    const dropPos = nearestWalkablePoint(levelData, enemy.x, enemy.y);
    levelData.keyDrops.push({ x: dropPos.x, y: dropPos.y, collected: false, color: enemy.dropsKey });
    toast(`${digiName(enemy.entryData)} drops the ${enemy.dropsKey} key!`, 3200);
  }
  const cfgK = getPlaceCfg(state.currentPlace);
  // Cloning City's recurring nemesis: comes back at a random still-
  // powered Machine every time it falls (never isGuardian, so none of
  // the block below ever applies to it) — permanently gone only once no
  // Machine is left to reappear at.
  if (enemy.isCloningRecurringGuardian) {
    const levelData = getLevelData(state.currentPlace);
    spawnCloningRecurringGuardian(levelData);
  }
  if (enemy.isGuardian) {
    state.guardianDefeated[state.currentPlace] = true;
    const levelData = getLevelData(state.currentPlace);
    if (levelData.sectorGate) {
      levelData.sectorGate.active = true;
      levelData.tiles[levelData.sectorGate.y][levelData.sectorGate.x] = TILE.PORTAL;
    }
    toast(`${digiName(enemy.entryData)} the Guardian defeated! The Gate back to the Village has opened.`, 3200);
    // Purely a banner — gameplay keeps running, nothing about state.mode
    // changes, unlike the death/victory freezes.
    showBanner("You Won!", "#2ecc71", 2000);
    // Secret Sectors are optional bonus content — no crystal, and they don't
    // count toward "conquer every Sector" (so finding them is never required).
    // A real drop at the Guardian's own death position (nudged to the
    // nearest walkable tile — see nearestWalkablePoint), not an instant
    // hand-off wherever the player happens to be standing.
    if (!cfgK.secret || cfgK.dropsCrystalEvenIfSecret) {
      const dropPos = nearestWalkablePoint(levelData, enemy.x, enemy.y);
      levelData.crystal = { x: dropPos.x, y: dropPos.y, collected: false };
    }
  }
}

// A white crystal appears where the Guardian fell; collecting it formally
// marks the Sector conquered and recounts the tale of its history.
function updateCrystal(levelData) {
  const c = levelData.crystal;
  if (!c || c.collected) return;
  const p = state.player;
  if (Math.hypot(c.x - p.x, c.y - p.y) < 20 + TILE_SIZE * 0.28) {
    c.collected = true;
    const cfg = getPlaceCfg(state.currentPlace);
    // Secret sectors' trophy crystals (see dropsCrystalEvenIfSecret) are a
    // bonus, not a requirement — never add them to sectorsConquered, which
    // is exactly what both the HUD count and requiredSectorsCount() read.
    // Counting them there was inflating the total past what's actually
    // required (e.g. 22 shown when only 21 Sectors really exist).
    if (!cfg.secret) state.sectorsConquered.add(state.currentPlace);
    toast(`💎 You have conquered ${cfg.name}! ${cfg.lore || ""}`, 10000);
    checkAllSectorsConquered();
  }
}

function drawCrystal(levelData) {
  const c = levelData.crystal;
  if (!c || c.collected) return;
  const sx = c.x - state.camX, sy = c.y - state.camY;
  const pulse = 0.7 + Math.sin(currentFrameNow / 260) * 0.3;
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(sx, sy - 16); ctx.lineTo(sx + 11, sy); ctx.lineTo(sx, sy + 16); ctx.lineTo(sx - 11, sy);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#cfe8ff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

const KEY_DROP_COLORS = { red: "#e23b3b", green: "#3bc45c", blue: "#3b7fe2" };
// Crystal Palace's three door keys — dropped by the Digital Abyss's,
// Chaos Zone's, and the Dark Area's own bosses (see onEnemyKilled).
// Picking one up just flips a flag on the player; it has no other effect
// outside Crystal Palace.
function updateKeyDrops(levelData) {
  if (!levelData.keyDrops || levelData.keyDrops.length === 0) return;
  const p = state.player;
  for (const k of levelData.keyDrops) {
    if (k.collected) continue;
    if (Math.hypot(k.x - p.x, k.y - p.y) < 20 + TILE_SIZE * 0.28) {
      k.collected = true;
      p.keys[k.color] = true;
      toast(`🔑 You obtained the ${k.color} key!`, 3200);
    }
  }
}
function drawKeyDrops(levelData) {
  if (!levelData.keyDrops || levelData.keyDrops.length === 0) return;
  for (const k of levelData.keyDrops) {
    if (k.collected) continue;
    const sx = k.x - state.camX, sy = k.y - state.camY;
    const pulse = 0.7 + Math.sin(currentFrameNow / 260) * 0.3;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = KEY_DROP_COLORS[k.color] || "#fff";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(-6, -8, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-1, -4); ctx.lineTo(10, 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, 4); ctx.lineTo(4, 9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 8); ctx.lineTo(8, 13); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// Homeostasis's iridescent block, in the Village. Walking near it the first
// time triggers the intro Deep Explanation.
function checkHomeostasisBlock(levelData) {
  if (state.seenIntroDE || state.currentPlace !== "village" || !levelData.homeostasisBlock) return;
  const b = levelData.homeostasisBlock;
  const bx = b.x * TILE_SIZE + TILE_SIZE / 2, by = b.y * TILE_SIZE + TILE_SIZE / 2;
  if (Math.hypot(state.player.x - bx, state.player.y - by) < TILE_SIZE * 1.6) {
    state.seenIntroDE = true;
    startDeepExplanation(HOMEOSTASIS_INTRO_MESSAGES, () => {});
  }
}

function drawHomeostasisBlock(levelData) {
  const b = levelData.homeostasisBlock;
  if (!b) return;
  const sx = b.x * TILE_SIZE + TILE_SIZE / 2 - state.camX, sy = b.y * TILE_SIZE + TILE_SIZE / 2 - state.camY;
  const t = currentFrameNow / 1000;
  ctx.save();
  for (let ring = 2; ring >= 0; ring--) {
    const hue = (t * 70 + ring * 90) % 360;
    ctx.strokeStyle = `hsl(${hue}, 100%, 70%)`;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(sx, sy, TILE_SIZE * (0.28 + ring * 0.09), t * (1 + ring * 0.3), t * (1 + ring * 0.3) + Math.PI * 1.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.9 + Math.sin(t * 2) * 0.1;
  const grad = ctx.createRadialGradient(sx, sy, 1, sx, sy, TILE_SIZE * 0.3);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.6, "#e8e6ff");
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(sx - TILE_SIZE * 0.3, sy - TILE_SIZE * 0.3, TILE_SIZE * 0.6, TILE_SIZE * 0.6);
  ctx.restore();
}

// Once every Sector's crystal (including the secret ones) is collected, a
// Gate to the True Yggdrasil finale opens in the Village.
// Secret Sectors don't have crystals, so they're never required — only the
// visible (non-secret) Sectors count toward "conquer them all".
function requiredSectorsCount() {
  return ALL_SECTORS.filter((s) => !s.secret && !s.retired).length;
}

function checkAllSectorsConquered() {
  if (state.sectorsConquered.size < requiredSectorsCount()) return;
  if (state.finaleGateRevealed) return;
  state.finaleGateRevealed = true;
  const vd = getLevelData("village");
  const spot = findWalkableNear(vd, vd.spawn.x * TILE_SIZE + TILE_SIZE / 2, vd.spawn.y * TILE_SIZE + TILE_SIZE / 2, 3);
  const tx = Math.floor(spot.x / TILE_SIZE), ty = Math.floor(spot.y / TILE_SIZE);
  vd.tiles[ty][tx] = TILE.PORTAL;
  vd.portals.push({ x: tx, y: ty, targetSectorId: "yggdrasil_finale", label: "To the True Yggdrasil", secret: false });
  toast("⚡ All Sectors conquered! A Gate to the True Yggdrasil has opened in the Village!", 5500);
}

// ---------------------------------------------------------------------------
// The True Yggdrasil finale: a small arena (not a normal biome Sector) with
// a central 7x7 white core block, ringed by 32 Giga Digimon fought one at a
// time. Clearing all 32 opens the core; approaching it wins the game.
// ---------------------------------------------------------------------------
const FINALE_SIZE = 34;
const FINALE_GUARDIAN_COUNT = 32;

function buildFinaleLevelData() {
  const size = FINALE_SIZE;
  const tiles = Array.from({ length: size }, () => Array.from({ length: size }, () => TILE.GRASS));
  const cx = Math.floor(size / 2), cy = Math.floor(size / 2);
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) tiles[cy + dy][cx + dx] = TILE.SEA; // the 7x7 core, solid until opened
  for (let i = 0; i < size; i++) { tiles[0][i] = TILE.SEA; tiles[size - 1][i] = TILE.SEA; tiles[i][0] = TILE.SEA; tiles[i][size - 1] = TILE.SEA; }

  const spawn = { x: cx, y: cy + 14 };
  tiles[spawn.y + 1][spawn.x] = TILE.PORTAL; // a retreat Gate near the entrance, back to the Village — below the player, not above (the core is north of spawn)

  const allWalkable = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (tiles[y][x] !== TILE.SEA) allWalkable.push({ x, y });

  return {
    size, tiles, rockHP: new Map(), spawn,
    enemySpawns: [], itemSpawns: [],
    portals: [{ x: spawn.x, y: spawn.y + 1, targetSectorId: "village", label: "To the Village", secret: false }],
    concealedGates: new Map(), sectorGate: null,
    decorations: [], decorByKey: new Map(), grassShade: [],
    allWalkable,
    coreCenter: { x: cx * TILE_SIZE + TILE_SIZE / 2, y: cy * TILE_SIZE + TILE_SIZE / 2 },
    digitCell: makeDigitCell(),
  };
}

// Generic tessellated 0s/1s: 10 big digits whose "real" position lives
// inside one ideal, periodic 2x2-tile cell (wrapping at its edges) — that
// same cell is tessellated across the whole visible world at draw time
// (see updateDigitCell/drawDigitCell), same technique as Coral Reef's fish.
// Used by any place that opts in (`placeCfg.digitField` for a normal
// Sector via map.js, or called directly here for the void dimension and
// the True Yggdrasil finale, which build their levelData by hand).
function makeDigitCell() {
  const cell = 2 * TILE_SIZE;
  const items = [];
  for (let i = 0; i < 10; i++) {
    items.push({
      x: Math.random() * cell, y: Math.random() * cell,
      vx: (Math.random() * 2 - 1) * (10 + Math.random() * 10),
      vy: (Math.random() * 2 - 1) * (10 + Math.random() * 10),
      ch: Math.random() < 0.5 ? "0" : "1",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// The void dimension: what the Village's "To the Dark Area" gate actually
// leads to now (see the gateTarget swap in config.js). Deep dark black,
// toroidal (tileAt/moveWithCollision wrap seamlessly — see `wrap` on this
// levelData and the `frictionless` flag on its stub cfg), almost entirely
// empty but for a rare wall or colored patch, and 10 Giga Digimon drifting
// in from the dark.
// ---------------------------------------------------------------------------
const VOID_SIZE = 40;

function buildVoidLevelData() {
  const size = VOID_SIZE;
  const tiles = Array.from({ length: size }, () => Array.from({ length: size }, () => TILE.VOID));
  const rockHP = new Map();
  // "just one not-black tile for every 50 of space" — a sparse scatter of
  // random walls and a few green/red patches.
  const totalNonBlack = Math.round((size * size) / 50);
  for (let i = 0; i < totalNonBlack; i++) {
    const x = Math.floor(Math.random() * size), y = Math.floor(Math.random() * size);
    const roll = Math.random();
    if (roll < 0.4) {
      tiles[y][x] = TILE.ROCK;
      rockHP.set(`${x},${y}`, ROCK_MAX_HP);
    } else if (roll < 0.7) {
      tiles[y][x] = TILE.GRASS;
    } else {
      tiles[y][x] = TILE.FIRE;
    }
  }
  const spawn = { x: Math.floor(size / 2), y: Math.floor(size / 2) };
  tiles[spawn.y][spawn.x] = TILE.VOID;
  const allWalkable = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (tiles[y][x] !== TILE.ROCK) allWalkable.push({ x, y });

  // Floating 0s and 1s — the OLD per-place scatter-and-wrap approach.
  // Deactivated in favor of the new tessellated 2x2-cell technique (see
  // makeDigitCell/updateDigitCell/drawDigitCell) — kept here, generated but
  // unused, rather than deleted.
  const digits = [];
  for (let i = 0; i < 70; i++) {
    const angle = Math.random() * Math.PI * 2;
    digits.push({
      x: Math.random() * size * TILE_SIZE,
      y: Math.random() * size * TILE_SIZE,
      vx: Math.cos(angle) * (6 + Math.random() * 14),
      vy: Math.sin(angle) * (6 + Math.random() * 14),
      ch: Math.random() < 0.5 ? "0" : "1",
    });
  }

  return {
    size, tiles, rockHP, spawn,
    enemySpawns: [], itemSpawns: [],
    portals: [{ x: spawn.x, y: (spawn.y - 2 + size) % size, targetSectorId: "village", label: "Abandon all hope, ye who enter here", secret: false }],
    concealedGates: new Map(), sectorGate: null,
    decorations: [], decorByKey: new Map(), grassShade: [],
    allWalkable,
    wallMaterial: new Map(), guardianCubeCenter: null,
    burningTiles: new Map(), safeGround: new Set(),
    wrap: true,
    digits,
    digitCell: makeDigitCell(),
  };
}

function enterVoidDimension() {
  state.currentPlace = "void_dimension";
  const ld = getLevelData("void_dimension");
  const cfg = getPlaceCfg("void_dimension");
  state.player.x = ld.spawn.x * TILE_SIZE + TILE_SIZE / 2;
  state.player.y = ld.spawn.y * TILE_SIZE + TILE_SIZE / 2;
  state.player._vx = 0; state.player._vy = 0;
  state.enemies = [];
  // Once the real boss has actually fallen (isGuardian, see
  // checkVoidBossTrigger), this whole re-population is skipped on every
  // later visit — without this, re-entering reset voidBossSpawned back to
  // false unconditionally every time, letting the 8-Giga gauntlet and the
  // boss (and its blue key) be refarmed infinitely without ever dying.
  if (state.guardianDefeated["void_dimension"]) {
    ld.voidBossSpawned = true;
    state.items = []; state.projectiles = [];
    const tx0 = Math.floor(state.player.x / TILE_SIZE), ty0 = Math.floor(state.player.y / TILE_SIZE);
    state.lastPlayerTileKey = `${tx0},${ty0}`;
    updateHUDPlaceLabel();
    toast("Utter blackness — empty and still. Whatever lurked here is already gone.", 3600);
    return;
  }
  ld.voidBossSpawned = false;
  // 8 ordinary Giga Digimon first — none of them carry the key. Only
  // once every one of these 8 is dead does the real boss show up (see
  // checkVoidBossTrigger), and only that boss drops Crystal Palace's
  // blue key.
  for (let i = 0; i < 8; i++) {
    const entry = DG_DATA.pickRandomByStage("giga");
    if (!entry) continue;
    const angle = (i / 8) * Math.PI * 2;
    const dist = 9 * TILE_SIZE;
    const ex = state.player.x + Math.cos(angle) * dist, ey = state.player.y + Math.sin(angle) * dist;
    const enemy = createEnemy(entry, "hostile", false, ex, ey, cfg, FAKE_FINALE_CFG);
    enemy.moveSpeedMult = 0.15; // "start with nonzero low speed"
    state.enemies.push(enemy);
  }
  state.items = []; state.projectiles = [];
  const tx = Math.floor(state.player.x / TILE_SIZE), ty = Math.floor(state.player.y / TILE_SIZE);
  state.lastPlayerTileKey = `${tx},${ty}`;
  updateHUDPlaceLabel();
  toast("Utter blackness swallows you whole. Something is drifting closer...", 3600);
}

// Once all 8 of the Dark Area's ordinary Giga Digimon are dead, a real
// boss drifts in — stronger, like a Guardian elsewhere — and it alone
// carries Crystal Palace's blue key.
function checkVoidBossTrigger() {
  if (state.currentPlace !== "void_dimension") return;
  const ld = getLevelData("void_dimension");
  if (ld.voidBossSpawned) return;
  if (state.enemies.some((e) => !e.dead && !e.isGuardian)) return;
  ld.voidBossSpawned = true;
  const cfg = getPlaceCfg("void_dimension");
  const entry = DG_DATA.pickRandomByStage("giga");
  if (!entry) return;
  const boss = createEnemy(entry, "guardian", true, state.player.x, state.player.y - 4 * TILE_SIZE, cfg, FAKE_FINALE_CFG);
  boss.maxHp = Math.round(boss.maxHp * 1.4); // "a level stronger", same bump every other Sector's Guardian gets
  boss.hp = boss.maxHp;
  boss.dmgMult *= 1.25;
  boss.dropsKey = "blue";
  boss.moveSpeedMult = 0.3;
  state.enemies.push(boss);
  toast("Something far stronger emerges from the dark...", 3600);
}

// Change VOID_OVERSPEED_TILES_PER_SEC below to adjust the Dark Area's
// speed-out threshold.
const VOID_OVERSPEED_TILES_PER_SEC = 100;
let voidOverspeedTimer = 0;
// If the player's frictionless drift in the Dark Area ever exceeds
// VOID_OVERSPEED_TILES_PER_SEC, the field spends 5 seconds turning whiter
// and whiter (see the overlay in render()) and then gently ejects them
// back to the Village — no death, just cast out for moving too fast for
// the place to hold onto them.
function checkVoidOverspeed(dt) {
  if (state.currentPlace !== "void_dimension") { voidOverspeedTimer = 0; return; }
  const p = state.player;
  const speedTiles = Math.hypot(p._vx || 0, p._vy || 0) / TILE_SIZE;
  if (speedTiles <= VOID_OVERSPEED_TILES_PER_SEC && voidOverspeedTimer <= 0) return;
  voidOverspeedTimer += dt;
  if (voidOverspeedTimer >= 5) {
    voidOverspeedTimer = 0;
    p._vx = 0; p._vy = 0;
    enterPlace("village", {});
    toast("The Dark Area casts you out — you were moving too fast for it to hold you.", 3200);
  }
}

function buildFinaleRing() {
  const pool = DG_DATA.byStage.giga.length ? DG_DATA.byStage.giga : DG_DATA.byStage.mega;
  const ld = getLevelData("yggdrasil_finale");
  const ringRadiusPx = 10 * TILE_SIZE;
  const ring = [];
  for (let i = 0; i < FINALE_GUARDIAN_COUNT; i++) {
    const entry = pool[Math.floor(Math.random() * pool.length)];
    const angle = (i / FINALE_GUARDIAN_COUNT) * Math.PI * 2;
    ring.push({
      entry,
      x: ld.coreCenter.x + Math.cos(angle) * ringRadiusPx,
      y: ld.coreCenter.y + Math.sin(angle) * ringRadiusPx,
      defeated: false,
      icon: getIcon(entry.iconPath),
    });
  }
  return ring;
}

const FAKE_FINALE_CFG = { hpMult: 1, dmgMult: 1, guardianHpMult: 1 };
const CORE_BLOCK_HP = 30000; // "very very high" — a real siege, not a couple of fireballs
// Yggdrasil's last line of defense once its core is exposed. There's no
// real Daemon (or any Tera-stage Digimon at all) in the scraped dataset, so
// the strongest, most fittingly evil Giga stands in instead.
const YGGDRASIL_DEFENDER_NAME = "Beelzebumon (X-Antibody)";

function enterFinale() {
  state.currentPlace = "yggdrasil_finale";
  const ld = getLevelData("yggdrasil_finale");
  state.player.x = ld.spawn.x * TILE_SIZE + TILE_SIZE / 2;
  state.player.y = ld.spawn.y * TILE_SIZE + TILE_SIZE / 2;
  state.enemies = []; state.items = []; state.projectiles = [];
  const tx = Math.floor(state.player.x / TILE_SIZE), ty = Math.floor(state.player.y / TILE_SIZE);
  state.lastPlayerTileKey = `${tx},${ty}`;
  updateHUDPlaceLabel();
  if (ld.fullyCorroded) {
    // Already fully destroyed on a previous visit through the Gate (dying
    // instead would have reset all Sector progress, including this) —
    // stays destroyed, nothing left to fight, exactly as left.
    state.finale = { ring: [], activeIdx: FINALE_GUARDIAN_COUNT, activeEnemy: null, coreOpen: true, phase: "corroding", swarmSpawned: true, teraSwarmSpawned: true };
    toast("Yggdrasil's core lies destroyed, exactly as you left it.", 4000);
    return;
  }
  state.finale = { ring: buildFinaleRing(), activeIdx: -1, activeEnemy: null, coreOpen: false, phase: "sequential", swarmSpawned: false, teraSwarmSpawned: false };
  toast("You step into the True Yggdrasil. 32 Giga Digimon stand between you and the core.", 4000);
  activateNextFinaleGuardian();
}

function activateNextFinaleGuardian() {
  const f = state.finale;
  if (!f) return;
  f.activeIdx += 1;
  if (f.activeIdx >= f.ring.length) {
    startEndgamePhase();
    return;
  }
  const slot = f.ring[f.activeIdx];
  const enemy = createEnemy(slot.entry, "hostile", false, slot.x, slot.y, FAKE_FINALE_CFG, FAKE_FINALE_CFG);
  enemy.guardedByPlayerOnly = true; // the 32 Guardians of Yggdrasil are also player-only targets
  state.enemies = [enemy];
  f.activeEnemy = enemy;
  toast(`Guardian ${f.activeIdx + 1}/${f.ring.length}: ${digiName(enemy.entryData)} attacks!`, 2400);
}

// Once all 32 have fallen one-by-one, they rise together for the Endgame —
// a full-swarm fight, all 32 at once.
function startEndgamePhase() {
  const f = state.finale;
  f.phase = "endgame";
  toast("⚠ THE ENDGAME BEGINS — all 32 Guardians rise together!", 4200);
  spawnEndgameSwarm();
}

function spawnEndgameSwarm() {
  const f = state.finale;
  state.enemies = f.ring.map((slot) => {
    const e = createEnemy(slot.entry, "hostile", false, slot.x, slot.y, FAKE_FINALE_CFG, FAKE_FINALE_CFG);
    e.guardedByPlayerOnly = true;
    return e;
  });
  state.projectiles = [];
  f.activeEnemy = null;
  f.swarmSpawned = true;
}

// Clearing the Endgame exposes the core: the 7x7 white block becomes 49
// individually-destructible (very high HP) blocks, reusing the normal rock
// damage/greying pipeline. Corroding every last one is the true victory.
function startCorrodingPhase() {
  const f = state.finale;
  f.phase = "corroding";
  f.coreOpen = true;
  const ld = getLevelData("yggdrasil_finale");
  const cx = Math.floor(FINALE_SIZE / 2), cy = Math.floor(FINALE_SIZE / 2);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = cx + dx, y = cy + dy;
      ld.tiles[y][x] = TILE.ROCK;
      ld.rockHP.set(`${x},${y}`, CORE_BLOCK_HP);
    }
  }

  // Yggdrasil isn't defenseless: the moment its core is exposed, it
  // manifests a powerful defender to protect it while you corrode the core.
  const defenderEntry = DG_DATA.getEntry(YGGDRASIL_DEFENDER_NAME) || DG_DATA.pickRandomByStage("giga");
  if (defenderEntry) {
    const defender = createEnemy(defenderEntry, "hostile", false, ld.coreCenter.x + TILE_SIZE * 4.5, ld.coreCenter.y, FAKE_FINALE_CFG, FAKE_FINALE_CFG);
    defender.guardedByPlayerOnly = true;
    state.enemies.push(defender);
    toast(`The Endgame is won! Yggdrasil's core is exposed — but ${digiName(defender.entryData)} rises to protect it!`, 5500);
  } else {
    toast("The Endgame is won! Yggdrasil's core is exposed — bombard it to corrode it completely!", 5500);
  }
}

function isYggdrasilFullyCorroded(ld) {
  const cx = Math.floor(FINALE_SIZE / 2), cy = Math.floor(FINALE_SIZE / 2);
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++)
      if (ld.tiles[cy + dy][cx + dx] === TILE.ROCK) return false;
  return true;
}

// True the moment ANY of the core's 49 blocks has taken its first hit
// (damaged or fully destroyed-away) — used to trigger the Tera-level
// defenders exactly once, right after real damage starts landing.
function finaleCoreHasTakenDamage(ld) {
  const cx = Math.floor(FINALE_SIZE / 2), cy = Math.floor(FINALE_SIZE / 2);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const hp = ld.rockHP.get(`${cx + dx},${cy + dy}`);
      if (hp === undefined || hp < CORE_BLOCK_HP) return true;
    }
  }
  return false;
}

// After the first real hit lands on the exposed core, 7 Tera-level
// Digimon rise to defend it — excluding the player's own species if the
// player is already Tera, otherwise excluding one random species from
// the pool instead, same idea either way. Falls back to Giga (allowing
// repeats) if the data doesn't have at least a few real Tera entries yet —
// same convention as buildFinaleRing/showDigimentalChoice.
function spawnFinaleTeraSwarm() {
  const f = state.finale;
  f.teraSwarmSpawned = true;
  const teraPool = DG_DATA.byStage.tera;
  const pool = teraPool.length ? teraPool : DG_DATA.byStage.giga;
  if (!pool.length) return;
  let excludeName = null;
  if (teraPool.length && state.player.stage === "tera") {
    excludeName = state.player.name;
  } else if (pool.length > 1) {
    excludeName = pool[Math.floor(Math.random() * pool.length)].name;
  }
  const candidates = pool.filter((e) => e.name !== excludeName);
  const finalPool = candidates.length ? candidates : pool;
  const ld = getLevelData("yggdrasil_finale");
  for (let i = 0; i < 7; i++) {
    const entry = finalPool[Math.floor(Math.random() * finalPool.length)];
    const angle = (i / 7) * Math.PI * 2;
    const dist = 6 * TILE_SIZE;
    const ex = ld.coreCenter.x + Math.cos(angle) * dist, ey = ld.coreCenter.y + Math.sin(angle) * dist;
    const enemy = createEnemy(entry, "hostile", false, ex, ey, FAKE_FINALE_CFG, FAKE_FINALE_CFG);
    enemy.guardedByPlayerOnly = true;
    // "Yggdrasil Guardians" — stronger lives than an ordinary Tera (5x
    // HP, damage untouched), never give up the chase regardless of
    // distance (see decideEnemyAction), and follow the player through
    // any Gate instead of being left behind (see enterPlace).
    enemy.maxHp = Math.round(enemy.maxHp * 5);
    enemy.hp = enemy.maxHp;
    enemy.alwaysPursue = true;
    enemy.isYggdrasilTeraGuardian = true;
    state.enemies.push(enemy);
  }
  toast("⚠ Yggdrasil's last defenders rise — 7 Tera-level Digimon attack!", 4200);
}

function updateFinale() {
  const f = state.finale;
  if (!f || state.currentPlace !== "yggdrasil_finale") return;
  if (f.phase === "sequential") {
    if (f.activeEnemy && f.activeEnemy.dead) {
      f.ring[f.activeIdx].defeated = true;
      f.activeEnemy = null;
      activateNextFinaleGuardian();
    }
  } else if (f.phase === "endgame") {
    // updateEnemies() already filters out dead enemies before this runs, so
    // by the time the swarm is actually cleared the array is just empty —
    // checking .every(dead) on it would trivially pass even before the
    // swarm ever spawned, so gate it on the swarm having spawned first.
    if (f.swarmSpawned && state.enemies.length === 0) startCorrodingPhase();
  } else if (f.phase === "corroding") {
    const ld = getLevelData("yggdrasil_finale");
    if (!f.teraSwarmSpawned && finaleCoreHasTakenDamage(ld)) spawnFinaleTeraSwarm();
    if (isYggdrasilFullyCorroded(ld)) {
      ld.fullyCorroded = true; // persists across a normal Gate re-entry — see enterFinale
      triggerVictory();
    }
  }
}

// Shared by the True Yggdrasil's own ending AND the All Delete alternate
// ending (see tryTriggerAllDelete) — same banner either way, just
// different flavor-text toast underneath it.
function triggerVictory(toastMsg = "You have corroded Yggdrasil's core and saved the Digital World!") {
  if (state.mode === "victory") return;
  state.mode = "victory";
  showBanner("You Saved the Digital World!", "#2ecc71", 5000);
  toast(toastMsg, 5000);
  setTimeout(() => {
    state.finale = null;
    enterPlace("village", { far: true });
    state.mode = "playing";
  }, 5000);
}

// Losing the Endgame swarm fight isn't the normal death: the first time,
// you're granted the Digimental (a one-time reward) and sent back in for
// another attempt; every time after that, it's a normal death.
function handleEndgameLoss(isFinaleDeath) {
  state.mode = "respawning";
  if (!state.digimentalUsed) {
    state.banner = null; // this path isn't a real death — no "You Died!" banner
    toast("You have fallen...", 1500);
    setTimeout(() => {
      state.player.hp = state.player.maxHp;
      startDeepExplanation(HOMEOSTASIS_FAREWELL_MESSAGES, () => {
        startCutscene("digimental", 10000, {}, () => showDigimentalChoice(isFinaleDeath));
      });
    }, 1500);
  } else {
    respawnAsDigiEgg(
      "Your Digimon was destroyed... a long time passes before your DigiEgg hatches back in the Village.",
      () => { state.finale = null; }
    );
  }
}

// Presents a choice of the strongest-available-tier Digimon (Tera if the
// scraped data has any; it currently doesn't, so this falls back to Giga —
// still "the strongest available tier", just not literally Tera).
function showDigimentalChoice(isFinaleDeath) {
  const pool = DG_DATA.byStage.tera.length ? DG_DATA.byStage.tera : DG_DATA.byStage.giga;
  const choices = [];
  const used = new Set();
  let attempts = 0;
  while (choices.length < 10 && choices.length < pool.length && attempts < 200) {
    attempts++;
    const e = pool[Math.floor(Math.random() * pool.length)];
    if (used.has(e.name)) continue;
    used.add(e.name);
    choices.push(e);
  }
  const overlay = document.getElementById("charSelectOverlay");
  const grid = document.getElementById("starterGrid");
  document.getElementById("playArea").style.display = "none";
  overlay.style.display = "block";
  overlay.querySelector("h1").textContent = "The Digimental Awakens";
  overlay.querySelector("p").textContent = "Choose your evolution — you won't get this chance again:";
  grid.innerHTML = "";
  for (const entry of choices) {
    const btn = document.createElement("button");
    btn.className = "starterBtn";
    btn.innerHTML = `<img src="${entry.iconPath}"><div>${digiName(entry)}</div>`;
    btn.addEventListener("click", () => {
      evolvePlayer(state.player, entry);
      updateViewportForStage();
      state.player.hp = state.player.maxHp;
      state.digimentalUsed = true;
      overlay.style.display = "none";
      document.getElementById("playArea").style.display = "flex";
      if (isFinaleDeath) {
        // Whichever phase death actually happened in (the swarm itself,
        // the core siege, or the Tera defenders) always resumes at the
        // top of the Endgame swarm — updateFinale's dispatch is keyed on
        // f.phase, so this has to match what's actually back in
        // state.enemies, or clearing the swarm would silently do nothing.
        const f = state.finale;
        f.phase = "endgame";
        f.coreOpen = false;
        f.teraSwarmSpawned = false;
        spawnEndgameSwarm();
        const ld = getLevelData("yggdrasil_finale");
        state.player.x = ld.spawn.x * TILE_SIZE + TILE_SIZE / 2;
        state.player.y = ld.spawn.y * TILE_SIZE + TILE_SIZE / 2;
        toast(`The Digimental grants you ${digiName(entry)}! Back to the Endgame.`, 3200);
      } else {
        // Died to a Tera-or-higher attacker somewhere other than the
        // finale (e.g. the Crossing Fields' own Guardian) — stay right
        // where that happened, just newly powerful and fully healed.
        toast(`The Digimental grants you ${digiName(entry)}!`, 3200);
      }
      state.mode = "playing";
    });
    grid.appendChild(btn);
  }
}

let finaleParticles = null;
function ensureFinaleParticles() {
  if (finaleParticles) return;
  finaleParticles = [];
  for (let i = 0; i < 70; i++) {
    const vertical = i % 2 === 0;
    finaleParticles.push({
      x: Math.random() * 1200, y: Math.random() * 1200,
      vx: vertical ? 0 : (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 60),
      vy: vertical ? (40 + Math.random() * 60) * (Math.random() < 0.5 ? -1 : 1) : 0,
      char: Math.random() < 0.5 ? "0" : "1",
      size: 12 + Math.random() * 10,
    });
  }
}

function renderFinale(levelData) {
  ensureFinaleParticles();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#bfe8ff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Old free-floating screen-space particles (finaleParticles) are
  // deactivated in favor of the generic tessellated 2x2-cell digit field
  // below (see DIGIT_FIELD_STYLE) — still generated by ensureFinaleParticles
  // above, just no longer drawn.
  const digitStyle = DIGIT_FIELD_STYLE.yggdrasil_finale;
  if (digitStyle) drawDigitCell(levelData, digitStyle.color, digitStyle.size);

  // the retreat Gate, drawn like any other psychedelic Gate
  for (const portal of levelData.portals) {
    const sx = portal.x * TILE_SIZE - state.camX, sy = portal.y * TILE_SIZE - state.camY;
    drawGate(sx, sy, true);
  }

  const core = levelData.coreCenter;
  const coreScreenX = core.x - state.camX, coreScreenY = core.y - state.camY;
  const blockPx = TILE_SIZE * 7;
  const startX = coreScreenX - blockPx / 2, startY = coreScreenY - blockPx / 2;
  const f = state.finale;
  const cCol = Math.floor(FINALE_SIZE / 2) - 3, cRow = Math.floor(FINALE_SIZE / 2) - 3;
  for (let by = 0; by < 7; by++) {
    for (let bx = 0; bx < 7; bx++) {
      const sx = startX + bx * TILE_SIZE, sy = startY + by * TILE_SIZE;
      if (f?.phase === "corroding") {
        const key = `${cCol + bx},${cRow + by}`;
        const hp = levelData.rockHP.get(key);
        if (hp === undefined) continue; // corroded away — a gap showing the background through
        const dmgFrac = 1 - hp / CORE_BLOCK_HP;
        // fades from white toward grey as it corrodes, per "they become grey"
        const shade = Math.round(255 - dmgFrac * 170);
        ctx.fillStyle = `rgb(${shade},${shade},${shade + 5})`;
        ctx.fillRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
        ctx.strokeStyle = "#7a7a80";
        ctx.strokeRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
        ctx.strokeStyle = "#b9c3cc";
        ctx.strokeRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
      }
    }
  }
  // The barrier is up for as long as there's anything left to protect —
  // yellow while the core is still sealed (sequential/endgame: attacks
  // can't touch it at all yet), light grey once it's actually exposed and
  // damageable (corroding) — so its color always tells you the real
  // state, not just a fixed decoration.
  if (f && !levelData.fullyCorroded) {
    const pulse = 0.5 + Math.sin(currentFrameNow / 200) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.5 * pulse;
    ctx.strokeStyle = f.phase === "corroding" ? "#c9c9c9" : "#ffd166";
    ctx.lineWidth = 6;
    ctx.strokeRect(startX - 6, startY - 6, blockPx + 12, blockPx + 12);
    ctx.restore();
  }

  if (f) {
    for (let i = 0; i < f.ring.length; i++) {
      if (i === f.activeIdx) continue; // drawn as a real combat entity below
      const slot = f.ring[i];
      const sx = slot.x - state.camX, sy = slot.y - state.camY;
      const r = TILE_SIZE * 0.32;
      ctx.save();
      ctx.globalAlpha = slot.defeated ? 0.25 : 0.85;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.clip();
      if (slot.icon.complete && slot.icon.naturalWidth > 0) ctx.drawImage(slot.icon, sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    }
  }

  for (const enemy of state.enemies) {
    if (enemy.stage === "tera" || enemy.stage === "peta") drawPsychedelicAura(enemy.x, enemy.y);
    drawEntityIcon(enemy, enemyContourColor(enemy));
  }
  if (state.player.stage === "tera" || state.player.stage === "peta") drawPsychedelicAura(state.player.x, state.player.y);
  drawEntityIcon(state.player, "#4aa8ff");
  for (const proj of state.projectiles) drawProjectile(proj);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const FIRE_KEYS = { KeyW: { dx: 0, dy: -1 }, KeyS: { dx: 0, dy: 1 }, KeyA: { dx: -1, dy: 0 }, KeyD: { dx: 1, dy: 0 } };
function isSunStage(stage) { return stage === "mega" || stage === "giga" || stage === "tera" || stage === "peta"; }

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyP" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleSettings(); return; }
  // Ctrl+A: Tera's All Delete, only once Digicharge is at its 60,000 cap
  // (see gainEnergy/tryTriggerAllDelete) — gated behind ctrlKey so plain
  // "A" still fires left as normal (see FIRE_KEYS below).
  if (e.code === "KeyA" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); tryTriggerAllDelete(); return; }
  if (e.code === "Escape" && state.mode === "megaPicker") { closeMegaPicker(); return; }
  if (e.code === "Space" && state.mode === "deepExplanation") { advanceDEPhase(); return; }
  if (e.code === "KeyQ" && state.mode === "deepExplanation") { skipDeepExplanation(); return; }
  // Y: quick-travel straight to the True Yggdrasil finale — but only once
  // every non-secret Sector's crystal has been collected, same requirement
  // as the Village Gate. No need to go hunting for the secret Sectors.
  if (e.code === "KeyY") {
    if (state.player && state.mode === "playing" && state.currentPlace !== "yggdrasil_finale") {
      if (state.sectorsConquered.size >= requiredSectorsCount()) enterFinale();
      else toast(`You must conquer all ${requiredSectorsCount()} Sectors first (${state.sectorsConquered.size}/${requiredSectorsCount()} so far).`, 2600);
    }
    return;
  }
  // M (debug): open a picker to instantly evolve to any Mega-stage Digimon,
  // skipping the energy grind and the 10s cutscene. Gated behind having
  // reached Mega at least once this life-cycle — that flag survives death
  // and rebirth as a digiegg (see state.everReachedMega), so once unlocked
  // it stays unlocked, but a fresh save can't just skip straight to Mega.
  if (e.code === "KeyM") {
    if (state.mode === "playing") {
      // Without this, the browser's default action for this very keydown
      // (typing "m") lands in the picker's own search box an instant
      // later, since openMegaPicker() focuses it synchronously — the
      // delay below means that focus-shift doesn't even happen until
      // long after this event has finished, but preventDefault() alone
      // already stops the stray "m" regardless of timing.
      e.preventDefault();
      if (DG_DATA.stageIndex(state.player.stage) >= DG_DATA.stageIndex("mega")) {
        toast("Already at mega level or higher: mega evolution not available", 2600);
      } else if (!state.everReachedMega && !state.debugMode) {
        toast("Only if one already reached the Mega Level at least once.", 2600);
      } else if (!state.megaPickerPending) {
        state.megaPickerPending = true;
        setTimeout(() => {
          state.megaPickerPending = false;
          if (state.mode === "playing") openMegaPicker();
        }, 700);
      }
    }
    return;
  }
  // B (debug): activate Debug Mode — only works if debug_mode.py is present
  // (never committed to the public repo — see .gitignore), so friends who
  // clone the project just get "Debug Mode not possible", no error.
  if (e.code === "KeyB") {
    if (state.mode === "playing") tryActivateDebugMode();
    return;
  }
  // C (debug, only once B has been activated): instantly obtain every
  // crystal, opening every Sector Gate and the Yggdrasil Gate.
  if (e.code === "KeyC") {
    if (state.debugMode && state.mode === "playing") debugObtainAllCrystals();
    return;
  }
  state.keys.add(e.code);
  if (state.mode !== "playing") return;
  const p = state.player;

  if (e.code === "Space") { if (p.energy > 0) p.sprinting = true; return; }

  if (FIRE_KEYS[e.code]) {
    const dir = FIRE_KEYS[e.code];
    if (isSunStage(p.stage)) {
      if (!p.charging) p.charging = { dx: dir.dx, dy: dir.dy, startTime: currentFrameNow };
    } else if (p.fireCooldownLeft <= 0) {
      firePlayerProjectile(dir.dx, dir.dy);
    }
  }
});

window.addEventListener("keyup", (e) => {
  state.keys.delete(e.code);
  if (state.mode !== "playing") return;
  const p = state.player;
  if (e.code === "Space") { p.sprinting = false; return; }
  if (FIRE_KEYS[e.code] && isSunStage(p.stage) && p.charging && p.charging.dx === FIRE_KEYS[e.code].dx && p.charging.dy === FIRE_KEYS[e.code].dy) {
    releaseMegaCharge();
  }
});

function firePlayerProjectile(dx, dy) {
  const p = state.player;
  const proj = createProjectile(p, dx, dy);
  state.projectiles.push(proj);
  p.fireCooldownLeft = STAGE_STATS[p.stage].fireCooldown;
  applyRecoil(p, dx, dy, proj.dmg, proj.chargeFrac);
}

// Mega I is capped to a small sphere, Mega II/III to a bigger (but still
// capped) one; Giga/Tera can charge arbitrarily big (their own high cap).
function maxSphereRadiusFor(player) {
  const stats = STAGE_STATS[player.stage];
  if (player.stage === "mega") return MEGA_TIER.maxSphereRadius[player.megaTier] || stats.maxRadius;
  return stats.maxRadius;
}

function releaseMegaCharge() {
  const p = state.player;
  if (!p.charging) return;
  const stats = STAGE_STATS[p.stage];
  const frac = p.megaChargeFrac;
  const maxR = maxSphereRadiusFor(p);
  const radius = stats.minRadius + (maxR - stats.minRadius) * frac;
  const proj = createProjectile(p, p.charging.dx, p.charging.dy, {
    radius, chargeFrac: frac, speed: stats.projSpeed,
  });
  state.projectiles.push(proj);
  // Recoil only kicks in on release, not while charging — a held charge
  // shouldn't push you around, only the moment you actually let it go.
  applyRecoil(p, p.charging.dx, p.charging.dy, proj.dmg, proj.chargeFrac);
  p.charging = null;
  p.megaChargeFrac = 0;
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
const settingsPanel = document.getElementById("settings");
// Ctrl+P pauses the game (mode 'paused' is just another non-'playing' mode, so
// the main loop's existing "render the frozen frame, run no updates" branch
// handles it for free — same as cutscenes). Only togglable from normal play
// or from an existing pause; ignored during cutscenes/transitions, which
// are already frozen on their own terms.
function toggleSettings() {
  if (state.mode !== "playing" && state.mode !== "paused") return;
  state.settingsOpen = !state.settingsOpen;
  settingsPanel.classList.toggle("open", state.settingsOpen);
  state.mode = state.settingsOpen ? "paused" : "playing";
  if (state.settingsOpen) renderSettingsPanel();
  // Closing the panel while the Evo Search box (or anything else inside
  // it) still has focus otherwise leaves it eating keystrokes even after
  // resuming play — e.g. pressing M to mega-evolve would also silently
  // type "m" into a search box that's no longer even visible.
  else if (document.activeElement && settingsPanel.contains(document.activeElement)) document.activeElement.blur();
}

function renderSettingsPanel() {
  settingsPanel.innerHTML = `
    <h3>⏸ Paused</h3>
    ${sliderRow("spriteScale", "Digimon Size", state.spriteScale, 0.5, 2)}
    <label>Digimon Names:
      <select id="s_nameLanguage">
        <option value="english"${state.nameLanguage === "english" ? " selected" : ""}>English</option>
        <option value="japanese"${state.nameLanguage === "japanese" ? " selected" : ""}>Japanese</option>
      </select>
    </label>
    <div id="evoSearchSection">
      <h4>DigiEvolution Tree Search</h4>
      <input id="evoSearchInput" type="text" placeholder="Search a Digimon…" autocomplete="off">
      <div id="evoSearchSuggestions"></div>
      <div id="evoSearchResult"></div>
    </div>
    <p class="hint">Ctrl+P to resume · everything is frozen while paused</p>
  `;

  document.getElementById("s_spriteScale").addEventListener("input", (e) => {
    state.spriteScale = parseFloat(e.target.value);
    document.getElementById("v_spriteScale").textContent = state.spriteScale.toFixed(2);
  });

  document.getElementById("s_nameLanguage").addEventListener("change", (e) => {
    state.nameLanguage = e.target.value;
    updateHUD();
    if (lastSearchedName) renderEvoSearchResult(lastSearchedName);
  });

  wireEvoSearch();
}
function sliderRow(key, label, val, min, max) {
  return `<label>${label}: <span id="v_${key}">${val.toFixed(2)}</span><br>
    <input id="s_${key}" type="range" min="${min}" max="${max}" step="0.05" value="${val}"></label>`;
}

// ---------------------------------------------------------------------------
// DigiEvolution Tree Search (in the pause/settings panel). Both directions
// now derive from the same single source of truth, each Digimon's own
// evolves_to (see my_digimon_data.json / build_my_digimon_data.py):
// DG_DATA.getChildren reads it directly, DG_DATA.getDirectParents reads
// the reverse lookup built from it at load time.
// ---------------------------------------------------------------------------
function evoSearchRowHTML(name) {
  const t = DG_DATA.getEntry(name);
  if (!t) return "";
  return `<div class="evoRow"><img src="${t.iconPath}"><div class="evoInfo"><span>${digiName(t)}</span><span class="evoType">${STAGE_SHORT_LABEL[t.stage] || t.stage}</span></div></div>`;
}

let lastSearchedName = null;
function renderEvoSearchResult(name) {
  const resultEl = document.getElementById("evoSearchResult");
  if (!resultEl) return;
  lastSearchedName = name;
  const entry = DG_DATA.getEntry(name);
  if (!entry) { resultEl.innerHTML = ""; return; }
  const parents = DG_DATA.getDirectParents(entry.name);
  const children = DG_DATA.getChildren(entry.name);
  resultEl.innerHTML = `
    <div class="evoSearchGroup">
      <h5>Evolved From</h5>
      ${parents.length ? parents.map((p) => evoSearchRowHTML(p)).join("") : '<p class="evoNote">None known.</p>'}
    </div>
    <div class="evoSearchCenter">
      <h5>Searched Digimon</h5>
      ${evoSearchRowHTML(entry.name)}
    </div>
    <div class="evoSearchGroup">
      <h5>Evolves To</h5>
      ${children.length ? children.map((c) => evoSearchRowHTML(c)).join("") : '<p class="evoNote">None known.</p>'}
    </div>
  `;
}

function wireEvoSearch() {
  const input = document.getElementById("evoSearchInput");
  const suggestionsEl = document.getElementById("evoSearchSuggestions");
  const resultEl = document.getElementById("evoSearchResult");
  if (!input) return;
  input.addEventListener("input", () => {
    const q = input.value.trim();
    resultEl.innerHTML = "";
    if (q.length < 2) { suggestionsEl.innerHTML = ""; return; }
    const matches = DG_DATA.searchByName(q);
    suggestionsEl.innerHTML = matches
      .map((m) => `<button class="evoSuggestBtn" data-name="${m.name}">${digiName(m)}</button>`)
      .join("") || '<p class="evoNote">No match.</p>';
    for (const btn of suggestionsEl.querySelectorAll(".evoSuggestBtn")) {
      btn.addEventListener("click", () => renderEvoSearchResult(btn.dataset.name));
    }
  });
}

// ---------------------------------------------------------------------------
// Combat resolution
// ---------------------------------------------------------------------------
function markAggressiveCombat() {
  state.lastAggressiveCombatMs = currentFrameNow;
}

// Mega I / II / III, Giga, and Tera form a single strength ladder, in that
// order. A higher rung always deals full damage to a lower one; a lower
// rung's attacks against a higher one are cut to 1/5 — flat, regardless of
// how many rungs apart (Mega I hitting Giga is reduced exactly as much as
// Mega III hitting Giga). Anything below Mega isn't on the ladder at all —
// ordinary damage applies there unchanged, same as always.
function combatTierIndex(stage, megaTier) {
  if (stage === "mega") return megaTier || 1;
  if (stage === "giga") return 4;
  if (stage === "tera") return 5;
  if (stage === "peta") return 6;
  return null;
}
const TIER_LADDER_DIVISOR = 5;
// Returns { dmg, laddered } — `laddered` tells the caller whether the ladder
// already cut this hit, so a SEPARATE defense (like the aura below) doesn't
// stack another reduction on top of it.
function applyTierLadder(targetStage, targetMegaTier, attackerStage, attackerMegaTier, dmg) {
  const targetIdx = combatTierIndex(targetStage, targetMegaTier);
  const attackerIdx = combatTierIndex(attackerStage, attackerMegaTier);
  if (targetIdx == null || attackerIdx == null) return { dmg, laddered: false }; // one side isn't Mega+ — ladder doesn't apply
  if (attackerIdx < targetIdx) return { dmg: Math.round(dmg / TIER_LADDER_DIVISOR), laddered: true };
  return { dmg, laddered: false };
}

function damageEnemy(enemy, dmg, attackerStage, isPlayerAttack, attackerMegaTier) {
  if (enemy.guardedByPlayerOnly && !isPlayerAttack) return; // Guardians only take damage from the player
  // Check aggressiveness *before* this hit can provoke it — hitting a
  // currently-calm pacific Digimon is the deliberate case, even though it
  // becomes aggressive as a result of this very shot.
  const wasAggressive = enemy.alignment === "hostile" || enemy.provoked;
  if (isPlayerAttack && wasAggressive) markAggressiveCombat();
  const fled = attackerStage ? maybeStartFlee(enemy, attackerStage, currentFrameNow) : false;
  if (!fled && enemy.alignment === "pacific" && !enemy.provoked) enemy.provoked = true;
  enemy.hp -= applyTierLadder(enemy.stage, enemy.megaTier, attackerStage, attackerMegaTier, dmg).dmg;
  if (enemy.hp <= 0 && !enemy.dead) {
    enemy.dead = true;
    onEnemyKilled(enemy);
  }
}

function damagePlayer(dmg, attackerStage, attackerMegaTier) {
  const p = state.player;
  if (p.invulnLeft > 0) return;
  if (!Number.isFinite(p.hp)) {
    console.warn(`[damagePlayer] p.hp was ${p.hp} on entry — resetting to maxHp. attackerStage=${attackerStage}, dmg=${dmg}`);
    p.hp = p.maxHp;
  }
  const laddered = applyTierLadder(p.stage, p.megaTier, attackerStage, attackerMegaTier, dmg);
  dmg = laddered.dmg;
  // The aura's own damage reduction doesn't stack on top of an already
  // ladder-reduced hit — that compounding (1/5 THEN *0.4) is what made
  // Giga/aura-bearing Mega III players feel almost nothing from weaker
  // attackers. It still applies in full against same-or-higher-tier hits,
  // which the ladder never touches.
  if (currentAura(p) && !laddered.laddered) dmg = Math.round(dmg * MEGA_TIER.auraDamageReductionMult);
  if (!Number.isFinite(dmg)) {
    console.warn(`[damagePlayer] computed dmg was ${dmg} — treating as 0. attackerStage=${attackerStage}, attackerMegaTier=${attackerMegaTier}`);
    dmg = 0;
  }
  p.hp -= dmg;
  p.invulnLeft = PLAYER_HIT_INVULN_MS;
  if (p.hp <= 0) {
    p.hp = 0;
    killPlayerAndRespawn(attackerStage);
  }
}

function damageRockAt(levelData, tx, ty, dmg) {
  const key = `${tx},${ty}`;
  const hp = levelData.rockHP.get(key);
  if (hp === undefined) return false;
  const wasTree = levelData.tiles[ty][tx] === TILE.TREE;
  const newHp = hp - dmg;
  if (newHp <= 0) {
    levelData.rockHP.delete(key);
    const concealed = levelData.concealedGates && levelData.concealedGates.get(key);
    if (wasTree) {
      // A destroyed tree doesn't just clear — it burns for TREE_BURN_MS,
      // damaging anyone who lingers nearby (see updateBurningTiles).
      levelData.tiles[ty][tx] = TILE.BURNING_TREE;
      levelData.burningTiles.set(key, currentFrameNow + TREE_BURN_MS);
    } else if (concealed) {
      levelData.tiles[ty][tx] = TILE.PORTAL;
      levelData.portals.push({ x: tx, y: ty, targetSectorId: concealed.targetSectorId, label: concealed.label, secret: true });
      levelData.concealedGates.delete(key);
      toast(`A hidden Gate is revealed: ${concealed.label}!`, 3200);
    } else {
      levelData.tiles[ty][tx] = TILE.GRASS;
      levelData.safeGround?.add(key); // in a hazardGround Sector, a broken wall reveals safe green ground
    }
    return true;
  }
  levelData.rockHP.set(key, newHp);
  return false;
}

// Factorial Town's moving machines: same HARD_WALL_HP as a reinforced
// Labyrinth wall (3 Mega-level hits), but removed outright on destruction
// rather than clearing to grass — there's no fixed tile to clear, they
// just stop existing.
function damageMachineAt(levelData, machine, dmg) {
  machine.hp -= dmg;
  if (machine.hp <= 0) {
    const idx = levelData.machines.indexOf(machine);
    if (idx !== -1) levelData.machines.splice(idx, 1);
  }
}

// Factorial Town's machines: grey, circuit-lit hard walls that creep one
// tile per second (mostly up/down), picking a new heading — straight
// ahead, or a 90-degree turn — every ~15-25 steps (or immediately, if the
// way ahead is blocked).
function machineCanEnter(levelData, x, y) {
  return tileAt(levelData, x, y) === TILE.GRASS && !machineAt(levelData, x, y);
}
function machineTurnOptions(m) {
  const ahead = { dx: m.dirDx, dy: m.dirDy };
  const left = { dx: m.dirDy, dy: -m.dirDx };
  const right = { dx: -m.dirDy, dy: m.dirDx };
  const back = { dx: -m.dirDx, dy: -m.dirDy };
  return [ahead, left, right, back];
}
function updateMachines(dt, levelData) {
  if (!levelData.machines || levelData.machines.length === 0) return;
  for (const m of levelData.machines) {
    if (m.hp <= 0) continue;
    if (m.stationary) continue; // Cloning City's energy sources never move
    m.stepTimer += dt;
    if (m.stepTimer < 1) continue;
    m.stepTimer -= 1;

    const nx = m.x + m.dirDx, ny = m.y + m.dirDy;
    if (machineCanEnter(levelData, nx, ny)) {
      m.x = nx; m.y = ny;
      m.stepsTaken++;
      if (m.stepsTaken >= m.stepsUntilTurn) {
        m.stepsTaken = 0;
        m.stepsUntilTurn = 15 + Math.floor(Math.random() * 11);
        // "continue ahead, or turn left/right" — pick any of the three
        // (not the U-turn) that's actually open; falls through to a full
        // turn-search below only if even that's blocked.
        const choices = [{ dx: m.dirDx, dy: m.dirDy }, { dx: m.dirDy, dy: -m.dirDx }, { dx: -m.dirDy, dy: m.dirDx }]
          .filter((d) => machineCanEnter(levelData, m.x + d.dx, m.y + d.dy));
        if (choices.length) {
          const pick = choices[Math.floor(Math.random() * choices.length)];
          m.dirDx = pick.dx; m.dirDy = pick.dy;
        }
      }
    } else {
      // Blocked — immediately find a new heading instead of sitting idle.
      m.stepsTaken = 0;
      m.stepsUntilTurn = 15 + Math.floor(Math.random() * 11);
      const opts = machineTurnOptions(m).filter((d) => machineCanEnter(levelData, m.x + d.dx, m.y + d.dy));
      if (opts.length) {
        const pick = opts[Math.floor(Math.random() * opts.length)];
        m.dirDx = pick.dx; m.dirDy = pick.dy;
      }
    }
  }
}

// Cloning City: each of the 4 Cloning Machines clones its one assigned
// Giga Digimon every 10s, for as long as at least one of its 4 energy
// sources (tagged `cloningIndex` on the shared `machines` array) is still
// alive. Once all 4 of a Machine's sources are destroyed, it goes dark
// and stops forever.
const CLONING_INTERVAL_SEC = 7;
// With no cap, a Cloning Machine left powered for a long real-time stretch
// (e.g. while the player works through all 4 energy sources on the other
// 3 Machines) would clone forever — tens then hundreds of Giga enemies
// piling up with nothing ever removing them, until the frame rate collapses
// under the sheer number of auras/projectiles/AI updates. This cap is the
// actual fix for that: once the level's already this crowded, every
// Machine just pauses (spawnTimer stops accumulating, so nothing bursts
// out the moment the player thins the herd) until there's room again.
const CLONING_MAX_CONCURRENT_CLONES = 16;
function updateCloningMachines(dt, levelData) {
  if (!levelData.cloningMachines || levelData.cloningMachines.length === 0) return;
  if (state.enemies.length >= CLONING_MAX_CONCURRENT_CLONES) return;
  const cfg = getPlaceCfg(state.currentPlace);
  const diffOverride = DG_DIFFICULTY_OVERRIDES[state.currentPlace];
  for (const cm of levelData.cloningMachines) {
    const powered = levelData.machines.some((m) => m.cloningIndex === cm.index && m.hp > 0);
    if (!powered) continue;
    cm.spawnTimer += dt;
    if (cm.spawnTimer >= CLONING_INTERVAL_SEC) {
      cm.spawnTimer -= CLONING_INTERVAL_SEC;
      const px = cm.x * TILE_SIZE + TILE_SIZE / 2, py = cm.y * TILE_SIZE + TILE_SIZE / 2;
      state.enemies.push(createEnemy(cm.species, "hostile", false, px, py, cfg, diffOverride));
    }
  }
}

// Last-resort global safety net, independent of any one spawn source — in
// case something else (now or in a future change) ever produces a runaway
// number of enemies, this keeps the game itself from ever grinding to a
// halt over it. Trims down to the ones closest to the player (farthest
// are the ones least relevant to what's actually happening on screen);
// never touches the player's own stage/stats/score, and warns once per
// Sector visit rather than spamming a toast every frame it's over the cap.
const GLOBAL_ENEMY_SAFETY_CAP = 60;
function enforceEnemyCap(levelData) {
  if (state.enemies.length <= GLOBAL_ENEMY_SAFETY_CAP) return;
  const p = state.player;
  state.enemies.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  state.enemies.length = GLOBAL_ENEMY_SAFETY_CAP;
  if (!levelData.enemyCapWarned) {
    levelData.enemyCapWarned = true;
    toast("⚠ Too many enemies piled up at once — thinned the swarm to keep things running smoothly.", 4000);
  }
}

// Generic big-icon moving hazards (Gear Meadows' gears, Chaos Zone's chaos
// objects) — continuous movement, bounces off blocking terrain on either
// axis independently (so diagonal movers bounce naturally too), never
// blocks anyone's movement, just deals contact damage to the player.
function updateHazards(dt, levelData) {
  if (!levelData.hazards || levelData.hazards.length === 0) return;
  const r = TILE_SIZE * 0.3;
  for (const h of levelData.hazards) {
    const stepX = h.dirDx * h.speed * dt;
    const nx = h.x + stepX;
    if (stepX !== 0 && !isWalkableAt(levelData, nx + Math.sign(stepX) * r, h.y)) h.dirDx = -h.dirDx;
    else h.x = nx;
    const stepY = h.dirDy * h.speed * dt;
    const ny = h.y + stepY;
    if (stepY !== 0 && !isWalkableAt(levelData, h.x, ny + Math.sign(stepY) * r)) h.dirDy = -h.dirDy;
    else h.y = ny;
    h.rot += dt * 3;

    const p = state.player;
    if (Math.hypot(p.x - h.x, p.y - h.y) < r + TILE_SIZE * 0.28) damagePlayer(h.dmg);
  }
}

// Burning trees damage anyone nearby for TREE_BURN_MS, then clear to grass.
// Ticks once per second, mirroring the fire-tile damage cadence.
let burnTickAccum = 0;
function updateBurningTiles(dt, levelData) {
  if (!levelData.burningTiles || levelData.burningTiles.size === 0) return;
  for (const [key, expiresAt] of levelData.burningTiles) {
    if (currentFrameNow >= expiresAt) {
      levelData.burningTiles.delete(key);
      const [tx, ty] = key.split(",").map(Number);
      levelData.tiles[ty][tx] = TILE.GRASS;
    }
  }
  burnTickAccum += dt;
  if (burnTickAccum < 1) return;
  burnTickAccum = 0;
  const radiusPx = TREE_BURN_RADIUS_TILES * TILE_SIZE;
  for (const key of levelData.burningTiles.keys()) {
    const [tx, ty] = key.split(",").map(Number);
    const cx = tx * TILE_SIZE + TILE_SIZE / 2, cy = ty * TILE_SIZE + TILE_SIZE / 2;
    if (Math.hypot(state.player.x - cx, state.player.y - cy) <= radiusPx) damagePlayer(TREE_BURN_DAMAGE_PER_SEC);
    for (const enemy of state.enemies) {
      if (enemy.dead) continue;
      if (Math.hypot(enemy.x - cx, enemy.y - cy) <= radiusPx) damageEnemy(enemy, TREE_BURN_DAMAGE_PER_SEC);
    }
  }
}

// Coral Reef's fish drift along their heading, occasionally turning at
// random, and gently bounce back in at the Sector's edges.
// Each fish's "real" position lives inside one ideal 2x2-tile cell, with
// periodic (wraparound) boundaries — not bouncing off any Sector edge.
const FISH_CELL = 2 * TILE_SIZE;
function updateFish(dt, levelData) {
  if (!levelData.fish || levelData.fish.length === 0) return;
  for (const f of levelData.fish) {
    f.angle += Math.sin(currentFrameNow / 1000 * 0.6 + f.turnPhase) * 0.6 * dt;
    f.x += Math.cos(f.angle) * f.speed * dt;
    f.y += Math.sin(f.angle) * f.speed * dt;
    f.x = ((f.x % FISH_CELL) + FISH_CELL) % FISH_CELL;
    f.y = ((f.y % FISH_CELL) + FISH_CELL) % FISH_CELL;
  }
}

// That same 2x2 cell is tessellated across the entire visible world — on
// land and over open sea alike — by drawing every copy of every fish that
// falls within (or just outside) the current viewport.
function drawFish(levelData) {
  if (!levelData.fish || levelData.fish.length === 0) return;
  const startCx = Math.floor(state.camX / FISH_CELL) - 1;
  const endCx = Math.ceil((state.camX + canvas.width) / FISH_CELL) + 1;
  const startCy = Math.floor(state.camY / FISH_CELL) - 1;
  const endCy = Math.ceil((state.camY + canvas.height) / FISH_CELL) + 1;
  for (const f of levelData.fish) {
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx2 = startCx; cx2 <= endCx; cx2++) {
        const sx = cx2 * FISH_CELL + f.x - state.camX, sy = cy * FISH_CELL + f.y - state.camY;
        if (sx < -20 || sy < -20 || sx > canvas.width + 20 || sy > canvas.height + 20) continue;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(f.angle);
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = f.color;
        ctx.beginPath(); ctx.ellipse(0, 0, 9, 4.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-8, 0); ctx.lineTo(-14, -4.5); ctx.lineTo(-14, 4.5); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
  }
}

// Generic tessellated 0/1 digit field (see makeDigitCell) — same periodic
// 2x2-tile-cell technique as the fish above, reused for any place that
// wants it. Movement update is place-agnostic; color/size are picked by
// the caller per place.
const DIGIT_CELL = 2 * TILE_SIZE;
function updateDigitCell(dt, levelData) {
  if (!levelData.digitCell || levelData.digitCell.length === 0) return;
  for (const d of levelData.digitCell) {
    d.x = ((d.x + d.vx * dt) % DIGIT_CELL + DIGIT_CELL) % DIGIT_CELL;
    d.y = ((d.y + d.vy * dt) % DIGIT_CELL + DIGIT_CELL) % DIGIT_CELL;
  }
}
function drawDigitCell(levelData, color, fontPx) {
  if (!levelData.digitCell || levelData.digitCell.length === 0) return;
  const startCx = Math.floor(state.camX / DIGIT_CELL) - 1;
  const endCx = Math.ceil((state.camX + canvas.width) / DIGIT_CELL) + 1;
  const startCy = Math.floor(state.camY / DIGIT_CELL) - 1;
  const endCy = Math.ceil((state.camY + canvas.height) / DIGIT_CELL) + 1;
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `bold ${fontPx}px monospace`;
  ctx.textAlign = "center";
  for (const d of levelData.digitCell) {
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx2 = startCx; cx2 <= endCx; cx2++) {
        const sx = cx2 * DIGIT_CELL + d.x - state.camX, sy = cy * DIGIT_CELL + d.y - state.camY;
        if (sx < -30 || sy < -30 || sx > canvas.width + 30 || sy > canvas.height + 30) continue;
        ctx.fillText(d.ch, sx, sy);
      }
    }
  }
  ctx.restore();
}
// Per-place style for the digit field above — Digital Abyss's is 2x the
// size of the Dark Area's, per the brief; True Yggdrasil reuses the Dark
// Area's size, also white.
const DIGIT_FIELD_STYLE = {
  12: { color: "rgba(255,110,230,0.85)", size: 24 }, // Digital Abyss — bright magenta against the purple, same size as the other two
  void_dimension: { color: "rgba(255,255,255,0.6)", size: 24 }, // Dark Area — white
  yggdrasil_finale: { color: "rgba(255,255,255,0.55)", size: 24 }, // True Yggdrasil — white
};

// The Windy Desert: every 5-10s the wind picks a new one-of-8 direction and
// steadily pushes every Digimon there — see the push applied in
// updatePlayer/updateEnemies below.
const WIND_DIRS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]].map(([dx,dy]) => {
  const len = Math.hypot(dx, dy); return { dx: dx / len, dy: dy / len };
});
function updateWind(dt, levelData) {
  const cfg = getPlaceCfg(state.currentPlace);
  if (!cfg?.hasWind) return;
  if (!state.wind || currentFrameNow >= state.wind.changeAt) {
    const dir = WIND_DIRS[Math.floor(Math.random() * WIND_DIRS.length)];
    state.windChangeCount = (state.windChangeCount || 0) + 1;
    // Every 5th wind is a gale: twice the push strength for that stretch.
    const strengthMult = state.windChangeCount % 5 === 0 ? 2 : 1;
    state.wind = { dx: dir.dx, dy: dir.dy, changeAt: currentFrameNow + 5000 + Math.random() * 5000, strengthMult };
  }
  if (!levelData.windStreaks) levelData.windStreaks = [];
  if (levelData.windStreaks.length < 400) {
    const worldPx = levelData.size * TILE_SIZE;
    for (let i = 0; i < 8; i++) {
      if (levelData.windStreaks.length >= 400) break;
      levelData.windStreaks.push({
        x: Math.random() * worldPx, y: Math.random() * worldPx,
        len: 200 + Math.random() * 300, age: 0, life: 0.8 + Math.random() * 0.6,
      });
    }
  }
  for (const s of levelData.windStreaks) {
    s.age += dt;
    s.x += state.wind.dx * WIND_STREAK_SPEED * dt;
    s.y += state.wind.dy * WIND_STREAK_SPEED * dt;
  }
  levelData.windStreaks = levelData.windStreaks.filter((s) => s.age < s.life);
}
const WIND_PUSH_SPEED = 90; // px/s steady push while the wind blows (x2 on gale winds)
const WIND_STREAK_SPEED = 260;
function drawWindStreaks(levelData) {
  if (!levelData.windStreaks || !state.wind) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 20;
  ctx.lineCap = "round";
  for (const s of levelData.windStreaks) {
    const alpha = 1 - s.age / s.life;
    ctx.globalAlpha = alpha * 0.6;
    const sx = s.x - state.camX, sy = s.y - state.camY;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx - state.wind.dx * s.len, sy - state.wind.dy * s.len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// A direct, precise mega hit still deals real (if survivable) damage — but
// anyone just caught in the surrounding blast (not the exact impact point)
// is mostly just knocked back like a strong wind, with only minor damage.
// `opts.skipPlayerDamage` is used when the caller already applied a direct
// hit's damage separately, so the player doesn't get hit twice. `opts.stage`
// is the firing Digimon's stage (mega/giga/tera each have their own blast
// stats); defaults to mega for safety.
function explodeMega(x, y, chargeFrac, levelData, opts = {}) {
  const stage = opts.stage || "mega";
  const stats = STAGE_STATS[stage];
  // splashBaseTiles (Tera only, for now) raises the minimum blast size so
  // it stays "big nevertheless" even on a barely-charged shot — everyone
  // else keeps the original 1-tile floor. Either way it still grows with
  // chargeFrac, same as the sphere's own on-screen size (see maxSphereRadiusFor).
  const baseTiles = stats.splashBaseTiles ?? 1;
  const radiusPx = (baseTiles + stats.splashRadiusTilesMax * chargeFrac) * TILE_SIZE;
  // Labyrinth / Hall of Mirrors / Crystal Palace: enemies are invulnerable
  // to each other's attacks — only the player can hurt them. The only way
  // one enemy's attack could otherwise reach another is this splash.
  const noFriendlyFire = !opts.isPlayerAttack && getPlaceCfg(state.currentPlace)?.noFriendlyFire;
  if (!noFriendlyFire) {
    // A snapshot, not the live array — critical. Killing an enemy can
    // synchronously spawn a replacement (Cloning City's recurring
    // guardian respawns at its one still-powered Machine the instant it
    // dies), and a live for-of over state.enemies would revisit that
    // brand-new enemy within this same pass if it landed inside the
    // blast — which it always does when only one Machine is left, since
    // it can only reappear at the exact spot that just killed it. That
    // kills it, respawns it, kills it again... forever, synchronously,
    // in a single call, with nothing in this loop ever touching the
    // Machine's own power to end it — a real infinite loop, not just a
    // slow one. Snapshotting means this explosion only ever sees the
    // enemies that existed when it detonated, same as the Machine-damage
    // loop below already (correctly) does.
    for (const enemy of state.enemies.slice()) {
      if (enemy.dead) continue;
      // A Giga-or-higher enemy never hurts itself with its own blast — but
      // still takes damage from the player, and from OTHER enemies' blasts.
      if (enemy === opts.owner && DG_DATA.stageIndex(enemy.stage) >= DG_DATA.stageIndex("giga")) continue;
      if (Math.hypot(enemy.x - x, enemy.y - y) <= radiusPx) damageEnemy(enemy, stats.splashDamage, stage, opts.isPlayerAttack, opts.megaTier);
    }
  }
  const playerDist = Math.hypot(state.player.x - x, state.player.y - y);
  if (playerDist <= radiusPx) {
    applyKnockback(state.player, x, y, radiusPx, playerDist);
    if (!opts.isPlayerAttack) markAggressiveCombat(); // an enemy's blast caught the player, not their own
    // Tera's explosion (noPlayerSplashDamage) never hurts the player —
    // enemies in range still take the usual splashDamage above.
    if (!opts.skipPlayerDamage && !stats.noPlayerSplashDamage) damagePlayer(Math.round(stats.dmg * 0.35), stage, opts.megaTier);
  }
  const tRadius = Math.ceil(radiusPx / TILE_SIZE);
  const ctx0 = Math.floor(x / TILE_SIZE), cty0 = Math.floor(y / TILE_SIZE);
  for (let ty = cty0 - tRadius; ty <= cty0 + tRadius; ty++) {
    for (let tx = ctx0 - tRadius; tx <= ctx0 + tRadius; tx++) {
      const cx = tx * TILE_SIZE + TILE_SIZE / 2, cy = ty * TILE_SIZE + TILE_SIZE / 2;
      if (Math.hypot(cx - x, cy - y) <= radiusPx) {
        // The reinforced Labyrinth material doesn't get insta-cleared by a
        // splash like ordinary rock does — it only ever takes one normal
        // hit's worth of damage per explosion, same as a direct attack,
        // so it still takes three Mega-level hits to bring down.
        const isHardWall = levelData.wallMaterial && levelData.wallMaterial.get(`${tx},${ty}`) === "hard";
        damageRockAt(levelData, tx, ty, isHardWall ? stats.dmg : 9999);
      }
    }
  }
  // Factorial Town's machines are just as hard as a reinforced wall (same
  // HARD_WALL_HP) — a sun-sphere splash only ever counts as one normal
  // hit's worth against them too, same as the hard-wall case just above.
  if (levelData.machines) {
    for (const m of levelData.machines.slice()) {
      if (m.hp <= 0) continue;
      const cx = m.x * TILE_SIZE + TILE_SIZE / 2, cy = m.y * TILE_SIZE + TILE_SIZE / 2;
      if (Math.hypot(cx - x, cy - y) <= radiusPx) damageMachineAt(levelData, m, stats.dmg);
    }
  }
  spawnBlast(x, y, radiusPx);
}

const blasts = [];
function spawnBlast(x, y, radius) {
  blasts.push({ x, y, radius, t: 0, duration: 400 });
}

// A brief, decaying push away from (cx,cy) — "like a strong wind" rather
// than a teleport. Stronger the closer you were to the blast center.
function applyKnockback(entity, cx, cy, radiusPx, dist) {
  const away = dist > 1 ? { dx: (entity.x - cx) / dist, dy: (entity.y - cy) / dist } : { dx: 0, dy: -1 };
  const strength = TILE_SIZE * 9 * (1 - dist / radiusPx * 0.6); // even at the edge, still a solid gust
  entity.knockback = { vx: away.dx * strength, vy: away.dy * strength, timeLeft: 350 };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
const LEVELS_WORLD_PX = 50 * TILE_SIZE;

function moveWithCollision(entity, dx, dy, speed, dt, levelData) {
  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy) || 1;
  const stepX = (dx / len) * speed * dt;
  const stepY = (dy / len) * speed * dt;
  const r = TILE_SIZE * 0.28;

  const nx = entity.x + stepX;
  if (stepX === 0 || isWalkableAt(levelData, nx + Math.sign(stepX) * r, entity.y)) {
    entity.x = nx;
  } else if (entity._vx !== undefined) {
    entity._vx = 0; // hit a wall — stored momentum resets rather than carrying through (e.g. Dark Area's drift, Freezeland's ice slide)
  }
  const ny = entity.y + stepY;
  if (stepY === 0 || isWalkableAt(levelData, entity.x, ny + Math.sign(stepY) * r)) {
    entity.y = ny;
  } else if (entity._vy !== undefined) {
    entity._vy = 0;
  }
  if (levelData.wrap) {
    const worldPx = levelData.size * TILE_SIZE;
    entity.x = ((entity.x % worldPx) + worldPx) % worldPx;
    entity.y = ((entity.y % worldPx) + worldPx) % worldPx;
  } else {
    entity.x = Math.max(r, Math.min(LEVELS_WORLD_PX - r, entity.x));
    entity.y = Math.max(r, Math.min(LEVELS_WORLD_PX - r, entity.y));
  }
}

function updatePlayer(dt, levelData) {
  const p = state.player;
  if (p.invulnLeft > 0) p.invulnLeft -= dt * 1000;
  if (p.fireCooldownLeft > 0) p.fireCooldownLeft -= dt * 1000;

  let dx = 0, dy = 0;
  if (state.keys.has("ArrowUp")) dy -= 1;
  if (state.keys.has("ArrowDown")) dy += 1;
  if (state.keys.has("ArrowLeft")) dx -= 1;
  if (state.keys.has("ArrowRight")) dx += 1;

  if (p.sprinting && p.energy > 0) {
    p.energy = Math.max(0, p.energy - SPRINT.energyPerSecond * dt);
    if (p.energy <= 0) p.sprinting = false;
  }
  const sprintMult = p.sprinting ? (SPRINT.stageOverrides[p.stage] ?? SPRINT.speedMult) : 1;

  const tx = Math.floor(p.x / TILE_SIZE), ty = Math.floor(p.y / TILE_SIZE);
  const underTile = tileAt(levelData, tx, ty);
  const placeCfg = getPlaceCfg(state.currentPlace);
  const speed = STAGE_STATS[p.stage].moveSpeed * tileSpeedMultiplier(underTile, placeCfg?.riverSlowMult) * sprintMult;

  if (placeCfg?.frictionless) {
    // True drift, like in space: arrow keys are thrust (acceleration), not
    // a target speed — there's no friction to bleed the momentum off and no
    // speed cap either, so holding a direction just keeps piling on more
    // velocity for as long as you hold it.
    p._vx = p._vx ?? 0; p._vy = p._vy ?? 0;
    const thrust = speed * 2.2;
    p._vx += dx * thrust * dt;
    p._vy += dy * thrust * dt;
    const driftLen = Math.hypot(p._vx, p._vy);
    moveWithCollision(p, p._vx, p._vy, driftLen || 1, dt, levelData);
  } else if (underTile === TILE.ICE) {
    p._vx = p._vx ?? 0; p._vy = p._vy ?? 0;
    const targetVx = dx * speed, targetVy = dy * speed;
    const friction = 0.9; // much slipperier than before — a real slide, not a light nudge
    p._vx += (targetVx - p._vx) * Math.min(1, friction * dt);
    p._vy += (targetVy - p._vy) * Math.min(1, friction * dt);
    const iceSpeed = Math.hypot(p._vx, p._vy);
    moveWithCollision(p, p._vx, p._vy, iceSpeed, dt, levelData);
  } else {
    p._vx = dx * speed; p._vy = dy * speed;
    moveWithCollision(p, dx, dy, speed, dt, levelData);
  }

  // The Windy Desert: a steady extra push in whatever direction the wind
  // is currently blowing, on top of whatever the player themselves did.
  if (placeCfg?.hasWind && state.wind) {
    moveWithCollision(p, state.wind.dx, state.wind.dy, WIND_PUSH_SPEED * (state.wind.strengthMult || 1), dt, levelData);
  }

  let dps = tileDamagePerSecond(underTile, placeCfg, p.stage);
  if (placeCfg?.hazardGround) {
    const isSafe = levelData.safeGround?.has(`${tx},${ty}`);
    if (isSafe) dps = 0;
    else if (underTile === TILE.GRASS) dps = placeCfg.hazardGround.grassDamage;
    else if (underTile === TILE.FIRE) dps = placeCfg.hazardGround.fireDamage;
  }
  if (dps > 0) {
    state.fireTickAccum += dt;
    if (state.fireTickAccum >= 1) { state.fireTickAccum = 0; damagePlayer(dps); }
  } else {
    state.fireTickAccum = 0;
  }

  if (isSunStage(p.stage) && p.charging) {
    const stats = STAGE_STATS[p.stage];
    p.megaChargeFrac = Math.min(1, (currentFrameNow - p.charging.startTime) / stats.chargeTimeMs);
  }

  if (p.knockback && p.knockback.timeLeft > 0) {
    const kb = p.knockback;
    const kbSpeed = Math.hypot(kb.vx, kb.vy);
    moveWithCollision(p, kb.vx, kb.vy, kbSpeed, dt, levelData);
    kb.timeLeft -= dt * 1000;
    kb.vx *= 0.88; kb.vy *= 0.88; // fading gust, not a sustained push
  }
}

// Every attack (player or enemy) kicks its launcher backwards on release,
// proportional to the attack's actual strength — scaled by chargeFrac so a
// barely-charged Mega sphere barely kicks, a full one kicks hard. Only
// active where the current place opts in (see `recoilOnFire` in config.js).
const RECOIL_FACTOR = 3.5;
function applyRecoil(entity, dirx, diry, dmg, chargeFrac) {
  if (!getPlaceCfg(state.currentPlace)?.recoilOnFire) return;
  const strength = dmg * (chargeFrac ?? 1) * RECOIL_FACTOR;
  entity._vx = (entity._vx ?? 0) - dirx * strength;
  entity._vy = (entity._vy ?? 0) - diry * strength;
}

function updateEnemies(dt, levelData) {
  const placeCfg = getPlaceCfg(state.currentPlace);
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    if (enemy.fireCooldownLeft > 0) enemy.fireCooldownLeft -= dt * 1000;
    const action = decideEnemyAction(enemy, state.player, dt, currentFrameNow);
    const stats = STAGE_STATS[enemy.stage];
    const baseSpeed = stats.moveSpeed * action.speedMult * enemy.moveSpeedMult;
    if (placeCfg?.frictionless) {
      // Same uncapped-acceleration drift as the player — "the same should
      // be true for my adversaries."
      enemy._vx = enemy._vx ?? 0; enemy._vy = enemy._vy ?? 0;
      const thrust = baseSpeed * 2.2;
      enemy._vx += action.moveDx * thrust * dt;
      enemy._vy += action.moveDy * thrust * dt;
      const driftLen = Math.hypot(enemy._vx, enemy._vy);
      moveWithCollision(enemy, enemy._vx, enemy._vy, driftLen || 1, dt, levelData);
    } else {
      moveWithCollision(enemy, action.moveDx, action.moveDy, baseSpeed, dt, levelData);
    }
    if (placeCfg?.hasWind && state.wind) {
      moveWithCollision(enemy, state.wind.dx, state.wind.dy, WIND_PUSH_SPEED * (state.wind.strengthMult || 1), dt, levelData);
    }
    if (action.wantFire) {
      const proj = createProjectile(enemy, action.fireDx, action.fireDy);
      state.projectiles.push(proj);
      enemy.fireCooldownLeft = stats.fireCooldown;
      applyRecoil(enemy, action.fireDx, action.fireDy, proj.dmg, proj.chargeFrac);
    }
  }
  state.enemies = state.enemies.filter((e) => !e.dead);
}

function updateProjectiles(dt, levelData) {
  for (const proj of state.projectiles) {
    if (proj.dead) continue;
    const stepX = proj.vx * dt, stepY = proj.vy * dt;
    proj.x += stepX; proj.y += stepY;
    proj.traveled += Math.hypot(stepX, stepY);

    const tx = Math.floor(proj.x / TILE_SIZE), ty = Math.floor(proj.y / TILE_SIZE);
    let tile = tileAt(levelData, tx, ty);
    // An open Crystal Palace door (its key is held) is passable — treat it
    // as plain ground for collision/reflection purposes, same as walking
    // through it does in isWalkableAt.
    const doorColor = levelData.crystalDoors?.get(`${tx},${ty}`);
    if (doorColor && state.player.keys?.[doorColor]) tile = TILE.GRASS;
    const machine = machineAt(levelData, tx, ty);
    const blockedByTerrain = tile === TILE.SEA || ((tile === TILE.ROCK || tile === TILE.TREE) && (levelData.rockHP.get(`${tx},${ty}`) ?? 0) > 0) || !!machine;

    let hit = false;
    if (proj.ownerKind === "player") {
      for (const enemy of state.enemies) {
        if (enemy.dead) continue;
        if (Math.hypot(enemy.x - proj.x, enemy.y - proj.y) < proj.radius + TILE_SIZE * 0.28) {
          if (proj.type === "sun") explodeMega(proj.x, proj.y, proj.chargeFrac, levelData, { stage: proj.owner.stage, isPlayerAttack: true, megaTier: proj.owner.megaTier, owner: proj.owner });
          else damageEnemy(enemy, proj.dmg, proj.owner.stage, true, proj.owner.megaTier);
          hit = true;
          break;
        }
      }
    } else {
      const p = state.player;
      if (Math.hypot(p.x - proj.x, p.y - proj.y) < proj.radius + TILE_SIZE * 0.28) {
        markAggressiveCombat(); // an enemy projectile only ever fires when its owner is aggressive
        if (proj.type === "sun") {
          // a precise, direct hit: real (survivable) damage, plus the usual
          // environmental devastation around the impact point.
          damagePlayer(proj.dmg, proj.owner.stage, proj.owner.megaTier);
          explodeMega(proj.x, proj.y, proj.chargeFrac, levelData, { skipPlayerDamage: true, stage: proj.owner.stage, isPlayerAttack: false, megaTier: proj.owner.megaTier, owner: proj.owner });
        } else {
          damagePlayer(proj.dmg, proj.owner.stage, proj.owner.megaTier);
        }
        hit = true;
      }
    }

    // Mirror Dimension's glass walls: the player's own attacks bounce back
    // instead of dying — same remaining range/lifetime (proj.traveled just
    // keeps counting up as normal), only the direction reverses. Enemy
    // attacks don't reflect — absorbed exactly like hitting an ordinary wall.
    if (tile === TILE.GLASS && proj.ownerKind === "player") {
      proj.vx = -proj.vx; proj.vy = -proj.vy;
      // Undo this frame's forward step with an equal step along the new
      // (reversed) velocity, so it lands back outside the glass instead of
      // flickering in and out of the reflect check next frame.
      proj.x += proj.vx * dt; proj.y += proj.vy * dt;
    } else if (blockedByTerrain) {
      if (proj.type === "sun") explodeMega(proj.x, proj.y, proj.chargeFrac, levelData, { stage: proj.owner.stage, isPlayerAttack: proj.ownerKind === "player", megaTier: proj.owner.megaTier, owner: proj.owner });
      else if (tile === TILE.ROCK || tile === TILE.TREE) damageRockAt(levelData, tx, ty, proj.dmg);
      else if (machine) damageMachineAt(levelData, machine, proj.dmg);
      hit = true;
    }

    if (hit || proj.traveled > proj.maxRange) proj.dead = true;
  }
  state.projectiles = state.projectiles.filter((p) => !p.dead);
}

function updateItems(levelData) {
  const p = state.player;
  const cfg = getPlaceCfg(state.currentPlace);
  for (const item of state.items) {
    if (item.dead) continue;
    if (Math.hypot(item.x - p.x, item.y - p.y) < item.radius + TILE_SIZE * 0.28) {
      item.dead = true;
      if (item.food.heal) {
        if (!Number.isFinite(p.hp)) { console.warn(`[updateItems] p.hp was ${p.hp} before healing — resetting to maxHp.`); p.hp = p.maxHp; }
        p.hp = Math.min(p.maxHp, p.hp + item.healAmount);
      } else {
        gainEnergy(item.energy);
        if (item.food.attribute) p.affinity[item.food.attribute] += 1; // White fruit is neutral
        if (p.stage === "mega") gainMegaPower(MEGA_TIER.powerPerFruit);
        // Sushi Island: a bite of energy, but it costs a nibble of HP too.
        if (item.food.damage) { p.hp = Math.max(0, p.hp - item.food.damage); if (p.hp <= 0) killPlayerAndRespawn(); }
      }
      // Digifood only respawns in the Village (the safe, infinite hub) —
      // everywhere else it's a finite resource once eaten.
      if (state.currentPlace === "village") {
        const grassTiles = levelData.allWalkable.filter(({ x, y }) => levelData.tiles[y][x] === TILE.GRASS);
        if (grassTiles.length) {
          const spot = grassTiles[Math.floor(Math.random() * grassTiles.length)];
          state.items.push(createItem(spot.x * TILE_SIZE + TILE_SIZE / 2, spot.y * TILE_SIZE + TILE_SIZE / 2, cfg.foodWeightOverrides, cfg.customFoodTypes));
        }
      } else if (item.isSushiOverlay && cfg.sushiOverlay) {
        // Sushi Island's sushi/sashimi/nigiri overlay regrows just like
        // fruit, unlike the rest of the (finite) non-Village food supply.
        const grassTiles = levelData.allWalkable.filter(({ x, y }) => levelData.tiles[y][x] === TILE.GRASS);
        if (grassTiles.length) {
          const spot = grassTiles[Math.floor(Math.random() * grassTiles.length)];
          const fresh = createItem(spot.x * TILE_SIZE + TILE_SIZE / 2, spot.y * TILE_SIZE + TILE_SIZE / 2, null, cfg.sushiOverlay.types);
          fresh.iconScale = cfg.sushiOverlay.iconScale;
          fresh.isSushiOverlay = true;
          state.items.push(fresh);
        }
      }
    }
  }
  state.items = state.items.filter((i) => !i.dead);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function updateCamera() {
  const viewPx = TILE_SIZE * currentViewportTiles;
  const ld = getLevelData(state.currentPlace);
  if (ld?.wrap) {
    // No edges to respect in a toroidal space — always center exactly on
    // the player; tileAt()'s modulo wrap keeps whatever falls outside
    // [0, size) sampling the same seamless, infinite-feeling pattern.
    state.camX = state.player.x - viewPx / 2;
    state.camY = state.player.y - viewPx / 2;
    return;
  }
  state.camX = Math.max(0, Math.min(LEVELS_WORLD_PX - viewPx, state.player.x - viewPx / 2));
  state.camY = Math.max(0, Math.min(LEVELS_WORLD_PX - viewPx, state.player.y - viewPx / 2));
}

function grassColor(shade) {
  // interpolate between a deep and a bright green
  const a = [0x27, 0x5e, 0x2b], b = [0x5a, 0xb8, 0x4c];
  const r = Math.round(a[0] + (b[0] - a[0]) * shade);
  const g = Math.round(a[1] + (b[1] - a[1]) * shade);
  const bl = Math.round(a[2] + (b[2] - a[2]) * shade);
  return `rgb(${r},${g},${bl})`;
}

// Lightens/darkens a "#rrggbb" base color by the same per-tile shade noise
// used for ordinary grass, so a reskinned ground (Coral Reef's water, the
// Windy Desert's sand) still gets subtle natural-looking variation.
function shadeColor(hex, shade) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = 0.85 + shade * 0.3;
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

// Like grassColor, but for any pair of "#rrggbb" colors — genuinely
// different shades (e.g. Coral Reef's deep-to-bright crystalline blue),
// not just one hue lightened/darkened.
function interpolateColor(hexA, hexB, t) {
  const a = [parseInt(hexA.slice(1, 3), 16), parseInt(hexA.slice(3, 5), 16), parseInt(hexA.slice(5, 7), 16)];
  const b = [parseInt(hexB.slice(1, 3), 16), parseInt(hexB.slice(3, 5), 16), parseInt(hexB.slice(5, 7), 16)];
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// A real flame — three layered, swaying teardrop tongues (deep red at the
// base fading to white at the tip) plus a few rising sparkles — instead of
// a plain pulsing glow.
// A real tree, seen from the front (or something close to it) rather than
// a flat top-down color block — a trunk rooted at the tile's bottom and a
// rounded canopy rising above it, free to overflow the tile a little, the
// same convention drawFlame already uses for burning trees.
function drawTree(sx, sy, dmgFrac) {
  const cx0 = sx + TILE_SIZE / 2, baseY = sy + TILE_SIZE;
  // Damage darkens the whole tree toward a black shadow of itself, rather
  // than a separate dark blob drawn on top of an otherwise-healthy tree.
  const trunkColor = dmgFrac > 0 ? interpolateColor("#5a3a1e", "#000000", dmgFrac) : "#5a3a1e";
  const canopyColor = dmgFrac > 0 ? interpolateColor("#1f6b2c", "#000000", dmgFrac) : "#1f6b2c";
  ctx.save();
  ctx.fillStyle = trunkColor;
  ctx.fillRect(cx0 - 4, baseY - TILE_SIZE * 0.42, 8, TILE_SIZE * 0.42);
  ctx.fillStyle = canopyColor;
  const canopyY = baseY - TILE_SIZE * 0.48;
  for (const [ox, oy, r] of [[0, -TILE_SIZE * 0.18, TILE_SIZE * 0.32], [-TILE_SIZE * 0.22, 0, TILE_SIZE * 0.26], [TILE_SIZE * 0.22, 0, TILE_SIZE * 0.26]]) {
    ctx.beginPath();
    ctx.arc(cx0 + ox, canopyY + oy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFlame(cx, cy, tx, ty) {
  const t = currentFrameNow / 1000;
  const layers = [
    { h: 30, w: 14, colors: ["#8a1200", "#ff4d00"], sway: 0.16, speed: 2.3, phase: 0 },
    { h: 23, w: 10, colors: ["#ff6a00", "#ffcf3d"], sway: 0.24, speed: 3.1, phase: 1.1 },
    { h: 15, w: 6, colors: ["#ffe27a", "#ffffff"], sway: 0.32, speed: 4.0, phase: 2.2 },
  ];
  ctx.save();
  // 2x bigger, free to spill outside its own tile.
  ctx.translate(cx, cy);
  ctx.scale(2, 2);
  ctx.translate(-cx, -cy);
  const baseY = cy + TILE_SIZE * 0.22;
  for (const layer of layers) {
    const sway = Math.sin(t * layer.speed + tx * 1.7 + ty * 0.9 + layer.phase) * layer.sway * TILE_SIZE;
    const baseX = cx + sway * 0.4;
    const tipX = cx + sway, tipY = baseY - layer.h;
    const grad = ctx.createLinearGradient(cx, baseY, cx, tipY);
    grad.addColorStop(0, layer.colors[0]);
    grad.addColorStop(1, layer.colors[1]);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseX - layer.w, baseY);
    ctx.quadraticCurveTo(baseX - layer.w * 0.5, baseY - layer.h * 0.55, tipX, tipY);
    ctx.quadraticCurveTo(baseX + layer.w * 0.5, baseY - layer.h * 0.55, baseX + layer.w, baseY);
    ctx.closePath();
    ctx.fill();
  }
  // rising, fading sparkle circles
  for (let i = 0; i < 4; i++) {
    const phase = (t * 0.9 + i * 0.27 + tx * 0.13 + ty * 0.31) % 1;
    const sx2 = cx + Math.sin(i * 2.1 + t * 1.6 + tx) * TILE_SIZE * 0.28;
    const sy2 = baseY - phase * TILE_SIZE * 0.85;
    ctx.globalAlpha = (1 - phase) * 0.9;
    ctx.fillStyle = i % 2 === 0 ? "#fff7cc" : "#ffcf3d";
    ctx.beginPath(); ctx.arc(sx2, sy2, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Mirror Dimension: a shining, indestructible glass block — a faceted
// pane look (corner triangle facets) plus a slow sweeping highlight, so it
// reads as reflective rather than just another grey rock.
function drawGlassShine(sx, sy, tx, ty) {
  ctx.save();
  ctx.fillStyle = "#bdeefa";
  ctx.fillRect(sx + 1, sy + 1, TILE_SIZE - 2, TILE_SIZE - 2);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx + 1, sy + 1); ctx.lineTo(sx + TILE_SIZE - 1, sy + TILE_SIZE - 1);
  ctx.moveTo(sx + TILE_SIZE - 1, sy + 1); ctx.lineTo(sx + 1, sy + TILE_SIZE - 1);
  ctx.stroke();
  const t = currentFrameNow / 1000;
  const sweep = ((t * 0.25 + tx * 0.17 + ty * 0.11) % 1) * TILE_SIZE * 1.6 - TILE_SIZE * 0.3;
  const grad = ctx.createLinearGradient(sx + sweep - 14, sy, sx + sweep + 14, sy + TILE_SIZE);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.65)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(sx + 1, sy + 1, TILE_SIZE - 2, TILE_SIZE - 2);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 1.5, sy + 1.5, TILE_SIZE - 3, TILE_SIZE - 3);
  ctx.restore();
}

const CRYSTAL_DOOR_COLORS = { red: ["#7a1414", "#e23b3b"], green: ["#135522", "#3bc45c"], blue: ["#143a7a", "#3b7fe2"] };
// Crystal Palace's three stacked door tiles — a glowing colored slab
// while locked, swinging open (brighter, with visible glass either side)
// once its key is held.
function drawCrystalDoor(sx, sy, color) {
  const open = !!state.player.keys?.[color];
  const [dark, bright] = CRYSTAL_DOOR_COLORS[color] || ["#333", "#999"];
  ctx.save();
  if (open) {
    drawGlassShine(sx, sy, 0, 0);
    ctx.fillStyle = bright;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(sx + 10, sy + 4, TILE_SIZE - 20, TILE_SIZE - 8);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = dark;
    ctx.fillRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
    const pulse = 0.5 + Math.sin(currentFrameNow / 500) * 0.25;
    ctx.strokeStyle = bright;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 3;
    ctx.strokeRect(sx + 6, sy + 6, TILE_SIZE - 12, TILE_SIZE - 12);
    ctx.globalAlpha = 1;
    ctx.fillStyle = bright;
    ctx.beginPath(); ctx.arc(sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// The Hall of Mirrors / Factorial Town's polished floor: a single bright
// surface with a slow sweeping highlight — like the glass walls' shine,
// but no diagonal X cross-stroke, since this is meant to read as one
// continuous mirror-bright floor rather than a faceted block.
function drawMirrorFloorShine(sx, sy, tx, ty) {
  const t = currentFrameNow / 1000;
  const sweep = ((t * 0.2 + tx * 0.13 + ty * 0.09) % 1) * TILE_SIZE * 1.6 - TILE_SIZE * 0.3;
  const grad = ctx.createLinearGradient(sx + sweep - 16, sy, sx + sweep + 16, sy + TILE_SIZE);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
  ctx.restore();
}

// Chaos Zone: every GRASS tile wears a fast-cycling cosmetic skin, picked
// from 8 looks and re-rolled roughly every 2 seconds, independently per
// tile (desynced so they don't all flip in one pulse). Lazily tracked for
// whatever's within the camera view plus a margin ("a bit bigger, to
// avoid buffering") so panning never reveals an un-rolled tile.
const CHAOS_APPEARANCES = ["grass", "water", "deepwater", "red", "darkred", "ice", "mirror", "void"];
const CHAOS_SKIN_MARGIN = 3;
function updateChaosSkin(levelData) {
  if (!levelData.chaosSkin) levelData.chaosSkin = new Map();
  const startTx = Math.floor(state.camX / TILE_SIZE) - CHAOS_SKIN_MARGIN;
  const endTx = Math.ceil((state.camX + canvas.width) / TILE_SIZE) + CHAOS_SKIN_MARGIN;
  const startTy = Math.floor(state.camY / TILE_SIZE) - CHAOS_SKIN_MARGIN;
  const endTy = Math.ceil((state.camY + canvas.height) / TILE_SIZE) + CHAOS_SKIN_MARGIN;
  for (let ty = startTy; ty < endTy; ty++) {
    for (let tx = startTx; tx < endTx; tx++) {
      const key = `${tx},${ty}`;
      let skin = levelData.chaosSkin.get(key);
      if (!skin) {
        levelData.chaosSkin.set(key, {
          appearance: CHAOS_APPEARANCES[Math.floor(Math.random() * CHAOS_APPEARANCES.length)],
          digitChar: Math.random() < 0.5 ? "0" : "1",
          nextChangeAt: currentFrameNow + Math.random() * 2000, // desynced start
        });
      } else if (currentFrameNow >= skin.nextChangeAt) {
        skin.appearance = CHAOS_APPEARANCES[Math.floor(Math.random() * CHAOS_APPEARANCES.length)];
        skin.digitChar = Math.random() < 0.5 ? "0" : "1";
        skin.nextChangeAt = currentFrameNow + 2000;
      }
    }
  }
}
function drawChaosSkin(sx, sy, tx, ty, levelData) {
  const skin = levelData.chaosSkin?.get(`${tx},${ty}`);
  const appearance = skin?.appearance || "grass";
  if (appearance === "water") ctx.fillStyle = TILE_COLORS[TILE.RIVER];
  else if (appearance === "deepwater") ctx.fillStyle = TILE_COLORS[TILE.SEA];
  else if (appearance === "red") ctx.fillStyle = "#b23a2a";
  else if (appearance === "darkred") ctx.fillStyle = "#4a0a04";
  else if (appearance === "ice") ctx.fillStyle = TILE_COLORS[TILE.ICE];
  else if (appearance === "mirror") ctx.fillStyle = "#e9f6fb";
  else if (appearance === "void") ctx.fillStyle = "#000000";
  else ctx.fillStyle = grassColor(0.5);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
  if (appearance === "mirror") {
    drawMirrorFloorShine(sx, sy, tx, ty);
  } else if (appearance === "void") {
    // Not one static glyph — a little cluster of dancing 0s/1s, same
    // flavor as the Dark Area's own digit field, as if a piece of it were
    // showing through right here.
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    const t = currentFrameNow / 1000;
    for (let i = 0; i < 3; i++) {
      const h = Math.sin(tx * 12.9898 + ty * 78.233 + i * 37.1) * 43758.5453;
      const frac = h - Math.floor(h);
      const ox = Math.sin(t * 1.3 + frac * 20) * TILE_SIZE * 0.22;
      const oy = Math.cos(t * 1.1 + frac * 17) * TILE_SIZE * 0.22;
      const ch = frac < 0.5 ? "0" : "1";
      ctx.fillText(ch, sx + TILE_SIZE / 2 + ox, sy + TILE_SIZE / 2 + oy + 4);
    }
    ctx.restore();
  }
}

// Factorial Town's machines: a grey block with a few circuit traces and
// blinking lights, so it reads as "doing something" rather than a plain
// wall that happens to move.
function drawMachines(levelData) {
  if (!levelData.machines || levelData.machines.length === 0) return;
  for (const m of levelData.machines) {
    if (m.hp <= 0) continue;
    const sx = m.x * TILE_SIZE - state.camX, sy = m.y * TILE_SIZE - state.camY;
    if (sx < -TILE_SIZE || sy < -TILE_SIZE || sx > canvas.width + TILE_SIZE || sy > canvas.height + TILE_SIZE) continue;
    if (m.kind === "energySource") { drawEnergySource(sx, sy, m); continue; }
    ctx.save();
    const maxHp = m.maxHp ?? HARD_WALL_HP;
    const dmgFrac = 1 - m.hp / maxHp;
    ctx.fillStyle = "#5a5f66";
    ctx.fillRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6);
    ctx.strokeStyle = "#2b2e33";
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6);
    // circuit traces
    ctx.strokeStyle = "#7fd4ff";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sx + 10, sy + TILE_SIZE / 2);
    ctx.lineTo(sx + TILE_SIZE / 2 - 4, sy + TILE_SIZE / 2);
    ctx.lineTo(sx + TILE_SIZE / 2 - 4, sy + 10);
    ctx.moveTo(sx + TILE_SIZE / 2 + 4, sy + TILE_SIZE - 10);
    ctx.lineTo(sx + TILE_SIZE / 2 + 4, sy + TILE_SIZE / 2 + 2);
    ctx.lineTo(sx + TILE_SIZE - 10, sy + TILE_SIZE / 2 + 2);
    ctx.stroke();
    // damage scoring, same visual language as a rock/hard wall
    if (dmgFrac > 0) {
      ctx.fillStyle = `rgba(0,0,0,${0.2 + dmgFrac * 0.4})`;
      ctx.fillRect(sx + 6, sy + 6, TILE_SIZE - 12, TILE_SIZE - 12);
    }
    // blinking lights — a couple of small LEDs that beep in and out of phase
    const t = currentFrameNow / 1000 + m.seed * 10;
    for (const [lx, ly, phase] of [[0.3, 0.3, 0], [0.7, 0.3, 0.6], [0.5, 0.7, 1.3]]) {
      const on = Math.sin(t * 3 + phase * Math.PI * 2) > 0.3;
      ctx.fillStyle = on ? "#ff5a4d" : "#3a1512";
      ctx.beginPath();
      ctx.arc(sx + TILE_SIZE * lx, sy + TILE_SIZE * ly, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Cloning City's energy sources: a bright, pulsing white-to-purple glow
// with a few radiating sparks — dims and flickers as it takes damage.
function drawEnergySource(sx, sy, m) {
  const cx0 = sx + TILE_SIZE / 2, cy0 = sy + TILE_SIZE / 2;
  const t = currentFrameNow / 1000 + m.seed * 10;
  const pulse = 0.75 + Math.sin(t * 3) * 0.25;
  const dmgFrac = 1 - m.hp / (m.maxHp || 1);
  const alpha = 1 - dmgFrac * 0.5;
  ctx.save();
  const r = TILE_SIZE * 0.34 * pulse;
  const grad = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, r);
  grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
  grad.addColorStop(0.45, `rgba(214,150,255,${alpha * 0.9})`);
  grad.addColorStop(1, "rgba(120,0,200,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx0, cy0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(230,200,255,${alpha * 0.8})`;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) {
    const a = t * 2 + (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx0 + Math.cos(a) * r * 0.5, cy0 + Math.sin(a) * r * 0.5);
    ctx.lineTo(cx0 + Math.cos(a) * r * 1.4, cy0 + Math.sin(a) * r * 1.4);
    ctx.stroke();
  }
  ctx.restore();
}

// Cloning City's Cloning Machines themselves — tall glowing purple pods
// that dim to cold grey once all 4 of their energy sources are destroyed.
function drawCloningMachines(levelData) {
  if (!levelData.cloningMachines || levelData.cloningMachines.length === 0) return;
  for (const cm of levelData.cloningMachines) {
    const powered = levelData.machines.some((m) => m.cloningIndex === cm.index && m.hp > 0);
    const sx = cm.x * TILE_SIZE - state.camX, sy = cm.y * TILE_SIZE - state.camY;
    if (sx < -TILE_SIZE * 3 || sy < -TILE_SIZE * 3 || sx > canvas.width + TILE_SIZE * 3 || sy > canvas.height + TILE_SIZE * 3) continue;
    const cx0 = sx + TILE_SIZE / 2, cy0 = sy + TILE_SIZE / 2;
    const t = currentFrameNow / 1000;
    ctx.save();
    ctx.fillStyle = powered ? "#5a2a9e" : "#2a2a30";
    ctx.beginPath();
    ctx.ellipse(cx0, cy0, TILE_SIZE * 0.9, TILE_SIZE * 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = powered ? "#d9b3ff" : "#55555a";
    ctx.lineWidth = 3;
    ctx.stroke();
    if (powered) {
      const pulse = 0.65 + Math.sin(t * 2) * 0.35;
      const grad = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, TILE_SIZE * 0.95 * pulse);
      grad.addColorStop(0, "rgba(255,255,255,0.85)");
      grad.addColorStop(0.5, "rgba(200,120,255,0.5)");
      grad.addColorStop(1, "rgba(120,0,200,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx0, cy0, TILE_SIZE * 0.95 * pulse, TILE_SIZE * 1.45 * pulse, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Generic big-icon moving hazards, 2x scale like the flowers/decor —
// Gear Meadows' gears, Chaos Zone's chaos objects, drawn by `kind`.
function drawHazards(levelData) {
  if (!levelData.hazards || levelData.hazards.length === 0) return;
  for (const h of levelData.hazards) {
    const sx = h.x - state.camX, sy = h.y - state.camY;
    if (sx < -40 || sy < -40 || sx > canvas.width + 40 || sy > canvas.height + 40) continue;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(2, 2);
    ctx.rotate(h.rot);
    drawHazardIcon(h.kind);
    ctx.restore();
  }
}
function drawHazardIcon(kind) {
  if (kind === "gear") {
    ctx.fillStyle = "#1c1c1c";
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.save();
      ctx.rotate(a);
      ctx.fillRect(-2.2, -15, 4.4, 6);
      ctx.restore();
    }
    ctx.fillStyle = "#555";
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  } else if (kind === "bolt") {
    ctx.fillStyle = "#ffe066";
    ctx.beginPath();
    ctx.moveTo(-2, -16); ctx.lineTo(5, -2); ctx.lineTo(0, -2); ctx.lineTo(6, 16); ctx.lineTo(-6, 2); ctx.lineTo(-1, 2);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "skull") {
    ctx.fillStyle = "#f2f2f2";
    ctx.beginPath(); ctx.arc(0, -2, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(-6, 4, 12, 7);
    ctx.fillStyle = "#1c1c1c";
    ctx.beginPath(); ctx.arc(-4, -3, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(4, -3, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(-1.3, 2, 2.6, 4);
  } else if (kind === "star") {
    ctx.fillStyle = "#b9ff4d";
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 === 0 ? 13 : 5.5;
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  } else if (kind === "asteroid") {
    ctx.fillStyle = "#8a8a8a";
    ctx.beginPath();
    const bumps = 9;
    for (let i = 0; i < bumps; i++) {
      const a = (i / bumps) * Math.PI * 2;
      const rr = 9 + Math.sin(i * 2.7) * 3;
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#5c5c5c";
    ctx.beginPath(); ctx.arc(-3, -2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(4, 3, 1.6, 0, Math.PI * 2); ctx.fill();
  } else {
    // "orb" (default/fallback)
    const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, 12);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.4, "#c04dff");
    grad.addColorStop(1, "#4a0a66");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
  }
}

// All decorations render 2x their original size (free to overflow their
// own tile — that's fine, even intended for corn and flames).
const DECOR_SCALE = 2;
function drawDecoration(sx, sy, decor) {
  const cx = sx + TILE_SIZE / 2 + (decor.ox || 0), cy = sy + TILE_SIZE / 2 + (decor.oy || 0);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(DECOR_SCALE, DECOR_SCALE);
  ctx.translate(-cx, -cy);
  if (decor.type === "flower" || decor.type === "flower2") {
    const petal = decor.type === "flower" ? "#ffd166" : "#ff8fd6";
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.fillStyle = petal;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#fff6b0";
    ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.fill();
  } else if (decor.type === "tuft") {
    ctx.strokeStyle = "#2f7a34";
    ctx.lineWidth = 2;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 4, cy + 6);
      ctx.lineTo(cx + i * 4 + i * 2, cy - 6);
      ctx.stroke();
    }
  } else if (decor.type === "pebble") {
    ctx.fillStyle = "#8b8b83";
    ctx.beginPath(); ctx.ellipse(cx, cy, 6, 4, 0.3, 0, Math.PI * 2); ctx.fill();
  } else if (decor.type === "shrub") {
    ctx.fillStyle = "#1f5c28";
    ctx.beginPath(); ctx.arc(cx - 4, cy, 6, 0, Math.PI * 2); ctx.arc(cx + 4, cy, 6, 0, Math.PI * 2); ctx.arc(cx, cy - 4, 6, 0, Math.PI * 2); ctx.fill();
  } else if (decor.type === "rose_red" || decor.type === "rose_white") {
    const petal = decor.type === "rose_red" ? "#d1233c" : "#f7f3ea";
    const shade = decor.type === "rose_red" ? "#8f0f24" : "#d9d2c2";
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.fillStyle = i % 2 === 0 ? petal : shade;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 4.5, cy + Math.sin(a) * 4.5, 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = petal;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#2f7a34"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 12); ctx.stroke();
  } else if (decor.type === "sunflower") {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ctx.fillStyle = "#ffcc33";
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6, 3.4, 1.8, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#5c3b1e";
    ctx.beginPath(); ctx.arc(cx, cy, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#3f7d2e"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 13); ctx.stroke();
  } else if (decor.type === "coral") {
    const hue = 330 + decor.seed * 40;
    ctx.strokeStyle = `hsl(${hue}, 70%, 65%)`;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 4, cy + 7);
      ctx.quadraticCurveTo(cx + i * 7, cy - 2, cx + i * 3, cy - 9);
      ctx.stroke();
    }
    ctx.fillStyle = `hsl(${hue}, 80%, 75%)`;
    ctx.beginPath(); ctx.arc(cx, cy + 6, 3, 0, Math.PI * 2); ctx.fill();
  } else if (decor.type === "corn") {
    // The lean is computed from position + time (not decor.seed), so the
    // whole field ripples as one traveling wave toward the northeast
    // instead of every stalk being a fixed, independent pick. Each "corn"
    // decoration point draws THREE overlapping ears, not one — superimposed
    // together — so with decorPerTile already placing several of these per
    // tile, the field reads as one dense, continuous mass.
    const phase = Math.sin((decor.x - decor.y) * 0.35 - (currentFrameNow / 1000) * 1.4 + decor.seed * 0.5);
    const lean = phase > 0.33 ? 1 : phase < -0.33 ? -1 : 0;
    for (const [jx, jy] of [[-3, 1], [0, 0], [3, -1]]) {
      const ex = cx + jx, ey = cy + jy;
      ctx.strokeStyle = "#8a6d1f"; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(ex, ey + 9); ctx.lineTo(ex + lean * 5, ey - 10); ctx.stroke();
      ctx.fillStyle = "#e8c94a";
      ctx.beginPath();
      ctx.ellipse(ex + lean * 3, ey - 6, 3.4, 7, lean * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5c7a2e"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ex - 5, ey + 6); ctx.lineTo(ex - 2 + lean * 4, ey - 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex + 5, ey + 6); ctx.lineTo(ex + 2 + lean * 4, ey - 5); ctx.stroke();
    }
  } else if (decor.type === "algae") {
    const hue = 95 + decor.seed * 40;
    ctx.strokeStyle = `hsl(${hue}, 55%, 40%)`;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    const sway = Math.sin(currentFrameNow / 700 + decor.seed * 10) * 3;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 3, cy + 8);
      ctx.quadraticCurveTo(cx + i * 3 + sway, cy, cx + i * 2 + sway * 1.5, cy - 10);
      ctx.stroke();
    }
  } else if (decor.type === "leaf") {
    // Autumn Woods' fallen-leaf litter — small rotated ovals, cheap to draw
    // since there are 40 of these stamped on every single grass tile.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(decor.seed * Math.PI * 2);
    ctx.fillStyle = decor.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, 3.2, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// Psychedelic animated Gate: concentric rainbow-hue rings swirling around a
// bright core, cycling continuously — a stargate, but every hue, not just blue.
function drawGate(sx, sy, active) {
  const cx = sx + TILE_SIZE / 2, cy = sy + TILE_SIZE / 2;
  if (!active) {
    ctx.save();
    ctx.strokeStyle = "#8a8794";
    ctx.lineWidth = 4;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, TILE_SIZE * 0.32, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#cfcad8";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("\u{1F512}", cx, cy + 6);
    ctx.restore();
    return;
  }
  const t = currentFrameNow / 1000;
  ctx.save();
  for (let ring = 4; ring >= 0; ring--) {
    const radius = TILE_SIZE * (0.12 + ring * 0.055);
    const hue = (t * 60 + ring * 55) % 360;
    ctx.strokeStyle = `hsl(${hue}, 100%, ${60 - ring * 4}%)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, t * (1 + ring * 0.3), t * (1 + ring * 0.3) + Math.PI * 1.5);
    ctx.stroke();
  }
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, TILE_SIZE * 0.18);
  coreGrad.addColorStop(0, "#ffffff");
  coreGrad.addColorStop(0.5, `hsl(${(t * 90) % 360}, 100%, 70%)`);
  coreGrad.addColorStop(1, "transparent");
  ctx.fillStyle = coreGrad;
  ctx.beginPath(); ctx.arc(cx, cy, TILE_SIZE * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// The same rotating psychedelic rainbow rings as an active Gate, but around
// every Tera-stage Digimon — "I want them around myself in particular."
// (The scraped dataset has no real Tera-stage Digimon, so in practice this
// only ever shows on the player's own Digimental-granted form — but any
// Tera-stage enemy would get the identical treatment.)
// Screen-space core of the effect — shared by the world-anchored aura below
// and drawEvolutionAura (the cutscene version, already in screen space with
// no camera to subtract).
function drawPsychedelicRingsAtScreen(sx, sy, baseR) {
  const t = currentFrameNow / 1000;
  ctx.save();
  for (let ring = 4; ring >= 0; ring--) {
    const radius = baseR + TILE_SIZE * ring * 0.14;
    const hue = (t * 60 + ring * 55) % 360;
    ctx.strokeStyle = `hsl(${hue}, 100%, ${60 - ring * 4}%)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(sx, sy, radius, t * (1 + ring * 0.3), t * (1 + ring * 0.3) + Math.PI * 1.5);
    ctx.stroke();
  }
  const coreGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, baseR * 0.4);
  coreGrad.addColorStop(0, "#ffffff");
  coreGrad.addColorStop(0.5, `hsl(${(t * 90) % 360}, 100%, 70%)`);
  coreGrad.addColorStop(1, "transparent");
  ctx.fillStyle = coreGrad;
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.arc(sx, sy, baseR * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawPsychedelicAura(x, y) {
  const sx = x - state.camX, sy = y - state.camY;
  const baseR = TILE_SIZE * 0.55 * state.spriteScale;
  drawPsychedelicRingsAtScreen(sx, sy, baseR);
}

// "Mega II" instead of a bare "Mega" when a tier is known — Mega I/II/III is
// per-instance, so the same species can show a different tier each time.
function stageLabelWithTier(stage, megaTier) {
  if (stage === "mega" && megaTier) return `Mega ${["I", "II", "III"][megaTier - 1]}`;
  return STAGE_SHORT_LABEL[stage] || stage;
}

function drawLabel(screenX, screenY, name, stage, megaTier) {
  const stageText = stageLabelWithTier(stage, megaTier);
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#000000aa";
  ctx.font = "11px sans-serif";
  ctx.fillText(name, screenX + 0.5, screenY + 0.5);
  ctx.font = "italic 10px sans-serif";
  ctx.fillText(stageText, screenX + 0.5, screenY + 12.5);
  ctx.fillStyle = "#fff";
  ctx.font = "11px sans-serif";
  ctx.fillText(name, screenX, screenY);
  ctx.font = "italic 10px sans-serif";
  ctx.fillStyle = "#dde";
  ctx.fillText(stageText, screenX, screenY + 12);
  ctx.restore();
}

// One consistent "this one hits back hard" shield ring — same size and
// style whether it's the player's own Mega III+/Giga/Tera form or an
// enemy's. Nobody's shield looks bigger just because of who's wearing it.
function shieldRadiusPx(stage, megaTier) {
  if (stage === "mega") return megaTier >= MEGA_TIER.auraMinTier ? MEGA_TIER.auraRadiusTiles.mega * TILE_SIZE : null;
  if (stage === "giga") return MEGA_TIER.auraRadiusTiles.giga * TILE_SIZE;
  if (stage === "tera") return MEGA_TIER.auraRadiusTiles.tera * TILE_SIZE;
  if (stage === "peta") return MEGA_TIER.auraRadiusTiles.peta * TILE_SIZE;
  return null;
}
function drawTierShield(x, y, stage, megaTier) {
  const radiusPx = shieldRadiusPx(stage, megaTier);
  if (!radiusPx) return;
  const sx = x - state.camX, sy = y - state.camY;
  ctx.save();
  if (stage === "mega") {
    const pulse = 0.75 + Math.sin(currentFrameNow / 180) * 0.25;
    ctx.globalAlpha = 0.35 * pulse;
    ctx.strokeStyle = "#ffb347";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(sx, sy, radiusPx, 0, Math.PI * 2); ctx.stroke();
  } else {
    const pulse = 0.7 + Math.sin(currentFrameNow / 220) * 0.3;
    ctx.globalAlpha = 0.16 * pulse;
    ctx.fillStyle = "#7fd8ff";
    ctx.beginPath(); ctx.arc(sx, sy, radiusPx, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55 * pulse;
    ctx.strokeStyle = "#bfeeff";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, radiusPx, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawEntityIcon(entity, contourColor) {
  const screenX = entity.x - state.camX, screenY = entity.y - state.camY;
  const r = TILE_SIZE * 0.4 * state.spriteScale;
  if (contourColor) {
    ctx.beginPath();
    ctx.arc(screenX, screenY, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = contourColor;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(screenX, screenY, r, 0, Math.PI * 2);
  ctx.clip();
  if (entity.icon.complete && entity.icon.naturalWidth > 0) {
    ctx.drawImage(entity.icon, screenX - r, screenY - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = "#666";
    ctx.fillRect(screenX - r, screenY - r, r * 2, r * 2);
  }
  ctx.restore();

  // Every Digimon on screen gets an HP bar under its icon — player, pacific,
  // and aggressive alike — so progress in a fight (however slow) is always
  // visible, not just inferred from the sidebar.
  const w = TILE_SIZE * 0.6;
  const frac = Math.max(0, entity.hp / entity.maxHp);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(screenX - w / 2, screenY + r + 4, w, 5);
  ctx.fillStyle = frac > 0.5 ? "#5cd65c" : frac > 0.2 ? "#e0c93c" : "#e04c4c";
  ctx.fillRect(screenX - w / 2, screenY + r + 4, w * frac, 5);
  const labelY = screenY + r + 22;
  drawLabel(screenX, labelY, digiName(entity.entryData), entity.stage, entity.megaTier);
}

// Mega fireballs stay white-yellow-orange; Giga's are white-lightblue-blue;
// Tera's are white fading to light purple, so all three read as distinct
// attacks at a glance.
const SUN_GRADIENT_STOPS = {
  mega: ["#ffffff", "#ffe066", "#ff6a00"],
  giga: ["#ffffff", "#7fd8ff", "#1560c9"],
  tera: ["#ffffff", "#f3e5ff", "#d9b3ff"],
};
function sunGradientStops(stage) {
  return SUN_GRADIENT_STOPS[stage] || SUN_GRADIENT_STOPS.mega;
}

function drawProjectile(proj) {
  const screenX = proj.x - state.camX, screenY = proj.y - state.camY;
  ctx.save();
  if (proj.type === "bubble") {
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = proj.color;
    ctx.beginPath(); ctx.arc(screenX, screenY, proj.radius, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.stroke();
  } else if (proj.type === "sun") {
    const stops = sunGradientStops(proj.owner?.stage);
    const grad = ctx.createRadialGradient(screenX, screenY, 1, screenX, screenY, proj.radius);
    grad.addColorStop(0, stops[0]);
    grad.addColorStop(0.5, stops[1]);
    grad.addColorStop(1, stops[2]);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(screenX, screenY, proj.radius, 0, Math.PI * 2); ctx.fill();
  } else {
    const grad = ctx.createRadialGradient(screenX, screenY, 1, screenX, screenY, proj.radius);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, proj.color);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(screenX, screenY, proj.radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Sushi Island's overlay items are sushi, not fruit with a sushi emoji
// stuck on top — each food key gets its own distinct real-sushi shape.
function drawSushiIcon(sx, sy, r, food) {
  if (food.key === "sashimi") {
    // A fanned pair of plain fish slices, no rice.
    for (const [ox, rot] of [[-r * 0.3, -0.15], [r * 0.3, 0.15]]) {
      ctx.save();
      ctx.translate(sx + ox, sy);
      ctx.rotate(rot);
      ctx.fillStyle = food.color;
      ctx.beginPath();
      ctx.roundRect(-r * 0.45, -r * 0.65, r * 0.9, r * 1.3, r * 0.22);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  } else if (food.key === "nigiri") {
    // Oblong rice bed with a topping slice draped over it.
    ctx.fillStyle = "#fdf8ec";
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.25, r * 0.6, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = food.color;
    ctx.beginPath();
    ctx.ellipse(sx, sy - r * 0.12, r * 0.58, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#2b2b2b";
    ctx.fillRect(sx - r * 0.55, sy - r * 0.02, r * 1.1, r * 0.2);
  } else {
    // Maki roll: cross-section — nori ring, white rice, colored filling.
    ctx.fillStyle = "#2b2b2b";
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.62, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fdf8ec";
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = food.color;
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.22, 0, Math.PI * 2); ctx.fill();
  }
}

function drawItem(item) {
  const sx = item.x - state.camX, sy = item.y - state.camY;
  const scale = item.iconScale || 1;
  ctx.save();
  if (scale !== 1) { ctx.translate(sx, sy); ctx.scale(scale, scale); ctx.translate(-sx, -sy); }
  if (item.isSushiOverlay) {
    drawSushiIcon(sx, sy, item.radius, item.food);
  } else {
    ctx.fillStyle = item.food.color;
    ctx.beginPath(); ctx.arc(sx, sy, item.radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffffcc";
    ctx.beginPath(); ctx.arc(sx - 3, sy - 3, item.radius * 0.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3fae4a";
    ctx.fillRect(sx - 2, sy - item.radius - 6, 4, 8);
    ctx.fillStyle = "#1a1a1a";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(item.food.symbol, sx, sy + 3.5);
  }
  ctx.restore();
}

function render(levelData) {
  if (state.currentPlace === "yggdrasil_finale") { renderFinale(levelData); return; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cfg = getPlaceCfg(state.currentPlace);
  const startTx = Math.floor(state.camX / TILE_SIZE), startTy = Math.floor(state.camY / TILE_SIZE);
  const endTx = Math.ceil((state.camX + canvas.width) / TILE_SIZE), endTy = Math.ceil((state.camY + canvas.height) / TILE_SIZE);
  const lightCloudCoverage = cfg.lightClouds ? smoothLightCloudCoverage(buildLightCloudCoverage(levelData)) : null;

  for (let ty = startTy; ty < endTy; ty++) {
    for (let tx = startTx; tx < endTx; tx++) {
      const type = tileAt(levelData, tx, ty);
      const sx = tx * TILE_SIZE - state.camX, sy = ty * TILE_SIZE - state.camY;
      const isHardWallTile = type === TILE.ROCK && levelData.wallMaterial?.get(`${tx},${ty}`) === "hard";
      const isSafeGround = levelData.safeGround?.has(`${tx},${ty}`);
      const doorColor = levelData.crystalDoors?.get(`${tx},${ty}`);
      if (doorColor) {
        drawCrystalDoor(sx, sy, doorColor);
        continue;
      }
      if (levelData.mirrorArenaTiles?.has(`${tx},${ty}`) && type === TILE.GRASS) {
        // Crystal Palace's revealed inner arena — the same bright polished
        // look as the Hall of Mirrors, independent of the outer field's
        // hazardGround dark-red styling (which also targets GRASS tiles).
        ctx.fillStyle = interpolateColor("#cfe9f2", "#f4fbff", levelData.grassShade[ty]?.[tx] ?? 0.5);
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        drawMirrorFloorShine(sx, sy, tx, ty);
        continue;
      }
      if (cfg.chaosSkin && type === TILE.GRASS) {
        // Chaos Zone: the underlying tile is plain, open grass everywhere —
        // this is a purely cosmetic, fast-cycling skin on top (see
        // updateChaosSkin/drawChaosSkin). The Gate itself is excluded (it's
        // TILE.PORTAL/GATE_LOCKED, not GRASS) so it's always recognizable.
        drawChaosSkin(sx, sy, tx, ty, levelData);
        continue;
      }
      if (cfg.hazardGround && type === TILE.GRASS && !isSafeGround) {
        ctx.fillStyle = "#b23a2a"; // reclassified "red" ground — 5 HP/sec
      } else if (cfg.hazardGround && type === TILE.FIRE) {
        ctx.fillStyle = "#4a0a04"; // reclassified "darker red" — 10 HP/sec
      } else if (cfg.mirrorFloor && type === TILE.GRASS) {
        // The Hall of Mirrors / Factorial Town: a single, very bright
        // polished surface instead of green — river, ice and fire tiles
        // are untouched by this branch. Each place can pick its own base
        // hue via `mirrorFloorColors` (Factorial Town's is average grey);
        // the Hall of Mirrors' light-blue/grey is just the default.
        const [floorA, floorB] = cfg.mirrorFloorColors || ["#cfe9f2", "#f4fbff"];
        ctx.fillStyle = interpolateColor(floorA, floorB, levelData.grassShade[ty]?.[tx] ?? 0.5);
      } else if (cfg.grassColorRange && type === TILE.GRASS) {
        // Coral Reef's crystalline sea — genuinely different shades of
        // blue (deep to bright), not just one hue lightened/darkened.
        const [deep, bright] = cfg.grassColorRange;
        ctx.fillStyle = interpolateColor(deep, bright, levelData.grassShade[ty]?.[tx] ?? 0.5);
      } else if (cfg.grassColorOverride && type === TILE.GRASS) {
        // The Windy Desert's sand, etc. — same per-tile shade variation as
        // normal grass, just a different base hue.
        ctx.fillStyle = shadeColor(cfg.grassColorOverride, levelData.grassShade[ty]?.[tx] ?? 0.5);
      } else if (type === TILE.GRASS) {
        ctx.fillStyle = grassColor(levelData.grassShade[ty]?.[tx] ?? 0.5);
      } else if (isHardWallTile) {
        ctx.fillStyle = "#1c1c1c"; // dark dark grey — the reinforced Labyrinth material
      } else {
        ctx.fillStyle = TILE_COLORS[type] || "#222";
      }
      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

      if (type === TILE.GRASS) {
        if (cfg.mirrorFloor) drawMirrorFloorShine(sx, sy, tx, ty);
        if (cfg.hazardGround && !isSafeGround && levelData.fireAnimated?.has(`${tx},${ty}`)) drawFlame(sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, tx, ty);
        if (cfg.lightClouds) {
          const alpha = lightCloudCoverage?.get(`${tx},${ty}`);
          if (alpha) {
            ctx.fillStyle = `rgba(255,230,30,${alpha})`;
            ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          }
        }
        const decors = levelData.decorByKey.get(`${tx},${ty}`);
        if (decors) for (const decor of decors) drawDecoration(sx, sy, decor);
      } else if (type === TILE.ROCK) {
        const maxHp = isHardWallTile ? HARD_WALL_HP : ROCK_MAX_HP;
        const hp = levelData.rockHP.get(`${tx},${ty}`) ?? maxHp;
        const dmgFrac = 1 - hp / maxHp;
        ctx.fillStyle = `rgba(0,0,0,${0.25 + dmgFrac * 0.35})`;
        ctx.fillRect(sx + 6, sy + 6, TILE_SIZE - 12, TILE_SIZE - 12);
      } else if (type === TILE.TREE) {
        const hp = levelData.rockHP.get(`${tx},${ty}`) ?? TREE_HP;
        const dmgFrac = 1 - hp / TREE_HP;
        drawTree(sx, sy, dmgFrac);
      } else if (type === TILE.BURNING_TREE) {
        drawFlame(sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, tx, ty);
      } else if (type === TILE.FIRE && levelData.fireAnimated?.has(`${tx},${ty}`)) {
        drawFlame(sx + TILE_SIZE / 2, sy + TILE_SIZE / 2, tx, ty);
      } else if (type === TILE.GLASS) {
        drawGlassShine(sx, sy, tx, ty);
      } else if (type === TILE.PORTAL) {
        drawGate(sx, sy, true);
      } else if (type === TILE.GATE_LOCKED) {
        drawGate(sx, sy, false);
      }
    }
  }
  drawMachines(levelData);
  drawCloningMachines(levelData);
  drawHazards(levelData);

  for (const portal of levelData.portals || []) {
    const sx = portal.x * TILE_SIZE - state.camX + TILE_SIZE / 2, sy = portal.y * TILE_SIZE - state.camY + TILE_SIZE / 2;
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000"; ctx.shadowBlur = 3;
    ctx.fillText(portal.label, sx, sy - TILE_SIZE * 0.42);
    ctx.restore();
  }

  drawFish(levelData);
  drawWaterGlimmerOverlay(levelData, cfg); // on top of the fish and water decor, not under them
  for (const item of state.items) drawItem(item);
  drawCrystal(levelData);
  drawKeyDrops(levelData);
  drawHomeostasisBlock(levelData);
  for (const enemy of state.enemies) {
    // Tera/Peta's aura is drawn later, after the mist/nightfall darkness
    // overlay below — see the pass right after drawNightfallOverlay.
    if (!(enemy.stage === "tera" || enemy.stage === "peta")) drawTierShield(enemy.x, enemy.y, enemy.stage, enemy.megaTier);
    drawEntityIcon(enemy, enemyContourColor(enemy));
  }
  if (!(state.player.stage === "tera" || state.player.stage === "peta")) drawTierShield(state.player.x, state.player.y, state.player.stage, state.player.megaTier);
  drawEntityIcon(state.player, "#4aa8ff");
  for (const proj of state.projectiles) drawProjectile(proj);

  if (state.player.charging) {
    const p = state.player;
    const stats = STAGE_STATS[p.stage];
    const maxR = maxSphereRadiusFor(p);
    const r = stats.minRadius + (maxR - stats.minRadius) * p.megaChargeFrac;
    const sx = p.x - state.camX + p.charging.dx * TILE_SIZE * 0.5, sy = p.y - state.camY + p.charging.dy * TILE_SIZE * 0.5;
    const stops = sunGradientStops(p.stage);
    const grad = ctx.createRadialGradient(sx, sy, 1, sx, sy, r);
    grad.addColorStop(0, stops[0]); grad.addColorStop(0.5, stops[1]); grad.addColorStop(1, stops[2]);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
  }

  for (let i = blasts.length - 1; i >= 0; i--) {
    const b = blasts[i];
    b.t += 16;
    const frac = b.t / b.duration;
    if (frac >= 1) { blasts.splice(i, 1); continue; }
    const sx = b.x - state.camX, sy = b.y - state.camY;
    ctx.globalAlpha = 1 - frac;
    ctx.strokeStyle = "#ffcc66";
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(sx, sy, b.radius * frac, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (currentFrameNow < redAlertUntil) {
    const frac = (redAlertUntil - currentFrameNow) / 1400;
    ctx.save();
    ctx.globalAlpha = 0.35 * frac;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `rgba(255,0,0,${0.7 * frac})`;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
    ctx.restore();
  }
  if (voidOverspeedTimer > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, voidOverspeedTimer / 5);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  drawMistOverlay(cfg);
  drawNightfallOverlay(cfg, levelData);
  // Drawn AFTER both darkness overlays above, on purpose — Tera/Peta's
  // rainbow aura should read as its own light source, visible through
  // Mist Town's fog and the Nightfall Lands' dark exactly like the
  // evolution cutscene's rings (which live entirely outside this darkness
  // system) are always visible.
  for (const enemy of state.enemies) {
    if (enemy.stage === "tera" || enemy.stage === "peta") drawPsychedelicAura(enemy.x, enemy.y);
  }
  if (state.player.stage === "tera" || state.player.stage === "peta") drawPsychedelicAura(state.player.x, state.player.y);
  // Old per-place digit scatter (drawVoidDigits) is deactivated in favor of
  // the generic tessellated 2x2-cell digit field below — see DIGIT_FIELD_STYLE.
  const digitStyle = DIGIT_FIELD_STYLE[state.currentPlace];
  if (digitStyle) drawDigitCell(levelData, digitStyle.color, digitStyle.size);
  drawWindStreaks(levelData);
  if (cfg.sunPatches) drawSunPatches(levelData);
}

// Purely decorative floating 0s/1s for the void dimension — drift and wrap
// exactly like everything else there.
function drawVoidDigits(levelData) {
  const worldPx = levelData.size * TILE_SIZE;
  ctx.save();
  ctx.fillStyle = "rgba(140,255,160,0.55)";
  ctx.font = "13px monospace";
  ctx.textAlign = "center";
  for (const d of levelData.digits) {
    d.x = ((d.x + d.vx * 0.016) % worldPx + worldPx) % worldPx;
    d.y = ((d.y + d.vy * 0.016) % worldPx + worldPx) % worldPx;
    const sx = d.x - state.camX, sy = d.y - state.camY;
    if (sx < -20 || sy < -20 || sx > canvas.width + 20 || sy > canvas.height + 20) continue;
    ctx.fillText(d.ch, sx, sy);
  }
  ctx.restore();
}

// Mist Town: a moving grey mist covers ~9/10 of the tiles at any instant
// (the rest drift clear over time via a shifting noise pattern), hiding
// everything underneath — including a charging Mega orb, which isn't a
// real projectile yet and so never punches a hole in it. Only once an
// attack is actually released (a real entry in state.projectiles) does a
// clear patch open up around it.
// The Nightfall Lands: over the first 20 seconds in the Sector, a smooth
// sunset sweep — warm orange, then red, then a darker red, then black —
// washes over everything. Once fully dark, it behaves like Mist Town's
// own fog: a real attack (a live projectile) punches a visible circle of
// light around it. Flame animations (burning trees, animated fire tiles)
// are never covered at all, at any phase.
const NIGHTFALL_STOPS = [
  { t: 0, rgb: [255, 255, 255], alpha: 0 },
  { t: 5, rgb: [255, 140, 46], alpha: 0.32 },
  { t: 10, rgb: [194, 64, 42], alpha: 0.58 },
  { t: 15, rgb: [90, 15, 10], alpha: 0.8 },
  { t: 20, rgb: [0, 0, 0], alpha: 0.96 },
];
function drawNightfallOverlay(cfg, levelData) {
  if (!cfg?.nightfall) return;
  if (levelData.nightfallStart == null) levelData.nightfallStart = currentFrameNow;
  const elapsed = Math.min(20, (currentFrameNow - levelData.nightfallStart) / 1000);
  let i = 0;
  while (i < NIGHTFALL_STOPS.length - 2 && elapsed > NIGHTFALL_STOPS[i + 1].t) i++;
  const a = NIGHTFALL_STOPS[i], b = NIGHTFALL_STOPS[i + 1];
  const frac = b.t > a.t ? (elapsed - a.t) / (b.t - a.t) : 1;
  const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * frac);
  const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * frac);
  const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * frac);
  const baseAlpha = a.alpha + (b.alpha - a.alpha) * frac;
  if (baseAlpha <= 0.001) return;
  const fullyDark = elapsed >= 20;
  const revealRadius = TILE_SIZE * 2.4;
  const startTx = Math.floor(state.camX / TILE_SIZE), startTy = Math.floor(state.camY / TILE_SIZE);
  const endTx = Math.ceil((state.camX + canvas.width) / TILE_SIZE), endTy = Math.ceil((state.camY + canvas.height) / TILE_SIZE);
  ctx.save();
  for (let ty = startTy; ty < endTy; ty++) {
    for (let tx = startTx; tx < endTx; tx++) {
      const type = tileAt(levelData, tx, ty);
      const isFlameTile = type === TILE.BURNING_TREE || (type === TILE.FIRE && levelData.fireAnimated?.has(`${tx},${ty}`));
      // Only an UNLOCKED Gate stays lit through the dark — a still-locked
      // one is swallowed by the night like everything else, so there's no
      // way to tell "a Gate is here" (let alone mistake it for open)
      // until the boss is actually dead and it opens for real.
      const isOpenGateTile = type === TILE.PORTAL;
      if (isFlameTile || isOpenGateTile) continue;
      let alpha = baseAlpha;
      if (fullyDark) {
        const cxp = tx * TILE_SIZE + TILE_SIZE / 2, cyp = ty * TILE_SIZE + TILE_SIZE / 2;
        let minDist = Infinity;
        for (const proj of state.projectiles) {
          if (proj.dead) continue;
          const d = Math.hypot(proj.x - cxp, proj.y - cyp);
          if (d < minDist) minDist = d;
        }
        if (minDist < revealRadius) alpha *= minDist / revealRadius;
      }
      ctx.fillStyle = `rgba(${r},${g},${bl},${alpha})`;
      ctx.fillRect(tx * TILE_SIZE - state.camX, ty * TILE_SIZE - state.camY, TILE_SIZE, TILE_SIZE);
    }
  }
  ctx.restore();
}

function drawMistOverlay(cfg) {
  if (!cfg?.mistCoverage) return;
  const t = currentFrameNow / 1000;
  const revealRadius = TILE_SIZE * 2.2;
  const startTx = Math.floor(state.camX / TILE_SIZE), startTy = Math.floor(state.camY / TILE_SIZE);
  const endTx = Math.ceil((state.camX + canvas.width) / TILE_SIZE), endTy = Math.ceil((state.camY + canvas.height) / TILE_SIZE);
  ctx.save();
  for (let ty = startTy; ty < endTy; ty++) {
    for (let tx = startTx; tx < endTx; tx++) {
      const noise = Math.sin(tx * 0.5 + t * 0.4) + Math.sin(ty * 0.5 - t * 0.3) + Math.sin((tx + ty) * 0.3 + t * 0.5);
      if (noise > 2.1) continue; // naturally clear right now — drifts over time
      const cx = tx * TILE_SIZE + TILE_SIZE / 2, cy = ty * TILE_SIZE + TILE_SIZE / 2;
      let minDist = Infinity;
      for (const proj of state.projectiles) {
        if (proj.dead) continue;
        const d = Math.hypot(proj.x - cx, proj.y - cy);
        if (d < minDist) minDist = d;
      }
      let alpha = cfg.mistCoverage;
      if (minDist < revealRadius) alpha *= minDist / revealRadius;
      // Light grey, almost white — with a faint, stable per-tile tint (a
      // touch of blue or lavender) rather than one flat grey. Still just
      // as high an alpha as before, so it stays very impenetrable.
      const tint = (Math.sin(tx * 0.37 + ty * 0.53 + 1.7) + 1) / 2;
      const r = 234 + Math.round(tint * 12);
      const g = 234 + Math.round((1 - tint) * 10);
      const b = 240 + Math.round(tint * 14);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(tx * TILE_SIZE - state.camX, ty * TILE_SIZE - state.camY, TILE_SIZE, TILE_SIZE);
    }
  }
  ctx.restore();
}

// Starlight Riverside: soft, slow-drifting patches of warm sunlight —
// large radial glows of varying opacity, as if sun were breaking through
// gaps in a cloud layer. The clouds themselves are never drawn, only the
// light. Drawn last, over the whole scene, so it reads as ambient light.
function drawSunPatches(levelData) {
  if (!levelData.sunPatches || levelData.sunPatches.length === 0) return;
  const worldPx = levelData.size * TILE_SIZE;
  const t = currentFrameNow / 1000;
  ctx.save();
  for (const p of levelData.sunPatches) {
    const wx = ((p.x0 + p.vx * t) % worldPx + worldPx) % worldPx;
    const wy = ((p.y0 + p.vy * t) % worldPx + worldPx) % worldPx;
    const sx = wx - state.camX, sy = wy - state.camY;
    if (sx < -p.radius || sy < -p.radius || sx > canvas.width + p.radius || sy > canvas.height + p.radius) continue;
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, p.radius);
    grad.addColorStop(0, `rgba(255,236,150,${p.alpha})`);
    grad.addColorStop(0.6, `rgba(255,236,150,${p.alpha * 0.5})`);
    grad.addColorStop(1, "rgba(255,236,150,0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(sx, sy, p.radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Starlight Riverside's "light clouds": each is an organic blob of
// 30-50 TILES (not a smooth gradient blob — actual tile-by-tile coverage),
// grown once at generation time, with a strong-yellow core fading to
// more-transparent yellow at its edges. The whole cloud drifts slowly as
// one rigid shape and wraps around the map. Many overlapping clouds keep
// roughly half of all green tiles lit at any given moment.
function updateLightClouds(dt, levelData) {
  if (!levelData.lightClouds || levelData.lightClouds.length === 0) return;
  const worldTiles = levelData.size;
  for (const c of levelData.lightClouds) {
    c.tx = ((c.tx + c.vtx * dt) % worldTiles + worldTiles) % worldTiles;
    c.ty = ((c.ty + c.vty * dt) % worldTiles + worldTiles) % worldTiles;
  }
}
// Rebuilt fresh each render — cheap (a few hundred entries) — mapping
// "tx,ty" to the strongest alpha any cloud currently covering it has.
function buildLightCloudCoverage(levelData) {
  const map = new Map();
  if (!levelData.lightClouds) return map;
  const worldTiles = levelData.size;
  for (const cloud of levelData.lightClouds) {
    for (const m of cloud.members) {
      const tx = Math.round(cloud.tx + m.dx), ty = Math.round(cloud.ty + m.dy);
      const wtx = ((tx % worldTiles) + worldTiles) % worldTiles;
      const wty = ((ty % worldTiles) + worldTiles) % worldTiles;
      const key = `${wtx},${wty}`;
      if (m.alpha > (map.get(key) || 0)) map.set(key, m.alpha);
    }
  }
  return map;
}

// A quick 3x3 box blur (self + 8 neighbors, averaged) over the raw
// coverage map — softens the hard edge between a cloud and the plain
// green around it, without touching how the cloud itself was shaped.
function smoothLightCloudCoverage(rawCoverage) {
  const smoothed = new Map();
  const candidates = new Set();
  for (const key of rawCoverage.keys()) {
    const [x, y] = key.split(",").map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) candidates.add(`${x + dx},${y + dy}`);
  }
  for (const key of candidates) {
    const [x, y] = key.split(",").map(Number);
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += rawCoverage.get(`${x + dx},${y + dy}`) || 0;
    const avg = sum / 9;
    if (avg > 0) smoothed.set(key, avg);
  }
  return smoothed;
}

// Water glimmer (Starlight Riverside's real rivers, Coral Reef's blue
// "water" grass): a stable per-tile hash picks each tile's spot in a
// shared cycle, so at any instant roughly 1-in-5 tiles are mid-glimmer —
// each one brightening to white and fading back over half a second, never
// abruptly popping. Returns 0 (no glimmer right now) to 1 (fully white).
const WATER_GLIMMER_WINDOW = 0.5; // seconds a single tile's glimmer lasts
const WATER_GLIMMER_CYCLE = WATER_GLIMMER_WINDOW / 0.2; // 1-in-5 tiles glimmering at once
function waterGlimmerFrac(tx, ty) {
  const h = Math.sin(tx * 12.9898 + ty * 78.233) * 43758.5453;
  const offset = (h - Math.floor(h)) * WATER_GLIMMER_CYCLE; // stable per-tile offset
  const cyclePos = (currentFrameNow / 1000 + offset) % WATER_GLIMMER_CYCLE;
  if (cyclePos > WATER_GLIMMER_WINDOW) return 0;
  return Math.sin((cyclePos / WATER_GLIMMER_WINDOW) * Math.PI); // smooth 0 -> 1 -> 0
}
function drawWaterGlimmer(sx, sy, tx, ty) {
  const frac = waterGlimmerFrac(tx, ty);
  if (frac <= 0) return;
  ctx.fillStyle = `rgba(255,255,255,${frac * 0.9})`;
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
}
// Drawn as a separate pass AFTER the tile loop, fish, and decorations —
// so the glimmer sits on top of everything in the water (fish, corals,
// algae), not hidden beneath them.
function drawWaterGlimmerOverlay(levelData, cfg) {
  if (!cfg.waterGlimmer) return;
  const startTx = Math.floor(state.camX / TILE_SIZE), endTx = Math.ceil((state.camX + canvas.width) / TILE_SIZE);
  const startTy = Math.floor(state.camY / TILE_SIZE), endTy = Math.ceil((state.camY + canvas.height) / TILE_SIZE);
  for (let ty = startTy; ty < endTy; ty++) {
    for (let tx = startTx; tx < endTx; tx++) {
      const type = tileAt(levelData, tx, ty);
      // Coral Reef's submerged rocks glimmer too, not just the water itself.
      const isWater = type === TILE.RIVER || (cfg.grassColorRange && (type === TILE.GRASS || type === TILE.ROCK));
      if (!isWater) continue;
      drawWaterGlimmer(tx * TILE_SIZE - state.camX, ty * TILE_SIZE - state.camY, tx, ty);
    }
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHUDPlaceLabel() {
  const el = document.getElementById("levelLabel");
  if (state.currentPlace === "yggdrasil_finale") {
    el.innerHTML = "You are in: True Yggdrasil<br><span class=\"placeBoxSub\">The Final Battle</span>";
    return;
  }
  if (state.currentPlace === "void_dimension") {
    el.innerHTML = "You are in: Dark Area<br><span class=\"placeBoxSub\">A place that shouldn't exist</span>";
    return;
  }
  const cfg = getPlaceCfg(state.currentPlace);
  let sub = "";
  if (!cfg.isVillage) {
    const guardianStage = cfg.guardianStageOverride || computeGuardianStage(cfg);
    const requireFullClear = cfg.requireFullClear === true;
    const outranks = !requireFullClear && DG_DATA.stageIndex(state.player.stage) >= DG_DATA.stageIndex("mega") && DG_DATA.stageIndex(state.player.stage) >= DG_DATA.stageIndex(guardianStage);
    if (state.guardianDefeated[state.currentPlace]) sub = "Guardian defeated";
    else if (placeGuardianState[state.currentPlace]?.spawned) sub = `⚠ the Guardian (${STAGE_SHORT_LABEL[guardianStage]}) has appeared!`;
    else if (outranks) sub = "the Guardian senses you and is about to appear...";
    else sub = "defeat the aggressive Digimon to summon the Guardian";
  }
  el.innerHTML = `You are in: ${cfg.name}${sub ? `<br><span class="placeBoxSub">${sub}</span>` : ""}`;
}

// The highest-stage adversary this place can throw at you (Guardian included).
function maxAdversaryStage(cfg) {
  if (cfg.isVillage || cfg.isFinale) {
    let bestIdx = -1, best = null;
    for (const s of Object.keys(cfg.enemyStageWeights || {})) {
      const idx = DG_DATA.stageIndex(s);
      if (idx > bestIdx) { bestIdx = idx; best = s; }
    }
    return best;
  }
  // A Sector that pins its Guardian's stage directly (Labyrinth, Hall of
  // Mirrors, Chaos Zone — see guardianStageOverride in config.js) must show
  // that same pinned stage here too, or the tooltip/HUD label falls back
  // to computeGuardianStage's "one above the weighted ceiling" rule and
  // reports something wrong (e.g. "champion" for a Sector with no weighted
  // enemies at all, like the Hall of Mirrors) even though the actual
  // spawned Guardian correctly used the override.
  return cfg.guardianStageOverride || computeGuardianStage(cfg);
}

// Gate info wants a human label including the Mega sub-tier, e.g. "Mega III".
function maxAdversaryLabel(cfg) {
  const stage = maxAdversaryStage(cfg);
  // True Yggdrasil's stub cfg has no enemyStageWeights at all (its "foes"
  // are the hand-built Guardian ring/swarm, not a weighted pool), so
  // maxAdversaryStage has nothing to compute from — show this instead of
  // the raw null falling through into the template literal as "null".
  if (!stage) return "no information";
  return stageLabelWithTier(stage, cfg.maxMegaTier);
}

// Standing near a Village Gate shows what's on the other side before you commit.
const gateInfoEl = document.getElementById("gateInfo");
function updateGateInfo(levelData) {
  if (!gateInfoEl) return;
  // visibility, not display — this box always reserves the same fixed
  // footprint (see its CSS) so the canvas above it never shifts as this
  // shows and hides while walking around the Village.
  if (state.currentPlace !== "village" || state.mode !== "playing") { gateInfoEl.classList.remove("visible"); return; }
  const p = state.player;
  let nearest = null, nearestDist = Infinity;
  for (const portal of levelData.portals) {
    const d = Math.hypot(portal.x * TILE_SIZE + TILE_SIZE / 2 - p.x, portal.y * TILE_SIZE + TILE_SIZE / 2 - p.y);
    if (d < nearestDist) { nearestDist = d; nearest = portal; }
  }
  if (!nearest || nearestDist > 2.5 * TILE_SIZE) { gateInfoEl.classList.remove("visible"); return; }
  const cfg = getPlaceCfg(nearest.targetSectorId);
  gateInfoEl.classList.add("visible");
  gateInfoEl.innerHTML = `<b>${cfg.name}</b> — Max foes: ${maxAdversaryLabel(cfg)}<br>${cfg.typicality || ""}`;
}
function updateHUD() {
  const p = state.player;
  document.getElementById("hpBar").style.width = `${Math.max(0, (p.hp / p.maxHp) * 100)}%`;
  document.getElementById("hpText").textContent = `${Math.ceil(p.hp)}/${p.maxHp}`;
  const threshold = ENERGY_THRESHOLDS[p.stage];
  const frac = isFinite(threshold) ? Math.min(1, p.energy / threshold) : 1;
  document.getElementById("energyBar").style.width = `${frac * 100}%`;
  document.getElementById("energyText").textContent = isFinite(threshold) ? `${Math.floor(p.energy)}/${threshold}` : `${Math.floor(p.energy)} (MAX)`;
  document.getElementById("nameLabel").textContent = `${digiName(p.entryData)} — ${stageLabelWithTier(p.stage, p.megaTier)}`;
  document.getElementById("scoreLabel").textContent = `Score: ${p.score}`;
  const totalSec = Math.floor(state.gameTimerMs / 1000);
  document.getElementById("timerLabel").textContent = `Time: ${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  const topAttr = DG_DATA.topAffinityAttribute(p.affinity);
  document.getElementById("affinityLabel").textContent = topAttr ? `Leaning toward: ${topAttr}` : "";

  const pacificEl = document.getElementById("pacificLabel");
  if (state.pacificKills > 0) {
    const deliberate = state.pacificKills - state.accidentalPacificKills;
    pacificEl.textContent = `Peaceful Digimon harmed: ${state.pacificKills} (accidental: ${state.accidentalPacificKills}/20, deliberate: ${deliberate})`;
    pacificEl.classList.toggle("warn", state.accidentalPacificKills >= 20 || deliberate > 0);
  } else {
    pacificEl.textContent = "";
  }

  const megaBarEl = document.getElementById("megaPowerRow");
  if (megaBarEl) {
    if (p.stage === "mega" && p.megaTier < 3) {
      const need = MEGA_TIER.thresholds[p.megaTier - 1];
      megaBarEl.style.display = "flex";
      document.getElementById("megaPowerBar").style.width = `${Math.min(1, p.megaPower / need) * 100}%`;
      document.getElementById("megaPowerText").textContent = `Mega power: ${Math.floor(p.megaPower)}/${need}`;
    } else {
      megaBarEl.style.display = "none";
    }
  }

  document.getElementById("crystalsLabel").textContent = `Sector Crystals: ${state.sectorsConquered.size} 💎`;
  const keyIcons = { red: "🟥", green: "🟩", blue: "🟦" };
  const heldKeys = ["red", "green", "blue"].filter((c) => p.keys?.[c]).map((c) => `🔑${keyIcons[c]}`);
  document.getElementById("keysLabel").textContent = heldKeys.length ? `Keys: ${heldKeys.join(" ")}` : "";

  updateEvoPanel();
}

// The right-side panel: what this specific Digimon can evolve into next,
// from the real scraped evolution data, highlighting the branch(es) that
// match the player's current food-affinity leaning.
let lastEvoPanelKey = null;
function updateEvoPanel() {
  const listEl = document.getElementById("evoList");
  const titleEl = document.getElementById("evoPanelTitle");
  if (!listEl) return;
  const p = state.player;
  const topAttr = DG_DATA.topAffinityAttribute(p.affinity);
  const key = `${p.name}|${topAttr}|${state.nameLanguage}`;
  if (key === lastEvoPanelKey) return; // avoid needless DOM rebuilds every frame
  lastEvoPanelKey = key;

  titleEl.textContent = "Evolutions";
  // Only candidates exactly one tier higher than p's own stage (Armor
  // counts as Champion-tier) — see DG_DATA.possibleEvolutions. This is the
  // exact same pool pickEvolution() draws from, so the panel never shows
  // something that can't actually happen.
  const entry = DG_DATA.getEntry(p.name);
  const candidateNames = DG_DATA.possibleEvolutions(p.name);
  if (!candidateNames.length) {
    listEl.innerHTML = `<p class="evoNote">${digiName(entry)} has no evolution listed yet.</p>`;
    return;
  }

  const seen = new Set();
  const rows = [];
  for (const name of candidateNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const target = DG_DATA.getEntry(name);
    if (!target) continue;
    const favored = topAttr && target.attribute === topAttr;
    const typeText = `${target.attribute || "Unknown"} · ${STAGE_SHORT_LABEL[target.stage] || target.stage}`;
    rows.push(
      `<div class="evoRow${favored ? " favored" : ""}"><img src="${target.iconPath}">` +
      `<div class="evoInfo"><span>${digiName(target)}${favored ? " ★" : ""}</span><span class="evoType">${typeText}</span></div></div>`
    );
  }
  listEl.innerHTML = rows.join("") || `<p class="evoNote">${digiName(entry)} has no valid evolution listed yet.</p>`;
}

// ---------------------------------------------------------------------------
// Cutscenes: freeze gameplay for a scripted moment (evolution sparkles,
// DigiEgg hatching, the Digimental) with a canvas animation + DOM caption.
// ---------------------------------------------------------------------------
const cutsceneOverlayEl = document.getElementById("cutsceneOverlay");

// Anchor to the canvas's own box (which resizes with the viewport —
// 7x7/11x11/13x13), not the window: horizontally centered, but well below
// center vertically so the caption doesn't cover the animation playing out
// over the main scene. Called every frame the cutscene is up (not just
// once at the start) so resizing the browser mid-cutscene doesn't leave it
// drifted away from the canvas.
function positionCutsceneOverlay() {
  if (!cutsceneOverlayEl) return;
  const rect = canvas.getBoundingClientRect();
  cutsceneOverlayEl.style.left = `${rect.left + rect.width / 2}px`;
  cutsceneOverlayEl.style.top = `${rect.top + rect.height * 0.88}px`;
}

function startCutscene(type, durationMs, data, onComplete) {
  state.cutscene = { type, startTime: currentFrameNow, duration: durationMs, data, onComplete };
  state.mode = "cutscene";
  if (cutsceneOverlayEl) {
    positionCutsceneOverlay();
    cutsceneOverlayEl.style.display = "block";
    cutsceneOverlayEl.innerHTML = cutsceneCaptionHTML(type, data);
  }
}

function cutsceneCaptionHTML(type, data) {
  if (type === "evolve") return `✨ Evolving! ✨<div class="sub">${data.fromName} → ${data.toName}</div>`;
  if (type === "hatch") return `🥚 A DigiEgg is hatching... 🥚<div class="sub">${data.name} will emerge!</div>`;
  if (type === "digimental") return `💎 The Digimental awakens! 💎<div class="sub">Choose your Tera evolution below</div>`;
  return "";
}

function endCutscene() {
  const cs = state.cutscene;
  if (!cs) return;
  state.cutscene = null;
  if (cutsceneOverlayEl) cutsceneOverlayEl.style.display = "none";
  state.mode = "playing";
  cs.onComplete && cs.onComplete();
}

function drawSparkles(cx, cy, frac) {
  const n = 26;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + frac * 4;
    const dist = TILE_SIZE * (0.4 + 1.4 * ((frac * 3 + i / n) % 1));
    const sx = cx + Math.cos(angle) * dist, sy = cy + Math.sin(angle) * dist;
    const hue = (i / n) * 360 + frac * 200;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = `hsl(${hue}, 100%, 75%)`;
    ctx.beginPath();
    ctx.arc(sx, sy, 3 + 2 * Math.sin(frac * 10 + i), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = 0.5 + 0.3 * Math.sin(frac * 12);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, TILE_SIZE * 1.6);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, TILE_SIZE * 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Evolution cutscene visual: the same multicolor rotating rings as a
// Tera-stage Digimon's aura (see drawPsychedelicRingsAtScreen), growing
// over the cutscene's duration — used INSTEAD of drawSparkles' spiral
// bubbles (kept defined above but deactivated, not deleted, per request).
function drawEvolutionAura(cx, cy, frac) {
  const baseR = TILE_SIZE * (0.55 + frac * 0.5);
  drawPsychedelicRingsAtScreen(cx, cy, baseR);
}

function drawEgg(cx, cy, frac) {
  const wobble = Math.sin(frac * 40) * (frac > 0.7 ? 6 : 1) * Math.min(1, frac * 3);
  ctx.save();
  ctx.translate(cx + wobble, cy);
  ctx.fillStyle = "#fff8e0";
  ctx.beginPath();
  ctx.ellipse(0, 0, TILE_SIZE * 0.55, TILE_SIZE * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#d8c890";
  ctx.lineWidth = 3;
  ctx.stroke();
  // cracks appear progressively
  if (frac > 0.5) {
    ctx.strokeStyle = "#8a7a50";
    ctx.lineWidth = 2;
    const crackFrac = Math.min(1, (frac - 0.5) / 0.4);
    ctx.beginPath();
    ctx.moveTo(-10, -TILE_SIZE * 0.6 * crackFrac);
    ctx.lineTo(5, -10); ctx.lineTo(-8, 15); ctx.lineTo(12, TILE_SIZE * 0.6 * crackFrac);
    ctx.stroke();
  }
  ctx.restore();
  if (frac > 0.85) drawSparkles(cx, cy, (frac - 0.85) / 0.15);
}

function drawDigimental(cx, cy, frac) {
  const t = currentFrameNow / 1000;
  for (let ring = 3; ring >= 0; ring--) {
    const radius = TILE_SIZE * (0.5 + ring * 0.35);
    const hue = (t * 80 + ring * 60) % 360;
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = `hsl(${hue}, 100%, 65%)`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, t * (1 + ring * 0.4), t * (1 + ring * 0.4) + Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.sin(t) * 0.15);
  const grad = ctx.createLinearGradient(0, -40, 0, 40);
  grad.addColorStop(0, "#dff3ff");
  grad.addColorStop(0.5, "#4aa8ff");
  grad.addColorStop(1, "#1a4fb0");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -42); ctx.lineTo(24, 0); ctx.lineTo(0, 42); ctx.lineTo(-24, 0);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#eafaff"; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}

function drawCutsceneVisual(cs) {
  positionCutsceneOverlay();
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const frac = Math.min(1, (currentFrameNow - cs.startTime) / cs.duration);
  if (cs.type === "evolve") drawEvolutionAura(cx, cy, frac);
  else if (cs.type === "hatch") drawEgg(cx, cy, frac);
  else if (cs.type === "digimental") drawDigimental(cx, cy, frac);
  else if (cs.type === "allDelete") drawAllDeleteAnimation(cx, cy, frac);
}

// Tera's ultimate: white light expands around the player for the first
// 3s (frac 0-0.3 of the 10s cutscene), then a black field expands from
// the same point to swallow the whole grid over the next 3s (0.3-0.6),
// holding fully black for the remainder until the cutscene's onComplete
// (see tryTriggerAllDelete) hands off to triggerVictory.
function drawAllDeleteAnimation(cx, cy, frac) {
  const maxR = Math.hypot(canvas.width, canvas.height);
  if (frac < 0.3) {
    const r = Math.max(1, maxR * 0.6 * (frac / 0.3));
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else if (frac < 0.6) {
    const r = maxR * ((frac - 0.3) / 0.3);
    ctx.save();
    ctx.fillStyle = "#000000";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

// Tera's alternate ending: once Digicharge hits its 60,000 cap, Ctrl+A
// unleashes All Delete — a 10s cutscene (white light, then black
// swallowing the whole grid), after which every enemy here is gone and
// the game ends exactly like beating the True Yggdrasil, just with its
// own flavor text.
function tryTriggerAllDelete() {
  const p = state.player;
  if (state.mode !== "playing" || p.stage !== "tera") return;
  const cap = ENERGY_THRESHOLDS.tera;
  if (p.energy < cap) return;
  p.energy = 0;
  startCutscene("allDelete", 10000, {}, () => {
    state.enemies = [];
    state.projectiles = [];
    triggerVictory("All Delete erases every last enemy — you have saved the Digital World!");
  });
}

// ---------------------------------------------------------------------------
// "Deep Explanation" story beats: a paused, slowly-brightening screen with a
// sequence of messages that each fade in, hold, and fade out, with a short
// pause between. Space skips whatever phase is currently in progress.
// ---------------------------------------------------------------------------
function buildDESequence(messages) {
  const seq = [{ type: "rampUp", duration: DE_TIMING.rampUp }];
  messages.forEach((msg, i) => {
    seq.push({ type: "fadeIn", msg, duration: DE_TIMING.fadeIn });
    seq.push({ type: "hold", msg, duration: DE_TIMING.hold });
    seq.push({ type: "fadeOut", msg, duration: DE_TIMING.fadeOut });
    if (i < messages.length - 1) seq.push({ type: "pause", duration: DE_TIMING.pause });
  });
  return seq;
}

function startDeepExplanation(messages, onComplete) {
  state.de = { seq: buildDESequence(messages), idx: 0, phaseStart: currentFrameNow, onComplete };
  state.mode = "deepExplanation";
}

function advanceDEPhase() {
  const de = state.de;
  if (!de) return;
  de.idx += 1;
  de.phaseStart = currentFrameNow;
  if (de.idx >= de.seq.length) {
    const onComplete = de.onComplete;
    state.de = null;
    state.mode = "playing";
    onComplete && onComplete();
  }
}

// Q: dismiss the whole Deep Explanation right away — every remaining
// message, not just the current phase (that's what Space already does).
function skipDeepExplanation() {
  const de = state.de;
  if (!de) return;
  const onComplete = de.onComplete;
  state.de = null;
  state.mode = "playing";
  onComplete && onComplete();
}

// Simple canvas word-wrap, centered, returning the number of lines drawn.
function wrapTextCentered(text, cx, cy, maxWidth, lineHeight) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const startY = cy - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
}

// A big message in the lower part of the grid — "You Died!", "You Won!",
// "You Defeated the Guardian!", etc. Purely a visual; it never touches
// state.mode itself, so whether gameplay is actually frozen while it's up
// is entirely down to whatever the caller does separately (compare
// respawnAsDigiEgg/triggerVictory, which do change mode, against the
// Guardian-defeat banner in onEnemyKilled, which doesn't).
function showBanner(text, color, durationMs) {
  state.banner = { text, color, until: currentFrameNow + durationMs };
}
function drawBannerOverlay() {
  if (!state.banner) return;
  if (currentFrameNow >= state.banner.until) { state.banner = null; return; }
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 52px sans-serif";
  ctx.fillStyle = state.banner.color;
  ctx.shadowColor = "#000000";
  ctx.shadowBlur = 12;
  ctx.fillText(state.banner.text, canvas.width / 2, canvas.height * 0.82);
  ctx.restore();
}

function drawDeepExplanationOverlay() {
  const de = state.de;
  if (!de) return;
  const step = de.seq[de.idx];
  const elapsed = currentFrameNow - de.phaseStart;
  const frac = Math.min(1, elapsed / step.duration);
  const whiteness = step.type === "rampUp" ? frac : 1;

  ctx.save();
  const t = currentFrameNow / 1000;
  for (let ring = 5; ring >= 0; ring--) {
    const hue = (t * 40 + ring * 60) % 360;
    ctx.fillStyle = `hsla(${hue}, 85%, 70%, ${0.07 * whiteness})`;
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, (ring + 1) * canvas.width * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = `rgba(255,255,255,${whiteness * 0.94})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  if (step.type === "fadeIn" || step.type === "hold" || step.type === "fadeOut") {
    let textAlpha = 1;
    if (step.type === "fadeIn") textAlpha = frac;
    else if (step.type === "fadeOut") textAlpha = 1 - frac;
    ctx.save();
    ctx.globalAlpha = textAlpha;
    ctx.fillStyle = "#2a2036";
    ctx.font = "600 18px sans-serif";
    ctx.textAlign = "center";
    wrapTextCentered(step.msg, canvas.width / 2, canvas.height / 2, canvas.width * 0.82, 24);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function loop(now) {
  requestAnimationFrame(loop);
  currentFrameNow = now;
  const dt = Math.min(0.05, (now - (state.lastTime || now)) / 1000);
  state.lastTime = now;

  if (state.mode === "cutscene") {
    const cs = state.cutscene;
    const levelData = getLevelData(state.currentPlace);
    updateCamera();
    render(levelData);
    drawCutsceneVisual(cs);
    updateHUD();
    if (currentFrameNow - cs.startTime >= cs.duration) endCutscene();
    return;
  }
  if (state.mode === "deepExplanation") {
    const de = state.de;
    const levelData = getLevelData(state.currentPlace);
    updateCamera();
    render(levelData);
    drawDeepExplanationOverlay();
    updateHUD();
    const step = de.seq[de.idx];
    if (currentFrameNow - de.phaseStart >= step.duration) advanceDEPhase();
    return;
  }
  if (state.mode !== "playing") {
    if (state.player) {
      const ld = getLevelData(state.currentPlace); updateCamera(); render(ld); updateHUD();
      drawBannerOverlay();
    }
    return;
  }
  state.gameTimerMs += dt * 1000; // only advances while actually playing — frozen by pause/cutscenes/etc.
  const levelData = getLevelData(state.currentPlace);
  updatePlayer(dt, levelData);
  checkVoidOverspeed(dt);
  checkVoidBossTrigger();
  updateAura(dt);
  checkPortalInteraction(levelData);
  updateEnemies(dt, levelData);
  updateProjectiles(dt, levelData);
  updateBurningTiles(dt, levelData);
  updateFish(dt, levelData);
  updateWind(dt, levelData);
  updateDigitCell(dt, levelData);
  updateMachines(dt, levelData);
  updateCloningMachines(dt, levelData);
  enforceEnemyCap(levelData);
  updateHazards(dt, levelData);
  updateLightClouds(dt, levelData);
  if (getPlaceCfg(state.currentPlace)?.chaosSkin) updateChaosSkin(levelData);
  updateItems(levelData);
  updateCrystal(levelData);
  updateKeyDrops(levelData);
  checkCrystalPalaceProgress(levelData);
  checkCloningCityBoss(levelData);
  checkEvolution();
  checkGuardianTrigger(levelData);
  updateFinale();
  checkHomeostasisBlock(levelData);
  updateCamera();
  render(levelData);
  drawBannerOverlay();
  updateHUD();
  updateGateInfo(levelData);
}

// ---------------------------------------------------------------------------
// Character select + boot
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Debug: Mega picker (M) and Debug Mode (B)
// ---------------------------------------------------------------------------
function openMegaPicker() {
  state.mode = "megaPicker";
  document.getElementById("megaPickerOverlay").classList.add("open");
  const search = document.getElementById("megaPickerSearch");
  search.value = "";
  renderMegaPickerGrid("");
  search.focus();
}

function closeMegaPicker() {
  document.getElementById("megaPickerOverlay").classList.remove("open");
  state.mode = "playing";
}

function renderMegaPickerGrid(filter) {
  const grid = document.getElementById("megaPickerGrid");
  const q = filter.trim().toLowerCase();
  const pool = DG_DATA.byStage.mega.filter((e) => !q || e.name.toLowerCase().includes(q) || (e.english_name || "").toLowerCase().includes(q) || digiName(e).toLowerCase().includes(q));
  grid.innerHTML = "";
  for (const entry of pool.slice(0, 120)) {
    const btn = document.createElement("button");
    btn.className = "starterBtn";
    btn.innerHTML = `<img src="${entry.iconPath}"><div>${digiName(entry)}</div>`;
    btn.addEventListener("click", () => {
      evolvePlayer(state.player, entry);
      updateViewportForStage();
      updateEvoPanel();
      state.everReachedMega = true;
      closeMegaPicker();
      toast(`[DEBUG] Evolved to ${digiName(entry)}!`, 2200);
    });
    grid.appendChild(btn);
  }
}

function wireMegaPicker() {
  const search = document.getElementById("megaPickerSearch");
  if (!search) return;
  search.addEventListener("input", () => renderMegaPickerGrid(search.value));
}

// Debug Mode only works for whoever has debug_mode.py sitting next to the
// game locally (see .gitignore) — anyone else just gets "not possible", no
// error, since a 404 resolves the fetch just fine, it just isn't `ok`.
async function tryActivateDebugMode() {
  if (state.debugMode) { toast("Debug Mode is already active.", 1800); return; }
  try {
    const res = await fetch("debug_mode.py", { cache: "no-store" });
    if (!res.ok) { toast("Debug Mode not possible.", 2000); return; }
    state.debugMode = true;
    state.everReachedMega = true; // "the counter... to True, even if it didn't happen"
    const instructionsEl = document.getElementById("instructions");
    if (instructionsEl) instructionsEl.innerHTML += "<br>C: debug all Crystals obtained";
    toast("[DEBUG] Debug Mode activated.", 2400);
  } catch {
    toast("Debug Mode not possible.", 2000);
  }
}

// C (debug, only once Debug Mode is active): instantly "collect" every
// required Sector's crystal, mark every Guardian defeated (opening each
// Sector's own Gate even on a fresh visit — see populatePlace), and reveal
// the True Yggdrasil Gate in the Village, all without actually fighting.
function debugObtainAllCrystals() {
  for (const s of ALL_SECTORS) {
    if (s.secret || s.retired) continue;
    state.sectorsConquered.add(s.id);
    state.guardianDefeated[s.id] = true;
    const cached = state.placeCache[s.id];
    if (cached?.sectorGate && !cached.sectorGate.active) {
      cached.sectorGate.active = true;
      cached.tiles[cached.sectorGate.y][cached.sectorGate.x] = TILE.PORTAL;
    }
  }
  checkAllSectorsConquered();
  toast("[DEBUG] All crystals obtained — every Sector Gate is open and the Yggdrasil Gate has appeared.", 3200);
}

async function boot() {
  await DG_DATA.load();
  const grid = document.getElementById("starterGrid");
  for (const name of DG_DATA.starters) {
    const entry = DG_DATA.getEntry(name);
    const btn = document.createElement("button");
    btn.className = "starterBtn";
    btn.innerHTML = `<img src="${entry.iconPath}"><div>${digiName(entry)}</div>`;
    btn.addEventListener("click", () => startGame(entry));
    grid.appendChild(btn);
  }
  wireMegaPicker();
  const legend = document.getElementById("foodLegend");
  if (legend) {
    legend.innerHTML = FOOD_TYPES.map((f) =>
      `<span class="foodChip" style="background:${f.color}">${f.symbol}</span> ${f.label}${f.heal ? " (heals HP)" : ` (favors ${f.attribute})`}`
    ).join(" &nbsp; ");
  }
  requestAnimationFrame(loop);
}

function startGame(entry) {
  state.starterEntry = entry;
  document.getElementById("charSelectOverlay").style.display = "none";
  document.getElementById("playArea").style.display = "flex";
  state.player = createPlayer(entry, 0, 0);
  enterPlace("village");
  state.mode = "playing";
  startCutscene("hatch", 10000, { name: digiName(entry) }, () => {
    state.gameTimerMs = 0;
    toast(`Welcome, ${digiName(entry)}! Arrows move, WASD fire, Space to sprint. Step through a Gate to enter a Sector. Ctrl+P pauses/opens settings.`, 5000);
  });
}

boot();
