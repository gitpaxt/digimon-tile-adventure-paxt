// All the "knobs" live here so difficulty/balance can be tuned without
// touching game logic. The in-game settings panel (press P) multiplies
// these per-sector via DG_DIFFICULTY_OVERRIDES at runtime.

const TILE_SIZE = 64;
const VIEWPORT_TILES = 7;

// Move speed is the same for every stage — the only way to move faster is
// to sprint (see SPRINT below).
const BASE_MOVE_SPEED = 150;

const STAGE_STATS = {
  baby1: { hp: 20, dmg: 3, moveSpeed: BASE_MOVE_SPEED, fireCooldown: 900, projSpeed: 210, projRadius: 6, projType: "bubble", projColor: "#eaffff", projRangeTiles: 4 },
  baby2: { hp: 32, dmg: 4, moveSpeed: BASE_MOVE_SPEED, fireCooldown: 800, projSpeed: 230, projRadius: 7, projType: "bubble", projColor: "#eaffff", projRangeTiles: 4.5 },
  rookie: { hp: 55, dmg: 8, moveSpeed: BASE_MOVE_SPEED, fireCooldown: 550, projSpeed: 300, projRadius: 8, projType: "fireball", projColor: "#ffe066", projRangeTiles: 6 },
  champion: { hp: 100, dmg: 15, moveSpeed: BASE_MOVE_SPEED, fireCooldown: 480, projSpeed: 340, projRadius: 12, projType: "fireball", projColor: "#ff9d3c", projRangeTiles: 7 },
  // Armor is Champion-tier, not its own power level — same stats, just its
  // own display label (see STAGE_TIER in data.js).
  armor: { hp: 100, dmg: 15, moveSpeed: BASE_MOVE_SPEED, fireCooldown: 480, projSpeed: 340, projRadius: 12, projType: "fireball", projColor: "#ff9d3c", projRangeTiles: 7 },
  ultimate: { hp: 170, dmg: 26, moveSpeed: BASE_MOVE_SPEED, fireCooldown: 420, projSpeed: 430, projRadius: 14, projType: "fireball", projColor: "#ff4d4d", projRangeTiles: 8 },
  // Mega and beyond get a real speed edge over the uniform baseline — "Mega I
  // is faster than now", and Giga/Tera faster still.
  mega: {
    hp: 280, dmg: 45, moveSpeed: 190,
    // projRadius is the fallback used when a Mega-stage enemy autofires through
    // the normal AI path (no charge UI there — only the player charges/releases).
    // fireCooldown matters here too: without one, an enemy's fireCooldownLeft
    // is set to `undefined` after its first shot and never counts back down
    // to <=0, so it would only ever attack once, then go silent forever.
    projType: "sun", projSpeed: 480, projColor: "#fff2b0", projRadius: 26,
    chargeTimeMs: 1600, minRadius: 12, maxRadius: 42, fireCooldown: 2200,
    splashRadiusTilesMax: 4, splashDamage: 9999, // "atomic bomb": lethal within blast radius
  },
  giga: {
    hp: 450, dmg: 70, moveSpeed: 220,
    projType: "sun", projSpeed: 520, projColor: "#fff8d8", projRadius: 34,
    chargeTimeMs: 1600, minRadius: 16, maxRadius: 70, fireCooldown: 1800,
    splashRadiusTilesMax: 5, splashDamage: 9999,
  },
  // Tera is a numeric clone of Giga across hp/dmg/moveSpeed and sphere
  // size — only its color is different (white/light-purple here vs.
  // Giga's white/light-blue; see SUN_GRADIENT_STOPS.tera in game.js), plus
  // two deliberate exceptions: its attack travels 50% faster than Giga's
  // (780 = Giga's 520 * 1.5), and its explosion never damages the player
  // (noPlayerSplashDamage — enemies caught in it still take the usual
  // splashDamage; see explodeMega in game.js) and has a bigger minimum
  // size (splashBaseTiles: 3 tiles, vs. the default 1) so it stays "big
  // nevertheless" even on a barely-charged shot, while still growing with
  // the charge/sphere size on top of that, same as every other stage.
  // Tera still out-ranks Giga in a real fight regardless of these equal
  // base stats: combatTierIndex (game.js) places tera one rung above giga
  // on the Mega/Giga/Tera/Peta damage ladder, so a Tera's hit lands at
  // full force on a Giga while a Giga's hit against a Tera is cut to 1/5
  // (TIER_LADDER_DIVISOR) — the same rule that already separates Mega
  // I/II/III from each other and from Giga.
  tera: {
    hp: 450, dmg: 70, moveSpeed: 220,
    projType: "sun", projSpeed: 780, projColor: "#d9b3ff", projRadius: 34,
    chargeTimeMs: 1600, minRadius: 16, maxRadius: 70, fireCooldown: 1800,
    splashRadiusTilesMax: 5, splashBaseTiles: 3, splashDamage: 9999,
    noPlayerSplashDamage: true,
  },
  // No entry currently reclassifies this high in the scraped data (see
  // build_my_digimon_data.py) — stats exist anyway so a future hand-edit
  // to evolves_to that DOES produce one isn't left with undefined stats.
  peta: {
    hp: 650, dmg: 100, moveSpeed: 280,
    projType: "sun", projSpeed: 600, projColor: "#ffffff", projRadius: 42,
    chargeTimeMs: 1400, minRadius: 20, maxRadius: 82, fireCooldown: 1300,
    splashRadiusTilesMax: 6, splashDamage: 9999,
  },
};

// Enemy-only toughness multipliers applied on top of the normal HP math —
// their attack power is untouched, they just take a lot more killing.
// Mega I stays baseline; Mega II/III and everything past Mega scale up a
// lot more, since raw HP was otherwise identical across every Mega tier.
const ENEMY_TOUGHNESS_MULT = { megaTier2Plus: 3, giga: 6, tera: 20, peta: 30 };

