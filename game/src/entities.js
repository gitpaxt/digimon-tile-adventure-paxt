// Player / Enemy / Projectile / Item state + decision logic. Physics,
// collision and rendering live in game.js; this module owns "what an
// entity's stats/behavior should be", not "how the world resolves it".

const IconCache = new Map();
function getIcon(path) {
  if (!IconCache.has(path)) {
    const img = new Image();
    img.src = path;
    IconCache.set(path, img);
  }
  return IconCache.get(path);
}

const DIRS8 = [
  { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
  { dx: 0.7071, dy: 0.7071 }, { dx: -0.7071, dy: 0.7071 },
  { dx: 0.7071, dy: -0.7071 }, { dx: -0.7071, dy: -0.7071 },
  { dx: 0, dy: 0 }, // occasional pause
];
function randomDir() {
  return DIRS8[Math.floor(Math.random() * DIRS8.length)];
}
function normalize(dx, dy) {
  const len = Math.hypot(dx, dy);
  return len < 1e-6 ? { dx: 0, dy: 0, len: 0 } : { dx: dx / len, dy: dy / len, len };
}

function makeEntityBase(name, entryData, stage, x, y) {
  const stats = STAGE_STATS[stage];
  return {
    name, entryData, stage,
    x, y,
    hp: stats.hp, maxHp: stats.hp,
    facing: { dx: 0, dy: 1 },
    fireCooldownLeft: 0,
    icon: getIcon(entryData.iconPath),
    dead: false,
  };
}

function createPlayer(entryData, x, y) {
  const base = makeEntityBase(entryData.name, entryData, entryData.stage, x, y);
  return {
    ...base,
    kind: "player",
    energy: 0,
    score: 0,
    affinity: { Vaccine: 0, Data: 0, Virus: 0 },
    invulnLeft: 0,
    charging: null, // { dx, dy, startTime } while charging a Mega sun sphere
    megaChargeFrac: 0,
    sprinting: false,
    megaPower: 0, // instance-only meter: fills from red/green/yellow/white fruit while stage === 'mega'
    megaTier: 1, // 1/2/3 — Mega I/II/III; not a species property, resets each time you (re-)become Mega
    keys: { red: false, green: false, blue: false }, // Crystal Palace's three door keys
  };
}

function evolvePlayer(player, newEntryData) {
  const wasMega = player.stage === "mega";
  player.name = newEntryData.name;
  player.entryData = newEntryData;
  player.stage = newEntryData.stage;
  player.icon = getIcon(newEntryData.iconPath);
  const stats = STAGE_STATS[player.stage];
  if (!stats) console.warn(`[evolvePlayer] no STAGE_STATS entry for stage "${player.stage}" (from ${newEntryData.name})`);
  player.maxHp = stats ? stats.hp : player.maxHp;
  player.hp = player.maxHp; // full heal on evolution, as a reward
  if (player.stage === "mega" && !wasMega) {
    player.megaPower = 0;
    player.megaTier = 1;
  }
}

function createEnemy(entryData, alignment, isGuardian, x, y, placeCfg, diffOverride) {
  const base = makeEntityBase(entryData.name, entryData, entryData.stage, x, y);
  const stats = STAGE_STATS[entryData.stage];

  // Mega I/II/III is per-instance, not a species trait — a WarGreymon might
  // be any of the three depending on who you meet. Each place's
  // `maxMegaTier` is its ceiling; the Guardian is always at that ceiling.
  let megaTier = null;
  if (entryData.stage === "mega") {
    const cap = placeCfg.maxMegaTier || 1;
    megaTier = isGuardian ? cap : 1 + Math.floor(Math.random() * cap);
  }

  // Enemy-only toughness: their attack power is untouched, they just take a
  // lot more killing at the higher tiers (see ENEMY_TOUGHNESS_MULT).
  let toughnessMult = 1;
  if (entryData.stage === "mega" && megaTier >= 2) toughnessMult = ENEMY_TOUGHNESS_MULT.megaTier2Plus;
  else if (entryData.stage === "giga") toughnessMult = ENEMY_TOUGHNESS_MULT.giga;
  else if (entryData.stage === "tera") toughnessMult = ENEMY_TOUGHNESS_MULT.tera;
  else if (entryData.stage === "peta") toughnessMult = ENEMY_TOUGHNESS_MULT.peta;

  const hpMult = placeCfg.hpMult * diffOverride.hpMult * (isGuardian ? placeCfg.guardianHpMult * diffOverride.guardianHpMult : 1) * toughnessMult;
  const dmgMult = placeCfg.dmgMult * diffOverride.dmgMult;
  base.maxHp = Math.round(stats.hp * hpMult);
  base.hp = base.maxHp;

  return {
    ...base,
    kind: "enemy",
    alignment, // 'pacific' | 'hostile' | 'guardian'
    isGuardian,
    guardedByPlayerOnly: isGuardian, // Guardians take damage only from the player, never other enemies' splash
    dmgMult,
    megaTier, // null unless stage === 'mega'
    wanderDir: randomDir(),
    wanderTimer: 1 + Math.random() * 2,
    provoked: false, // pacific-only: flips true once attacked, then fights back (renders yellow)
    fleeing: false, fleeUntil: 0, // panics and sprints away when hit by a strictly-stronger attacker
    moveSpeedMult: 1, // the "red alert" Guardian entrance sets this below 1 (slow but a level stronger)
    energyReward: Math.round(ENERGY_REWARDS[entryData.stage] * (isGuardian ? 3 : 1)),
    scoreReward: Math.round(SCORE_REWARDS[entryData.stage] * (isGuardian ? 3 : 1)),
  };
}

function enemyContourColor(enemy) {
  if (enemy.alignment === "guardian") return "#b545ff";
  if (enemy.fleeing) return "#5fb4ff";
  if (enemy.alignment === "hostile") return "#ff3b3b";
  return enemy.provoked ? "#ffe066" : "#3ddc55"; // pacific: green, or yellow once provoked
}

// Called when `enemy` takes damage from an attacker of `attackerStage`: if
// the attacker is strictly stronger (higher evolution stage), the enemy
// panics and flees at a speed boost for a while instead of fighting back.
function maybeStartFlee(enemy, attackerStage, now) {
  if (DG_DATA.stageIndex(attackerStage) > DG_DATA.stageIndex(enemy.stage)) {
    enemy.fleeing = true;
    enemy.fleeUntil = now + FLEE_DURATION_MS;
    return true;
  }
  return false;
}

// Decide this frame's desired movement/fire intent for an enemy. Physics
// application + collision happens in game.js.
function decideEnemyAction(enemy, player, dtSec, now) {
  const ddx = player.x - enemy.x, ddy = player.y - enemy.y;
  const dist = Math.hypot(ddx, ddy);

  if (enemy.fleeing && now < enemy.fleeUntil) {
    const away = dist > 1 ? normalize(-ddx, -ddy) : randomDir();
    return { moveDx: away.dx, moveDy: away.dy, wantFire: false, speedMult: FLEE_SPEED_MULT };
  }
  if (enemy.fleeing) enemy.fleeing = false;

  const aggroRange = AGGRO_RADIUS_TILES * TILE_SIZE;
  const isAggressive = enemy.alignment === "hostile" || enemy.alignment === "guardian" || enemy.provoked;

  // Chase only within the same range that triggers aggro in the first place —
  // step far enough away (out of sight) and pursuit stops. (No extra "dist > 1"
  // guard here: normalize() already safely returns {0,0,0} for near-zero
  // distance, so that guard only ever caused a real bug — once an enemy
  // closes to melee range, it was landing right on the ~1px boundary every
  // frame, oscillating in and out of this branch and almost never having a
  // frame where both "close enough" and "cooldown ready" lined up, so it
  // would stop attacking entirely right when it caught up to the player.)
  // alwaysPursue (the Yggdrasil Tera Guardians — see spawnFinaleTeraSwarm)
  // ignores the aggro-range cutoff entirely: it never loses the player no
  // matter how far away, though it still only actually fires within the
  // normal range below.
  if (isAggressive && (enemy.alwaysPursue || dist < aggroRange)) {
    const dir = normalize(ddx, ddy);
    const wantFire = dist < aggroRange && enemy.fireCooldownLeft <= 0;
    return { moveDx: dir.dx, moveDy: dir.dy, wantFire, fireDx: dir.dx, fireDy: dir.dy, speedMult: 1 };
  }
  enemy.wanderTimer -= dtSec;
  if (enemy.wanderTimer <= 0) {
    enemy.wanderDir = randomDir();
    enemy.wanderTimer = 1 + Math.random() * 2;
  }
  return { moveDx: enemy.wanderDir.dx * 0.5, moveDy: enemy.wanderDir.dy * 0.5, wantFire: false, speedMult: 0.6 };
}

function createProjectile(owner, dirx, diry, opts = {}) {
  const stats = STAGE_STATS[owner.stage];
  const dmgMult = owner.dmgMult ?? 1;
  return {
    x: owner.x, y: owner.y,
    vx: dirx * (opts.speed ?? stats.projSpeed),
    vy: diry * (opts.speed ?? stats.projSpeed),
    radius: opts.radius ?? stats.projRadius,
    color: opts.color ?? stats.projColor,
    dmg: opts.dmg ?? Math.round(stats.dmg * dmgMult),
    ownerKind: owner.kind,
    owner,
    type: opts.type ?? stats.projType,
    traveled: 0,
    maxRange: (opts.rangeTiles ?? stats.projRangeTiles ?? 6) * TILE_SIZE,
    chargeFrac: opts.chargeFrac ?? 1,
    dead: false,
  };
}

// `weightOverrides` (from a place's config, e.g. Toy Town's white-fruit
// abundance) replaces individual FOOD_TYPES weights by key for this pick.
// `foodPool` lets a Sector swap in a completely different food set (e.g.
// Sushi Island's sushi/sashimi/nigiri) instead of just reweighting the
// normal fruit; `weightOverrides` only ever applies within whichever pool
// is in play.
function pickFoodType(weightOverrides, foodPool) {
  const pool = foodPool || FOOD_TYPES;
  let total = 0;
  const weights = pool.map((f) => (weightOverrides && weightOverrides[f.key] != null ? weightOverrides[f.key] : f.weight));
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    if (r < weights[i]) return pool[i];
    r -= weights[i];
  }
  return pool[pool.length - 1];
}

function createItem(x, y, weightOverrides, foodPool) {
  const food = pickFoodType(weightOverrides, foodPool);
  const item = { x, y, kind: "item", food, radius: 14, dead: false };
  if (food.heal) {
    const [lo, hi] = food.healRange;
    item.healAmount = Math.round(lo + Math.random() * (hi - lo));
  } else {
    const [lo, hi] = food.energyRange || DIGIFOOD_ENERGY;
    item.energy = Math.round(lo + Math.random() * (hi - lo));
  }
  return item;
}