// Reinforced Labyrinth-only wall material: survives exactly three Mega-level
// hits (3 * mega.dmg) before falling, instead of the ordinary Rock's
// ROCK_MAX_HP (which a single Mega hit already clears).
const HARD_WALL_HP = STAGE_STATS.mega.dmg * 3;

// Official level names per my_official_digimon_data.json's own convention
// (Baby I, Baby II, Child, Adult, Perfect, Mega, Giga, Tera) — "rookie" /
// "champion" / "ultimate" stay as internal stage keys only, never shown.
const STAGE_SHORT_LABEL = {
  baby1: "Baby I", baby2: "Baby II", rookie: "Child", champion: "Adult", armor: "Armor", ultimate: "Perfect",
  mega: "Mega", giga: "Giga", tera: "Tera", peta: "Peta",
};

// Energy needed to evolve FROM this stage into the next one. Rookie->Champion
// and beyond are 5x harder than their previous values — evolving used to
// feel too fast past Rookie. Baby I/II stay quick (that part was fine).
// Tera used to be the dead end (Infinity) — Peta is now, since Tera can
// reclassify one step further (see build_my_digimon_data.py).
const ENERGY_THRESHOLDS = {
  baby1: 40, baby2: 100, rookie: 220, champion: 840, armor: 840, ultimate: 1500, mega: 2500, giga: 20000, tera: 60000, peta: Infinity,
};

// Energy awarded for defeating a Digimon of a given stage (guardians get x3).
const ENERGY_REWARDS = {
  baby1: 10, baby2: 16, rookie: 30, champion: 55, armor: 55, ultimate: 90, mega: 140, giga: 220, tera: 320, peta: 420,
};
// Score is a separate, much bigger "feels great" number — purely cosmetic,
// doesn't affect evolution pacing.
const SCORE_REWARDS = {
  baby1: 100, baby2: 175, rookie: 350, champion: 650, armor: 650, ultimate: 1100, mega: 1800, giga: 2800, tera: 4000, peta: 5200,
};

// The player's Mega power meter (filled by red/green/yellow/white fruit —
// not the blue heal fruit) advances Mega I -> II -> III in-place; it's a
// property of this specific instance, not the species. Giga/Tera Digimon
// already have Mega III's abilities and more, so the meter only matters
// while stage === 'mega'.
const MEGA_TIER = {
  thresholds: [150, 400], // power needed for tier 1->2, then 2->3 (each resets the counter)
  maxSphereRadius: { 1: 20, 2: 34, 3: 34 }, // Mega I can't charge as big as II/III
  auraMinTier: 3, // Mega III+ (and Giga/Tera, always) get the repelling aura
  auraRadiusTiles: { mega: 1.2, giga: 2.2, tera: 2.4, peta: 2.6 },
  auraDamagePerSecond: 18,
  auraDamageReductionMult: 0.4, // incoming damage while the aura is up is multiplied by this
  powerPerFruit: 12,
};

// Viewport widens as you grow: normal Digimon see a 7x7 window, Mega sees
// 11x11, Giga/Tera see 13x13.
const VIEWPORT_BY_STAGE = { mega: 11, giga: 13, tera: 13, peta: 13 };
const DIGIFOOD_ENERGY = [15, 25]; // random range

// Digifood flavors. Eating a Vaccine/Data/Virus flavor builds affinity
// toward that Attribute, which biases which branch you evolve into when a
// Digimon has multiple possible next forms. Health fruit heals HP. White
// fruit is a rare, neutral, extra-large energy boost — it "helps with
// evolution" simply by getting you to the next threshold faster.
// Each entry's `weight` controls how often it's picked (see FOOD_WEIGHT_KEYS).
const FOOD_TYPES = [
  { key: "vaccine", attribute: "Vaccine", color: "#e33b3b", label: "Vita Berry", symbol: "♦", weight: 27 },
  { key: "data", attribute: "Data", color: "#3ecb56", label: "Data Fish", symbol: "●", weight: 27 },
  { key: "virus", attribute: "Virus", color: "#f4d13a", label: "Virus Fungus", symbol: "▲", weight: 27 },
  { key: "health", attribute: null, heal: true, color: "#3f8bff", label: "Vita Apple", healRange: [20, 35], symbol: "♥", weight: 15 },
  { key: "white", attribute: null, color: "#f5f5f5", label: "White Fruit", symbol: "★", weight: 4, energyRange: [55, 85] },
];
const DIGIFOOD_BY_KEY = Object.fromEntries(FOOD_TYPES.map((f) => [f.key, f]));

const SPRINT = {
  speedMult: 1.9,
  energyPerSecond: 18,
  // No per-stage overrides — Tera uses the same sprint multiplier as
  // every other stage now that its stats are a clone of Giga's.
  stageOverrides: {},
};

// Enemies that get hit by a strictly-stronger-stage attacker panic and flee
// (at a speed boost) for this long unless hit again (which refreshes it).
const FLEE_DURATION_MS = 2600;
const FLEE_SPEED_MULT = 1.8;

// "Deep Explanation" (internal name only) — a paused, slowly-brightening
// story beat: whiten+ramp, then each message fades in / holds / fades out /
// pauses before the next. Space skips whatever phase is currently playing.
const DE_TIMING = { rampUp: 5000, fadeIn: 3000, hold: 5000, fadeOut: 3000, pause: 2000 };

const HOMEOSTASIS_INTRO_MESSAGES = [
  "I am Homeostasis, He who maintains the balance of the Digital World.",
  "Yggdrasil, the Supercomputer, has gone rogue and wants to reboot the Digital World.",
  "I brought here to Primary Village the Gates to all Sectors.",
  "Build up your strength, defeat the Sectors' Guardians, and use the Crystals to get access to Yggdrasil and then destroy it.",
  "Do not harm the peaceful Digimon with the power I am bestowing upon you.",
  "You are the only hope left for the Digital World.",
];

const HOMEOSTASIS_FAREWELL_MESSAGES = [
  "You've traveled a long way.",
  "You protected the peaceful Digimon to the best of your abilities.",
  "Your good and brave heart allows me to give you all the strength I have left to operate in the Digital World.",
  "I grant to you, one last time, the miracle of Evolution... the sacred crystal, the Digimental.",
  "This is the last chance to destroy Yggdrasil and save the Digital World.",
];

// --- World layout -----------------------------------------------------
// Hub-and-spoke: the Village has one Gate per Sector (always open) plus a
// few hidden Gates to secret Sectors (revealed by destroying the right
// rock). Every non-village Sector has exactly one Gate of its own, inert
// until that Sector's Guardian is defeated, which sends you back home.

const VILLAGE = {
  id: "village", name: "Primary Village", isVillage: true,
  landRadius: 18, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0.012,
  enemyCount: 1, itemCount: 8, safeRadius: 5, // quiet hub: 1/4 the old default of 4

  enemyStageWeights: { baby1: 0.7, baby2: 0.3 },
  hpMult: 0.6, dmgMult: 0.6,
  fixedSpawn: { x: 25, y: 25 },
  beautify: 1.4,
};

// Note: there's no `guardianStage` field here anymore — the Guardian's
// stage is always computed as one stage above the Sector's own hostile
// ceiling (see computeGuardianStage() in game.js), so "the Guardian should
// always be a level stronger, otherwise it's ridiculous" holds everywhere
// automatically as these Sectors get tuned, instead of needing to be kept
// in sync by hand.
const SECTORS = [
  {
    id: 0, name: "Native Forest", gateLabel: "To Native Forest",
    landRadius: 20, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0.05,
    enemyCount: 12, itemCount: 14, safeRadius: 5,
    enemyStageWeights: { baby1: 0.25, baby2: 0.25, rookie: 0.35, champion: 0.1, ultimate: 0.03, mega: 0.02 },
    hpMult: 0.9, dmgMult: 0.85, guardianHpMult: 2.2,
    forcePacificStages: ["ultimate", "mega"], // the first Sector's rare big Digimon are gentle giants
    beautify: 1.6,
    maxMegaTier: 1,
    treeLattice: { density: 1 }, // a full lattice of trees — hard to walk in a straight line

    typicality: "Its rare Perfect/Mega Digimon are gentle giants — mostly peaceful and not hostile.",
    lore: "Long ago, this forest was the first place Digimon data took root in this world — its gentle giants are said to be the wood's original guardians.",
  },
  {
    id: 1, name: "Sarba Continent", gateLabel: "To Sarba Continent",
    landRadius: 21, iceBlobs: 1, fireBlobs: 1, rivers: 2, rockDensity: 0.05,
    enemyCount: 13, itemCount: 12, safeRadius: 5,
    enemyStageWeights: { baby2: 0.1, rookie: 0.45, champion: 0.35, ultimate: 0.1 },
    hpMult: 1.0, dmgMult: 1.0, guardianHpMult: 2.4,
    requireFullClear: true, // Sarba Continent and every Sector past it: the Guardian waits for EVERY Digimon here to fall, no matter how strong you already are
    riverSlowMult: 0.4, // this Sector's rivers slow you much more than usual
    // The red/fire ground here actually hurts now, not just the global
    // 1 HP/sec every plain fire tile deals elsewhere.
    fireDamage: 5,
    typicality: "Balanced plains and rivers — its currents run stronger than most.",
    lore: "Sarba Continent was once a great trading hub between tribes of Child-stage Digimon, its plains still crossed by merchant paths now overgrown — though its rivers, stronger here than anywhere else, swallowed more than one careless merchant's route.",
  },
  {
    id: 2, name: "Fire Sector", gateLabel: "To the Fire Sector",
    landRadius: 21, iceBlobs: 0, fireBlobs: 8, rivers: 0, rockDensity: 0.055,
    enemyCount: 13, itemCount: 12, safeRadius: 5,
    enemyStageWeights: { rookie: 0.3, champion: 0.45, ultimate: 0.25 },
    hpMult: 1.15, dmgMult: 1.1, guardianHpMult: 2.5,
    requireFullClear: true,
    // The ordinary ground itself is scorching here: what used to be green
    // grass deals 5 HP/sec, what used to be fire deals 10 HP/sec. Breaking
    // a wall still reveals safe green ground underneath, same as ever.
    hazardGround: { grassDamage: 5, fireDamage: 10 },
    typicality: "Scorching ground and lava everywhere.",
    lore: "Legends say a fallen Digivice ignited this land centuries ago, and the flames never fully went out.",
  },
  {
    id: 3, name: "Freezeland", gateLabel: "To Freezeland",
    landRadius: 23, iceBlobs: 22, fireBlobs: 0, rivers: 1, rockDensity: 0.055,
    enemyCount: 14, itemCount: 12, safeRadius: 5,
    enemyStageWeights: { rookie: 0.2, champion: 0.45, ultimate: 0.35 },
    hpMult: 1.3, dmgMult: 1.2, guardianHpMult: 2.6,
    requireFullClear: true,
    iceCoverageFrac: 0.8, // 4/5 of the remaining grass becomes ice too — much more ice
    typicality: "Icy and slippery — you'll slide on the frozen ground.",
    lore: "An ancient climate-control server malfunctioned here, freezing the sector in an eternal winter.",
  },
  {
    id: 4, name: "Mist Town", gateLabel: "To Mist Town",
    landRadius: 21, iceBlobs: 1, fireBlobs: 1, rivers: 1, rockDensity: 0.065,
    enemyCount: 14, itemCount: 12, safeRadius: 5,
    enemyStageWeights: { champion: 0.4, ultimate: 0.5, mega: 0.1 },
    hpMult: 1.45, dmgMult: 1.3, guardianHpMult: 2.8,
    requireFullClear: true,
    foodWeightOverrides: { white: 30 },
    maxMegaTier: 1,
    // A moving grey mist covers ~9/10 of tiles at any instant; only a
    // released attack (a real projectile, not a charging orb) punches a
    // clear circle in it (see drawMistOverlay in game.js).
    mistCoverage: 0.9,
    // The red/fire ground here actually hurts now, not just the global
    // 1 HP/sec every plain fire tile deals elsewhere.
    fireDamage: 5,
    typicality: "A thick, ever-shifting mist hides almost everything — only powerful attacks will light your way.",
    lore: "Built by a playful Digimon architect, Mist Town's abundant White Fruit groves are rumored to be leftover experiments in evolution, now lost in a fog that never lifts.",
  },
  {
    id: 5, name: "Mechanical Town", gateLabel: "To Mechanical Town",
    landRadius: 21, iceBlobs: 1, fireBlobs: 2, rivers: 1, rockDensity: 0.08,
    enemyCount: 15, itemCount: 12, safeRadius: 5,
    enemyStageWeights: { champion: 0.35, ultimate: 0.5, mega: 0.15 },
    hpMult: 1.6, dmgMult: 1.4, guardianHpMult: 3.0,
    requireFullClear: true,
    maxMegaTier: 1,
    // The same polished mirror surface as the Hall of Mirrors (see
    // cfg.mirrorFloor — same shine effect), but average grey instead of
    // light blue — river, ice and fire tiles are untouched. No
    // flowers/pebbles/etc — it's no longer a green tile.
    mirrorFloor: true,
    mirrorFloorColors: ["#7d7d7d", "#969696"],
    decorChanceMult: 0,
    // Grey, circuit-lit hard walls that creep one tile a second (see
    // map.js's machine generation and game.js's updateMachines/drawMachines)
    // — same HP as a reinforced Labyrinth wall (3 Mega-level hits). 30% of
    // the eligible floor, a lot more than a fixed handful.
    machineCoverage: 0.3,
    // The red/fire ground here actually hurts now, not just the global
    // 1 HP/sec every plain fire tile deals elsewhere.
    fireDamage: 5,
    typicality: "A polished mirror floor crawling with creeping machines — bring patience or firepower.",
    lore: "Once a bustling data-factory, Mechanical Town's rock piles are the rubble of machines that ground to a halt generations ago — though some of them, it turns out, never really stopped.",
  },
  {
    // Remade from scratch: no weighted random spawns at all — the only
    // enemies are Giga Digimon cloned by the 4 Cloning Machines (see
    // cfg.cloningCity, map.js's cloningMachines generation, and
    // updateCloningMachines/drawCloningMachines in game.js). The Guardian
    // (meant to be Tera — see the Labyrinth's identical fallback comment)
    // only appears once every clone is dead, which can only truly happen
    // once all 4 Machines are powered down for good.
    id: 6, name: "Cloning City", gateLabel: "To the Cloning City",
    landRadius: 22, iceBlobs: 0, fireBlobs: 3, rivers: 0, rockDensity: 0.06,
    cloningCity: true,
    enemyCount: 0, itemCount: 11, safeRadius: 5,
    enemyStageWeights: {},
    hpMult: 2.6, dmgMult: 2.1, guardianHpMult: 4.2,
    requireFullClear: true,
    maxMegaTier: 3,
    // No real Tera-stage Digimon exists in the scraped dataset (the
    // Giga->Tera reclassification never actually fires), so the "Tera"
    // Guardian this Sector was designed around falls back to the strongest
    // tier that's actually spawnable: Giga — same fix as the Labyrinth's.
    guardianStageOverride: "giga",
    // The red ground is tuned for Giga-level visitors: 2 HP/sec if you
    // are, 5 HP/sec if you're Mega or below — being underprepared here
    // actually costs you something (see tileDamagePerSecond).
    fireDamage: { giga: 2, lower: 5 },
    typicality: "Four Cloning Machines endlessly churn out Giga Digimon — destroy all 4 of a Machine's energy sources to shut it down for good.",
    lore: "Cloning City was once fertile server-farmland before a forgotten project rebuilt it as an endless Digimon foundry.",
  },
  {
    id: 7, name: "Hall of Mirrors", gateLabel: "To the Hall of Mirrors",
    landRadius: 22, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0.3,
    // Dense, indestructible shining glass instead of rock (see TILE.GLASS /
    // drawGlassShine) — reflects the player's own attacks back at them
    // (reversed direction, same remaining range/lifetime — see
    // updateProjectiles), but blocks enemy attacks like an ordinary wall.
    glassWalls: true,
    // The ground itself is a single, bright, polished mirror surface too
    // (see cfg.mirrorFloor / drawMirrorFloorShine) — no grass, no flowers.
    mirrorFloor: true,
    decorChanceMult: 0,
    // No weighted random spawns at all — exactly 5 Giga, nothing else.
    enemyCount: 0, itemCount: 11, safeRadius: 5,
    enemyStageWeights: {},
    guaranteedStageSpawns: { giga: 5 },
    // enemyStageWeights is empty (all 5 are the guaranteed Giga above), so
    // computeGuardianStage has nothing to go on — pin it directly, same
    // fix as the Labyrinth's Tera-falls-back-to-Giga Guardian.
    guardianStageOverride: "giga",
    // Enemies here never hurt each other (see explodeMega's noFriendlyFire
    // check) — only the player's own attacks count.
    noFriendlyFire: true,
    hpMult: 1.9, dmgMult: 1.6, guardianHpMult: 3.3,
    requireFullClear: true,
    maxMegaTier: 2,
    typicality: "A maze of shining, unbreakable glass over a single polished mirror floor — fire carefully, your own attacks bounce right back at you.",
    lore: "No one knows who built the Hall of Mirrors' endless glass walls, only that anything thrown inside eventually comes back.",
  },
  {
    id: 8, name: "The Nightfall Lands", gateLabel: "To the Nightfall Lands",
    landRadius: 22, iceBlobs: 1, fireBlobs: 1, rivers: 1, rockDensity: 0.1,
    enemyCount: 16, itemCount: 11, safeRadius: 5,
    enemyStageWeights: { ultimate: 0.45, mega: 0.55 },
    hpMult: 2.1, dmgMult: 1.75, guardianHpMult: 3.5,
    requireFullClear: true,
    maxMegaTier: 3,
    // This id (8) is a decoy: its own map is retired and never actually
    // visited. Its Village gate — still labeled "To the Nightfall Lands" —
    // is redirected to id 10, which is the real map (renamed back from
    // "Dark Area" after a naming mix-up — see id 10's comment below).
    // Since this id's own map is unreachable, it's excluded from "conquer
    // every Sector" (see requiredSectorsCount).
    gateTarget: 10,
    retired: true,
    typicality: "An urban maze of rubble — easy to get boxed in.",
    lore: "File City was the Digital World's greatest metropolis before a catastrophic data-corruption event left it in ruins.",
  },
  {
    id: 9, name: "The Crossing Fields", gateLabel: "To the Crossing Fields",
    landRadius: 24, iceBlobs: 2, fireBlobs: 2, rivers: 2, rockDensity: 0.08,
    enemyCount: 18, itemCount: 12, safeRadius: 5,
    enemyStageWeights: { ultimate: 0.3, mega: 0.6, giga: 0.1 },
    hpMult: 2.4, dmgMult: 2.0, guardianHpMult: 4.0,
    requireFullClear: true,
    maxMegaTier: 3,
    guaranteedStageSpawns: { giga: 3 }, // 3 Giga always roam here, on top of the weighted chance above
    // This place hits hard (hpMult/dmgMult above) — Vita Apple (heal) is
    // boosted well past its default weight of 15 so healing is actually
    // findable here (see foodWeightOverrides/pickFoodType in entities.js).
    foodWeightOverrides: { health: 45 },
    // The red/fire ground here actually hurts now, not just the global
    // 1 HP/sec every plain fire tile deals elsewhere (see
    // tileDamagePerSecond's placeCfg.fireDamage override).
    fireDamage: 5,
    typicality: "The greatest Guardian of all awaits at the World Tree — the pinnacle of Evolution: a Tera level Digimon.",
    lore: "At the base of the World Tree, the strongest Digimon gather to guard the roots of Yggdrasil itself.",
  },
  {
    id: 23, name: "Labyrinth", gateLabel: "To the Labyrinth",
    landRadius: 22, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0.42,
    enemyCount: 14, itemCount: 10, safeRadius: 4,
    enemyStageWeights: { champion: 0.5, ultimate: 0.5 },
    hpMult: 1.5, dmgMult: 1.3, guardianHpMult: 3.0,
    requireFullClear: true,
    hardWalls: true, // every wall here is the reinforced dark-grey material (see HARD_WALL_HP)
    guaranteedStageSpawns: { giga: 10 }, // 10 Giga roam the maze regardless of the weights above
    // No real Tera-stage Digimon exists in the scraped dataset (the
    // Giga->Tera reclassification never actually fires), so the "Tera"
    // Guardian this Sector was designed around falls back to the strongest
    // tier that's actually spawnable: Giga.
    guardianStageOverride: "giga",
    // Enemies here never hurt each other (see explodeMega's noFriendlyFire
    // check) — only the player's own attacks count.
    noFriendlyFire: true,
    guardianCube: true, // the Guardian waits inside a sealed cube of hard walls, not out in the open
    typicality: "A dense maze of reinforced rock walls — bring real firepower. Its Guardian waits sealed inside a cube of the toughest walls of all.",
    lore: "No one has ever mapped the Labyrinth's full layout; the walls are said to slowly rearrange themselves when no one is looking. At its heart, something ancient was sealed away behind walls no ordinary attack can break.",
  },
  {
    // The 21st crystal-bearing Sector. Its own Gate isn't in the usual
    // ring — it's placed one tile up-right of the Hall of Mirrors' own
    // Gate (see map.js's manualGatePlacement handling). Fully custom
    // encounter structure (no normal Guardian-trigger system at all — see
    // checkCrystalPalaceProgress in game.js): a dark-red, flame-heavy
    // field surrounds a 26x26 glass Castle at the dead center; its north
    // wall holds three stacked, key-locked doors (red/green/blue, dropped
    // by the Digital Abyss's, Chaos Zone's, and the Dark Area's own
    // bosses respectively). Once all three are held, the Castle's inner
    // 20x20 opens into a polished mirror arena: 8 Giga, then a boss: only
    // then does the 21st crystal drop and this Sector's own Gate unlock.
    id: 24, name: "Crystal Palace", gateLabel: "To the Crystal Palace",
    manualGatePlacement: "upperRightOfHallOfMirrors",
    isCrystalPalace: true,
    landRadius: 22, iceBlobs: 0, fireBlobs: 18, rivers: 0, rockDensity: 0,
    hazardGround: { grassDamage: 5, fireDamage: 10 },
    enemyCount: 0, itemCount: 20, safeRadius: 6,
    enemyStageWeights: {},
    hpMult: 3.0, dmgMult: 2.4, guardianHpMult: 5.5,
    maxMegaTier: 3,
    // Enemies here never hurt each other — only the player's own attacks
    // count (applies to the arena's 8 Giga and the final boss).
    noFriendlyFire: true,
    typicality: "A scorched, flame-choked field around a vast glass Castle — three keyed doors guard what's inside.",
    lore: "Legends call it the last vault of the Digital World's core code — sealed behind glass no ordinary force can break, and doors that answer to nothing but three stolen keys.",
  },
];

// Hidden extra-hard Sectors. Not shown as Village gates — reached only by
// destroying the specific rock that conceals each one's Gate.
const SECRET_SECTORS = [
  {
    // This is the real File City — its name was briefly "Dark Area" from an
    // earlier naming mix-up (the space-physics properties meant for the
    // void dimension were also wrongly applied here; both are now fixed).
    // Reached via id 8's redirected Village gate, still labeled "To File
    // City". Its own concealed gate (labeled "To the Dark Area", hidden
    // under a rock in the Village) leads to the actual Dark Area instead —
    // the pitch-black void dimension (see game.js's buildVoidLevelData).
    id: 10, name: "The Nightfall Lands", gateLabel: "To the Dark Area", secret: true,
    // Secret sectors normally skip the crystal drop entirely (see
    // onEnemyKilled in game.js) — this one is the exception: its Guardian
    // still drops a real Sector Crystal as a trophy, it just still doesn't
    // count toward requiredSectorsCount()/"conquer them all" (that filter
    // keys off `secret`, which stays true here on purpose).
    dropsCrystalEvenIfSecret: true,
    gateTarget: "void_dimension",
    landRadius: 18, iceBlobs: 0, fireBlobs: 4, rivers: 0, rockDensity: 0.1,
    enemyCount: 14, itemCount: 8, safeRadius: 5,
    enemyStageWeights: { ultimate: 0.35, mega: 0.65 },
    // Toned down from 2.6/2.1/4.2 — compounding with the enemy toughness
    // multipliers (Mega II/III x3, Giga x6) was producing tens of thousands
    // of HP, which felt like "nothing is happening" even though hits were
    // landing correctly. Ad hoc fix — revisit if it still feels off.
    hpMult: 1.4, dmgMult: 1.5, guardianHpMult: 2.2,
    requireFullClear: true,
    maxMegaTier: 3,
    // A level like any other — no space physics, no recoil. Those belong
    // to the actual Dark Area (the void dimension) only.
    // The red/fire ground here actually hurts now, not just the global
    // 1 HP/sec every plain fire tile deals elsewhere.
    fireDamage: 5,
    // Over the first 20s here, a smooth sunset sweep (orange -> red ->
    // darker red -> black) washes over everything, then stays fully dark
    // for the rest of the visit — see drawNightfallOverlay in game.js.
    nightfall: true,
    typicality: "An urban maze of rubble, swallowed by an endless, encroaching nightfall — easy to get boxed in, and soon impossible to see in.",
    lore: "File City was the Digital World's greatest metropolis before a catastrophic data-corruption event left it in ruins — and now, something is swallowing what's left of its light.",
  },
  {
    // Remade from scratch: a flat, fully open arena (no rocks, rivers, ice
    // or fire tiles of its own) whose every GRASS tile instead wears a
    // fast-cycling cosmetic skin (green/water/deep water/red/dark
    // red/ice/mirror/void-with-digits — see cfg.chaosSkin,
    // updateChaosSkin/drawChaosSkin in game.js) re-rolled roughly every 2
    // seconds, independently per tile. On top of that, big, varied,
    // fast-moving "chaos object" hazards (see cfg.hazardObjects, the same
    // generic subsystem as Gear Meadows' gears).
    id: 11, name: "Chaos Zone", gateLabel: "To the Chaos Zone", secret: true,
    landRadius: 18, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0,
    chaosSkin: true,
    hazardObjects: { count: 20, dmg: 30, icons: ["bolt", "skull", "star", "asteroid", "orb"], dirSet: 8, speedTiles: 8 },
    itemCount: 8, safeRadius: 5,
    // No weighted random spawns — exactly 10 Giga, nothing else.
    enemyCount: 0,
    enemyStageWeights: {},
    guaranteedStageSpawns: { giga: 10 },
    guardianStageOverride: "giga",
    hpMult: 2.9, dmgMult: 2.3, guardianHpMult: 4.5,
    requireFullClear: true,
    maxMegaTier: 3,
    typicality: "Every tile flickers between different looks, and huge chaos objects come flying out of nowhere — 10 Giga Digimon roam this madness.",
    lore: "Where the Digital World's rules break down entirely, the Chaos Zone can no longer even decide what its own ground looks like.",
  },
  {
    id: 12, name: "Digital Abyss", gateLabel: "To the Digital Abyss", secret: true,
    landRadius: 16, iceBlobs: 0, fireBlobs: 0, rivers: 0,
    // No walls at all — an open arena of dark-to-light purple.
    rockDensity: 0,
    enemyCount: 12, itemCount: 6, safeRadius: 5,
    enemyStageWeights: { mega: 1.0 },
    hpMult: 3.3, dmgMult: 2.6, guardianHpMult: 5.0,
    requireFullClear: true,
    maxMegaTier: 3,
    // Many shades of purple (deep violet to pale lavender), same
    // interpolateColor technique as Coral Reef's crystalline blue.
    grassColorRange: ["#1a0b33", "#b48cff"],
    // A tessellated 2x2-cell field of 10 big floating 0s/1s (see
    // makeDigitCell/updateDigitCell/drawDigitCell) — same size as the Dark
    // Area's/True Yggdrasil's own version (see DIGIT_FIELD_STYLE).
    digitField: true,
    // No flowers or other green-tile decor on the purple ground.
    decorChanceMult: 0,
    typicality: "Mega Digimon only. An open void of shifting purple, lit by drifting binary. The deepest secret of all.",
    lore: "The Digital Abyss is said to be the very bottom of the Digital World's code — only Mega Digimon survive here.",
  },
];

// 10 easier, beginner-friendly Sectors: no Ultimate/Mega enemies at all
// (Rookie/Champion ceiling), and far more digifood than the standard Sectors.
const EASY_SECTORS = [
  {
    id: 13, name: "Sunflower Fields", gateLabel: "To Sunflower Fields",
    landRadius: 20, iceBlobs: 0, fireBlobs: 0, rivers: 1, rockDensity: 0.02,
    enemyCount: 8, itemCount: 40, safeRadius: 5,
    enemyStageWeights: { baby1: 0.35, baby2: 0.35, rookie: 0.3 },
    hpMult: 0.5, dmgMult: 0.45, guardianHpMult: 1.6,
    beautify: 1.6,
    decorTypes: ["sunflower"], decorChanceMult: 3.2, // a field thick with sunflowers
    typicality: "Gentle and overflowing with digifood, and thick with sunflowers.",
    lore: "The oldest Baby Digimon nursery grounds, tended for generations, still bloom brightest here.",
  },
  {
    id: 14, name: "Coral Reef", gateLabel: "To the Coral Reef",
    // No rivers at all now — it's all shallow water (see hasWaterEffects).
    landRadius: 20, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0.02,
    enemyCount: 8, itemCount: 38, safeRadius: 5,
    enemyStageWeights: { baby1: 0.3, baby2: 0.3, rookie: 0.4 },
    hpMult: 0.55, dmgMult: 0.45, guardianHpMult: 1.6,
    // Shallow water instead of grass — walks just like normal ground —
    // crystalline blue with genuinely varied shades (deep to bright, see
    // grassColorRange/interpolateColor), corals and algae instead of
    // flowers (much denser than a normal Sector's decor via decorPerTile),
    // and a tessellating shoal of fish (see levelData.fish / drawFish).
    // The digifood fruits stay.
    grassColorRange: ["#063a63", "#4fd1ff"],
    decorTypes: ["coral", "coral", "coral", "algae"],
    decorPerTile: 8,
    hasFish: true,
    // One in every ~10 water tiles glimmers white for about a second, then
    // settles back to blue — see waterGlimmerFrac/drawWaterGlimmer.
    waterGlimmer: true,
    typicality: "Shallow, crystalline blue water you walk across like ordinary ground — dense corals, algae, and fish everywhere, and food grows everywhere too.",
    lore: "Digimon say the Coral Reef's rivers once carried the first data-eggs across the whole Digital World.",
  },
  {
    id: 15, name: "Grain Farm", gateLabel: "To the Grain Farm",
    landRadius: 20, iceBlobs: 0, fireBlobs: 0, rivers: 1, rockDensity: 0.025,
    enemyCount: 9, itemCount: 38, safeRadius: 5,
    enemyStageWeights: { baby2: 0.3, rookie: 0.5, champion: 0.2 },
    hpMult: 0.6, dmgMult: 0.5, guardianHpMult: 1.7,
    // Corn in three lean variants (left/straight/right), whose lean is
    // computed at draw time from position+time rather than baked in at
    // generation — that's what makes it ripple like a real grain wave
    // rolling toward the northeast (see drawDecoration's "corn" case).
    // 10 stalks per tile, each with a random sub-tile offset so the field
    // reads as one dense, continuous waving mass rather than a sparse
    // scatter (see decorPerTile).
    decorTypes: ["corn"], decorPerTile: 10,
    typicality: "A calm pasture, its tall grain rippling in dense waves toward the northeast.",
    lore: "A peaceful training ground where generations of Child-stage Digimon have learned to fight without ever truly getting hurt.",
  },
  {
    id: 16, name: "Botanical Garden", gateLabel: "To the Botanical Garden",
    landRadius: 21, iceBlobs: 0, fireBlobs: 0, rivers: 2, rockDensity: 0.025,
    enemyCount: 9, itemCount: 36, safeRadius: 5,
    enemyStageWeights: { baby2: 0.2, rookie: 0.5, champion: 0.3 },
    hpMult: 0.65, dmgMult: 0.55, guardianHpMult: 1.8,
    beautify: 1.5,
    // A fixed 10-flower arrangement tessellated identically across every
    // 2x2-tile cell of grass (see generateLevel's fixedFlowerPattern block)
    // instead of independent random placement.
    fixedFlowerPattern: true,
    typicality: "Lush and beautifully tended, carpeted edge-to-edge in a repeating flower pattern.",
    lore: "Cultivated by generations of Data-type Digimon, the Botanical Garden is the most carefully tended Sector in the world.",
  },
  {
    id: 17, name: "Sushi Island", gateLabel: "To Sushi Island",
    landRadius: 20, iceBlobs: 0, fireBlobs: 0, rivers: 1, rockDensity: 0.02,
    enemyCount: 8, itemCount: 40, safeRadius: 5,
    enemyStageWeights: { baby1: 0.2, baby2: 0.3, rookie: 0.5 },
    hpMult: 0.55, dmgMult: 0.45, guardianHpMult: 1.6,
    // The normal fruits still spawn here as usual (itemCount above). Sushi
    // is a SEPARATE, much denser layer on top — 90% of the still-free grass
    // tiles, each a big (2x) eat-and-it's-gone icon. Exactly +1 digicharge,
    // -1 HP, every time. Respawns like any other digifood otherwise.
    sushiOverlay: {
      coverage: 0.9,
      iconScale: 2,
      types: [
        { key: "sushi", color: "#f3f3f3", label: "Sushi", symbol: "🍣", energyRange: [1, 1], damage: 1, weight: 1 },
        { key: "sashimi", color: "#ff8a7a", label: "Sashimi", symbol: "🍤", energyRange: [1, 1], damage: 1, weight: 1 },
        { key: "nigiri", color: "#ffe066", label: "Nigiri", symbol: "🍙", energyRange: [1, 1], damage: 1, weight: 1 },
      ],
    },
    typicality: "Stuffed with the normal fruits, and almost every tile also has a huge piece of the best Sushi in the Digital World — but careful, eating too much is bad for your HP!",
    lore: "No one remembers who built this island, but every Digimon agrees its sushi is unbeatable — if you can stomach the cost.",
  },
  {
    id: 18, name: "Gear Meadows", gateLabel: "To Gear Meadows",
    landRadius: 21, iceBlobs: 0, fireBlobs: 0, rivers: 1, rockDensity: 0.03,
    enemyCount: 10, itemCount: 34, safeRadius: 5,
    enemyStageWeights: { rookie: 0.5, champion: 0.5 },
    hpMult: 0.7, dmgMult: 0.6, guardianHpMult: 1.9,
    // Big black gears, 8 tiles/s, cardinal-only (left-right/up-down),
    // 20 HP contact damage — see the generic hazard subsystem in game.js.
    hazardObjects: { count: 16, dmg: 20, icons: ["gear"], dirSet: 4, speedTiles: 8 },
    typicality: "A meadow full of gears — rolling grassy ones everywhere, and now a few loose black ones tearing across the field at speed.",
    lore: "The slow-turning gears beneath these meadows once powered a much larger machine, long since gone quiet — except for the handful that got loose.",
  },
  {
    id: 19, name: "Windy Desert", gateLabel: "To the Windy Desert",
    landRadius: 21, iceBlobs: 0, fireBlobs: 0, rivers: 0, rockDensity: 0.03,
    enemyCount: 10, itemCount: 34, safeRadius: 5,
    enemyStageWeights: { baby2: 0.2, rookie: 0.4, champion: 0.4 },
    hpMult: 0.7, dmgMult: 0.6, guardianHpMult: 1.9,
    // Sandy everywhere, and the wind (state.wind) picks one of 8 directions
    // every 5-10s, pushing every Digimon here — see updateWind/drawWindStreaks.
    grassColorOverride: "#d9bf7c",
    hasWind: true,
    typicality: "A windswept desert — every few seconds the wind shifts and pushes everyone with it.",
    lore: "An old toymaker Digimon is said to have built a workshop here once, long since buried and scoured smooth by the wind.",
  },
  {
    id: 20, name: "Starlight Riverside", gateLabel: "To the Starlight Riverside",
    landRadius: 20, iceBlobs: 0, fireBlobs: 0, rivers: 2, rockDensity: 0.02,
    enemyCount: 8, itemCount: 38, safeRadius: 5,
    enemyStageWeights: { baby1: 0.25, baby2: 0.25, rookie: 0.5 },
    hpMult: 0.5, dmgMult: 0.45, guardianHpMult: 1.6,
    // "Light clouds" — organic blobs of 30-50 green tiles each, strong
    // yellow at the core fading to more-transparent yellow at the edges,
    // drifting very slowly as a rigid shape. Many of them overlap so
    // roughly half of all green tiles are lit at any moment. See map.js's
    // lightClouds generation and updateLightClouds/buildLightCloudCoverage
    // in game.js.
    lightClouds: { count: 24 },
    // One in every ~5 water tiles glimmers white for about half a second,
    // then settles back to blue — see waterGlimmerFrac/drawWaterGlimmer.
    waterGlimmer: true,
    typicality: "A peaceful riverside, dappled with slow-drifting sunlight and glimmering water.",
    lore: "On clear nights, this shore reflects the Digital World's core code like stars — the same light that gathers in slow-drifting clouds over the grass by day and glimmers briefly across the water. A favorite resting spot for travelers.",
  },
  {
    id: 21, name: "Kindergarten Isle", gateLabel: "To Kindergarten Isle",
    landRadius: 19, iceBlobs: 0, fireBlobs: 0, rivers: 1, rockDensity: 0.015,
    enemyCount: 6, itemCount: 40, safeRadius: 5,
    enemyStageWeights: { baby1: 0.5, baby2: 0.5 },
    hpMult: 0.4, dmgMult: 0.35, guardianHpMult: 1.4,
    typicality: "The gentlest Sector of all — a nursery for new Digimon.",
    lore: "The gentlest island in the Digital World, set aside long ago as a nursery safe from all conflict — nowhere else will you find weaker, gentler Digimon.",
  },
  {
    id: 22, name: "Autumn Woods", gateLabel: "To the Autumn Woods",
    landRadius: 21, iceBlobs: 0, fireBlobs: 0, rivers: 1, rockDensity: 0.03,
    enemyCount: 10, itemCount: 34, safeRadius: 5,
    enemyStageWeights: { rookie: 0.45, champion: 0.55 },
    hpMult: 0.75, dmgMult: 0.65, guardianHpMult: 2.0,
    // 30% of the green tiles are trees now, not just a sparse lattice.
    treeCoverage: 0.3,
    // A single repeating 1x1-tile cell of 40 randomly-colored fallen
    // leaves (yellow/orange/red/brown), stamped on every grass tile —
    // see map.js's fixedLeafPattern block.
    fixedLeafPattern: true,
    typicality: "Quiet woodland, its ground carpeted edge-to-edge in fallen autumn leaves — the toughest of the easy Sectors.",
    lore: "The leaves here never finish falling — some say the season itself got stuck when the Digital World was young.",
  },
];

const ALL_SECTORS = [...SECTORS, ...SECRET_SECTORS, ...EASY_SECTORS];
VILLAGE.sectors = ALL_SECTORS; // so the map generator can lay out one gate per sector

// Live-tunable multipliers, edited via the in-game settings panel (key P).
// Kept separate from the sector definitions so "Reset" restores baseline.
const DG_DIFFICULTY_OVERRIDES = {};
for (const s of ALL_SECTORS) {
  DG_DIFFICULTY_OVERRIDES[s.id] = { enemyCountMult: 1, hpMult: 1, dmgMult: 1, guardianHpMult: 1 };
}
DG_DIFFICULTY_OVERRIDES.village = { enemyCountMult: 1, hpMult: 1, dmgMult: 1, guardianHpMult: 1 };

const AGGRO_RADIUS_TILES = 5;
const PLAYER_HIT_INVULN_MS = 500;
