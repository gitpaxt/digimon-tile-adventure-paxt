// Procedural 50x50 tile map generation: grass / river / fire / ice / sea /
// rock (destructible) / village / gate-locked / gate-active. Deterministic
// per (place, seed) via a small seeded PRNG.
//
// World topology: the Village has one always-open Gate per Sector (arranged
// in a ring) plus a few hidden Gates concealed under ordinary-looking rocks,
// leading to secret Sectors. Every non-village Sector has exactly one Gate
// of its own, locked until that Sector's Guardian is defeated; stepping
// through it returns you to the Village.

const TILE = {
  GRASS: "grass",
  RIVER: "river",
  FIRE: "fire",
  ICE: "ice",
  SEA: "sea",
  ROCK: "rock",
  VILLAGE: "village",
  PORTAL: "portal", // active gate
  GATE_LOCKED: "gate_locked", // a sector's own gate, before its Guardian is defeated
  TREE: "tree", // destructible; burns instead of clearing to grass when destroyed
  BURNING_TREE: "burning_tree", // walkable, but damages anyone nearby for 20s before clearing to grass
  VOID: "void", // deep black, frictionless floor of the void dimension
  GLASS: "glass", // indestructible; reflects the player's own attacks (Mirror Dimension) — see game.js
};

const ROCK_MAX_HP = 20;
const TREE_HP = 20;
const TREE_BURN_MS = 20000;
const TREE_BURN_DAMAGE_PER_SEC = 5;
const TREE_BURN_RADIUS_TILES = 1.5;
const DECOR_TYPES = ["flower", "flower2", "rose_red", "rose_white", "tuft", "pebble", "shrub"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap multi-octave sine "value noise" - good enough for blobby coastlines
// and grass-shade variation, no need for a full Perlin implementation here.
function makeNoise2D(rng) {
  const octaves = [1, 2, 3].map(() => ({
    fx: (rng() * 2 - 1) * 0.15,
    fy: (rng() * 2 - 1) * 0.15,
    phase: rng() * Math.PI * 2,
  }));
  return function noise2(x, y) {
    let v = 0;
    for (const o of octaves) v += Math.sin(x * o.fx + y * o.fy + o.phase);
    return v / octaves.length; // roughly in [-1, 1]
  };
}

function inBounds(x, y, size) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

function stampCircle(tiles, size, cx, cy, radius, type, overwriteTypes) {
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(size - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(size - 1, Math.ceil(cx + radius)); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2 && overwriteTypes.has(tiles[y][x])) {
        tiles[y][x] = type;
      }
    }
  }
}

function carveRiver(tiles, size, rng, isLand) {
  let x = null;
  for (let attempt = 0; attempt < 50 && x === null; attempt++) {
    const tx = Math.floor(rng() * size);
    for (let ty = 0; ty < size; ty++) {
      if (isLand(tx, ty)) { x = tx; break; }
    }
  }
  if (x === null) return;
  let fx = x;
  const width = 1;
  for (let y = 0; y < size; y++) {
    fx += (rng() - 0.5) * 2.2;
    const ix = Math.round(fx);
    for (let dx = -width; dx <= width; dx++) {
      const px = ix + dx;
      if (inBounds(px, y, size) && isLand(px, y)) tiles[y][px] = TILE.RIVER;
    }
    if (!inBounds(ix, y, size)) break;
  }
}

function generateLevel(placeCfg, seed) {
  const size = 50;
  const rng = mulberry32(seed);
  const noise = makeNoise2D(rng);
  const shadeNoise = makeNoise2D(rng);
  const cx = size / 2, cy = size / 2;

  const tiles = Array.from({ length: size }, () => Array.from({ length: size }, () => TILE.SEA));
  const baseRadius = placeCfg.landRadius ?? 20;
  const isLand = (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    const edge = baseRadius + noise(x, y) * 4.5;
    return d < edge;
  };

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (isLand(x, y)) tiles[y][x] = TILE.GRASS;

  for (const [type, count, minR, maxR] of [
    [TILE.ICE, placeCfg.iceBlobs || 0, 4, 9],
    [TILE.FIRE, placeCfg.fireBlobs || 0, 4, 9],
  ]) {
    for (let i = 0; i < count; i++) {
      let bx, by, tries = 0;
      do { bx = Math.floor(rng() * size); by = Math.floor(rng() * size); tries++; } while (!isLand(bx, by) && tries < 200);
      const radius = minR + rng() * (maxR - minR);
      stampCircle(tiles, size, bx, by, radius, type, new Set([TILE.GRASS, TILE.ICE, TILE.FIRE]));
    }
  }

  // Freezeland-style Sectors: on top of the ice blobs above, convert a big
  // fraction of whatever grass is left directly to ice — "much more ice".
  if (placeCfg.iceCoverageFrac) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] === TILE.GRASS && rng() < placeCfg.iceCoverageFrac) tiles[y][x] = TILE.ICE;
      }
    }
  }

  if (placeCfg.rivers) for (let i = 0; i < placeCfg.rivers; i++) carveRiver(tiles, size, rng, isLand);

  // spawn point: search outward from map center for a plain, safe grass tile
  let spawn = placeCfg.fixedSpawn || null;
  if (!spawn) {
    outer: for (let radius = 0; radius < size; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (inBounds(x, y, size) && tiles[y][x] === TILE.GRASS) { spawn = { x, y }; break outer; }
        }
      }
    }
  }
  if (!spawn) spawn = { x: Math.floor(cx), y: Math.floor(cy) };

  // Crystal Palace: "one appears on the right-down corner" — search
  // outward from the south-east point of the land circle instead of the
  // map center, same algorithm as the normal spawn search above.
  if (placeCfg.isCrystalPalace) {
    const targetX = Math.round(cx + baseRadius * 0.75), targetY = Math.round(cy + baseRadius * 0.75);
    corner: for (let radius = 0; radius < size; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = targetX + dx, y = targetY + dy;
          if (inBounds(x, y, size) && tiles[y]?.[x] === TILE.GRASS) { spawn = { x, y }; break corner; }
        }
      }
    }
  }

  const reserved = new Set(); // tile coords that must NOT be overwritten by random rocks
  const markReserved = (x, y) => reserved.add(`${x},${y}`);

  const portals = [];
  const concealedGates = new Map(); // "x,y" -> { targetSectorId, label }
  let sectorGate = null;
  const rockHP = new Map(); // declared early: concealed-gate rocks need an HP entry too
  const wallMaterial = new Map(); // "x,y" -> "hard" for the reinforced Labyrinth material; absent = ordinary rock
  const sealedInterior = new Set(); // tiles inside a guardianCube — excluded from allWalkable so nothing spawns inside a sealed room
  let guardianCubeCenter = null;

  // Crystal Palace: a 26x26 "Castle" of indestructible glass/mirror walls
  // dead center, overwriting whatever terrain generation would otherwise
  // put there, placed BEFORE the Sector's own Gate below so that gate is
  // never accidentally sealed inside it. The inner 20x20 stays glass
  // (impassable, and — since GLASS is a hard BFS blocker — automatically
  // excluded from allWalkable below, exactly like the guardianCube's
  // sealed interior) until all three keys are held; see
  // revealCrystalPalaceArena in game.js. Three stacked door tiles (red,
  // green, blue, north to south) sit in the north wall's 3-tile thickness
  // at the castle's central column, each one only passable once its
  // matching key is held (see isWalkableAt's door check).
  const crystalDoors = new Map(); // "x,y" -> "red" | "green" | "blue"
  let castleBounds = null;
  if (placeCfg.isCrystalPalace) {
    const ccx = Math.round(cx), ccy = Math.round(cy);
    const outerHalf = 13, innerHalf = 10; // 26x26 outer, 20x20 inner => 3-tile wall
    for (let dy = -outerHalf; dy < outerHalf; dy++) {
      for (let dx = -outerHalf; dx < outerHalf; dx++) {
        const x = ccx + dx, y = ccy + dy;
        if (!inBounds(x, y, size)) continue;
        tiles[y][x] = TILE.GLASS;
        markReserved(x, y);
      }
    }
    castleBounds = {
      outerStartX: ccx - outerHalf, outerEndX: ccx + outerHalf,
      outerStartY: ccy - outerHalf, outerEndY: ccy + outerHalf,
      innerStartX: ccx - innerHalf, innerEndX: ccx + innerHalf,
      innerStartY: ccy - innerHalf, innerEndY: ccy + innerHalf,
    };
    const doorX = ccx, doorTopY = ccy - outerHalf;
    crystalDoors.set(`${doorX},${doorTopY}`, "red");
    crystalDoors.set(`${doorX},${doorTopY + 1}`, "green");
    crystalDoors.set(`${doorX},${doorTopY + 2}`, "blue");
  }

  let homeostasisBlock = null;
  if (placeCfg.isVillage) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (inBounds(spawn.x + dx, spawn.y + dy, size)) { tiles[spawn.y + dy][spawn.x + dx] = TILE.VILLAGE; markReserved(spawn.x + dx, spawn.y + dy); }

    // Homeostasis's iridescent block, four tiles north of the hatch point —
    // approaching it the first time triggers the intro Deep Explanation.
    const hbx = spawn.x, hby = spawn.y - 4;
    if (inBounds(hbx, hby, size)) { markReserved(hbx, hby); homeostasisBlock = { x: hbx, y: hby }; }

    // one Gate per visible Sector, arranged in a ring around the Village —
    // except any `manualGatePlacement` Sector (currently just Crystal
    // Palace), which sits out of the ring and gets placed afterward,
    // relative to another specific Sector's gate tile.
    const allVisible = placeCfg.sectors.filter((s) => !s.secret);
    const visible = allVisible.filter((s) => !s.manualGatePlacement);
    const manuallyPlaced = allVisible.filter((s) => s.manualGatePlacement);
    const gateRadius = 11;
    let hallOfMirrorsGate = null;
    visible.forEach((sector, i) => {
      const angle = (i / visible.length) * Math.PI * 2 - Math.PI / 2;
      const gx = Math.round(spawn.x + Math.cos(angle) * gateRadius);
      const gy = Math.round(spawn.y + Math.sin(angle) * gateRadius);
      if (inBounds(gx, gy, size)) {
        tiles[gy][gx] = TILE.PORTAL;
        markReserved(gx, gy);
        portals.push({ x: gx, y: gy, targetSectorId: sector.gateTarget ?? sector.id, label: sector.gateLabel, secret: false });
        if (sector.id === 7) hallOfMirrorsGate = { x: gx, y: gy };
      }
    });
    for (const sector of manuallyPlaced) {
      if (sector.manualGatePlacement === "upperRightOfHallOfMirrors" && hallOfMirrorsGate) {
        const gx = hallOfMirrorsGate.x + 1, gy = hallOfMirrorsGate.y - 1;
        if (inBounds(gx, gy, size) && !reserved.has(`${gx},${gy}`)) {
          tiles[gy][gx] = TILE.PORTAL;
          markReserved(gx, gy);
          portals.push({ x: gx, y: gy, targetSectorId: sector.gateTarget ?? sector.id, label: sector.gateLabel, secret: false });
        }
      }
    }

    // hidden Gates: ordinary-looking rocks that conceal a secret Sector's Gate
    const secret = placeCfg.sectors.filter((s) => s.secret);
    let placedSecret = 0, attempts = 0;
    while (placedSecret < secret.length && attempts < 400) {
      attempts++;
      const angle = rng() * Math.PI * 2;
      const dist = 10 + rng() * (baseRadius - 3);
      const hx = Math.round(spawn.x + Math.cos(angle) * dist);
      const hy = Math.round(spawn.y + Math.sin(angle) * dist);
      if (!inBounds(hx, hy, size) || tiles[hy][hx] !== TILE.GRASS) continue;
      const key = `${hx},${hy}`;
      if (reserved.has(key)) continue;
      tiles[hy][hx] = TILE.ROCK;
      markReserved(hx, hy);
      rockHP.set(key, ROCK_MAX_HP);
      concealedGates.set(key, { targetSectorId: secret[placedSecret].gateTarget ?? secret[placedSecret].id, label: secret[placedSecret].gateLabel });
      placedSecret++;
    }
  } else {
    // a single Gate somewhere out in the Sector, locked until the Guardian
    // falls — retried against `reserved` (so it can never land inside
    // Crystal Palace's Castle, already carved and reserved above) and SEA,
    // falling back to the unguarded single-roll behavior only if every
    // attempt fails.
    let finalX = null, finalY = null;
    for (let tries = 0; tries < 60 && finalX === null; tries++) {
      const angle = rng() * Math.PI * 2;
      const dist = baseRadius * (0.55 + rng() * 0.25);
      const gx = Math.round(cx + Math.cos(angle) * dist);
      const gy = Math.round(cy + Math.sin(angle) * dist);
      if (!inBounds(gx, gy, size) || !tiles[gy]?.[gx] || tiles[gy][gx] === TILE.SEA) continue;
      if (reserved.has(`${gx},${gy}`)) continue;
      finalX = gx; finalY = gy;
    }
    if (finalX === null) { finalX = Math.round(cx); finalY = Math.round(cy); }
    tiles[finalY][finalX] = TILE.GATE_LOCKED;
    markReserved(finalX, finalY);
    sectorGate = { x: finalX, y: finalY, active: false };
  }

  // Crystal Palace: every tile outside the Castle (and other than the
  // Gate itself, just reserved above) becomes real FIRE ground — "dark
  // red" with the full hazardGround fire damage — so nothing but the
  // Castle interrupts the flames. Must run after the Gate is placed, so
  // that one tile is correctly skipped.
  if (placeCfg.isCrystalPalace) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] === TILE.SEA || tiles[y][x] === TILE.GLASS || tiles[y][x] === TILE.GATE_LOCKED) continue;
        tiles[y][x] = TILE.FIRE;
      }
    }
  }

  // The Guardian's cube: a sealed 3x3 room ringed by reinforced walls,
  // placed away from spawn/the sector gate. The interior is carved out now
  // (before the BFS below) so it's on record as reachable once a wall
  // eventually falls, but it's excluded from allWalkable further down so
  // nothing but the Guardian itself ever appears inside it.
  if (placeCfg.guardianCube) {
    const angle = rng() * Math.PI * 2;
    const dist = baseRadius * (0.25 + rng() * 0.3);
    const ccx = Math.round(cx + Math.cos(angle) * dist);
    const ccy = Math.round(cy + Math.sin(angle) * dist);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = ccx + dx, y = ccy + dy;
        if (!inBounds(x, y, size)) continue;
        const key = `${x},${y}`;
        markReserved(x, y);
        if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) {
          tiles[y][x] = TILE.ROCK;
          wallMaterial.set(key, "hard");
          rockHP.set(key, HARD_WALL_HP);
        } else {
          tiles[y][x] = TILE.GRASS;
          sealedInterior.add(key);
        }
      }
    }
    guardianCubeCenter = { x: ccx * TILE_SIZE + TILE_SIZE / 2, y: ccy * TILE_SIZE + TILE_SIZE / 2 };
  }

  // rocks: scattered obstacles, kept clear of the safe zone around spawn and reserved tiles
  const safeR2 = (placeCfg.safeRadius ?? 4) ** 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = tiles[y][x];
      if (t !== TILE.GRASS && t !== TILE.ICE && t !== TILE.FIRE) continue;
      if (reserved.has(`${x},${y}`)) continue;
      const dx = x - spawn.x, dy = y - spawn.y;
      if (dx * dx + dy * dy < safeR2) continue;
      if (rng() < (placeCfg.rockDensity ?? 0.02)) {
        if (placeCfg.glassWalls) {
          // Mirror Dimension: shining, indestructible glass — no rockHP
          // entry at all, so damageRockAt/isWalkableAt never treat it as
          // breakable. Reflecting the player's attacks is handled in
          // game.js's updateProjectiles.
          tiles[y][x] = TILE.GLASS;
        } else {
          tiles[y][x] = TILE.ROCK;
          if (placeCfg.hardWalls) {
            wallMaterial.set(`${x},${y}`, "hard");
            rockHP.set(`${x},${y}`, HARD_WALL_HP);
          } else {
            rockHP.set(`${x},${y}`, ROCK_MAX_HP);
          }
        }
      }
    }
  }

  // Trees: a fixed lattice (basis (3,0) and (1,2) — so (0,0), (3,0), (1,2)
  // and every integer combination of those two are tree tiles) that makes
  // it hard to walk in a straight line. `density` thins the lattice out for
  // Sectors that just want a handful of trees rather than a full forest.
  if (placeCfg.treeLattice) {
    const density = placeCfg.treeLattice.density ?? 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        if (reserved.has(`${x},${y}`)) continue;
        const dx = x - spawn.x, dy = y - spawn.y;
        if (dx * dx + dy * dy < safeR2) continue;
        if (y % 2 !== 0 || (x - y / 2) % 3 !== 0) continue;
        if (rng() >= density) continue;
        tiles[y][x] = TILE.TREE;
        rockHP.set(`${x},${y}`, TREE_HP);
      }
    }
  }

  // Autumn Woods: a true "X% of green tiles" random tree scatter — a
  // direct per-tile probability, independent of the treeLattice basis
  // above. Runs before any decoration stamping below, so a tile that
  // becomes a tree here never gets grass decor in the first place.
  if (placeCfg.treeCoverage) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        if (reserved.has(`${x},${y}`)) continue;
        const dx = x - spawn.x, dy = y - spawn.y;
        if (dx * dx + dy * dy < safeR2) continue;
        if (rng() < placeCfg.treeCoverage) {
          tiles[y][x] = TILE.TREE;
          rockHP.set(`${x},${y}`, TREE_HP);
        }
      }
    }
  }


  // Connectivity: BFS from spawn, treating SEA as the only hard blocker (a
  // Rock is destructible, so it never actually blocks reachability). Without
  // this, the coastline/river noise can carve off small disconnected
  // "islands" that are technically grass but impossible to walk to — and an
  // enemy or Guardian spawning there would be permanently unreachable.
  const reachable = new Set([`${spawn.x},${spawn.y}`]);
  const bfsQueue = [[spawn.x, spawn.y]];
  while (bfsQueue.length) {
    const [cx0, cy0] = bfsQueue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx0 + dx, ny = cy0 + dy;
      if (!inBounds(nx, ny, size)) continue;
      const key = `${nx},${ny}`;
      // SEA and GLASS are the only hard blockers for reachability — a Rock
      // is destructible so it never actually seals anything off, but Glass
      // (Mirror Dimension) never breaks, so a pocket walled in by it is
      // truly unreachable and must be excluded from allWalkable below.
      if (reachable.has(key) || tiles[ny][nx] === TILE.SEA || tiles[ny][nx] === TILE.GLASS) continue;
      reachable.add(key);
      bfsQueue.push([nx, ny]);
    }
  }

  // decorative, non-colliding detail props on grass (denser if `beautify` is
  // set; a Sector can swap in its own themed pool via `decorTypes`, e.g.
  // Sunflower Fields' sunflowers or the Grain Farm's corn). `decorPerTile`
  // switches from "maybe one, by chance" to "exactly N, clustered with
  // random sub-tile offsets" — e.g. the Grain Farm's 10-stalks-per-tile.
  const decorations = [];
  const decorPool = placeCfg.decorTypes || DECOR_TYPES;
  // hazardGround Sectors (Fire Sector, Crystal Palace, etc.): every grass
  // tile is dangerous "red"/"dark red" ground at generation time (the
  // only exception, safeGround, is only ever revealed later by breaking a
  // wall) — flowers and other decor growing out of lava made no sense, so
  // skip decoration entirely here.
  if (!placeCfg.hazardGround) {
  if (placeCfg.decorPerTile) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        for (let i = 0; i < placeCfg.decorPerTile; i++) {
          decorations.push({
            x, y, type: decorPool[Math.floor(rng() * decorPool.length)], seed: rng(),
            ox: (rng() - 0.5) * TILE_SIZE * 1.3, oy: (rng() - 0.5) * TILE_SIZE * 1.3,
          });
        }
      }
    }
  } else {
    const decorChance = 0.05 * (placeCfg.beautify ?? 1) * (placeCfg.decorChanceMult ?? 1);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        if (rng() < decorChance) {
          decorations.push({ x, y, type: decorPool[Math.floor(rng() * decorPool.length)], seed: rng() });
        }
      }
    }
  }
  }

  // Botanical Garden ONLY: one fixed 12-flower micro-pattern, defined once
  // as fractional offsets within a SINGLE tile, stamped identically onto
  // EVERY grass tile — a truly repeating tile, not randomness or a
  // multi-tile cell (that's deliberately not used anywhere else).
  if (placeCfg.fixedFlowerPattern) {
    const TWELVE_FLOWER_PATTERN = [
      { fx: 0.12, fy: 0.15, type: "flower" }, { fx: 0.5, fy: 0.08, type: "rose_red" },
      { fx: 0.85, fy: 0.18, type: "flower2" }, { fx: 0.3, fy: 0.3, type: "rose_white" },
      { fx: 0.65, fy: 0.32, type: "flower" }, { fx: 0.92, fy: 0.45, type: "rose_red" },
      { fx: 0.08, fy: 0.5, type: "flower2" }, { fx: 0.45, fy: 0.55, type: "rose_white" },
      { fx: 0.78, fy: 0.68, type: "flower" }, { fx: 0.18, fy: 0.78, type: "rose_red" },
      { fx: 0.55, fy: 0.85, type: "flower2" }, { fx: 0.88, fy: 0.9, type: "rose_white" },
    ];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        for (const p of TWELVE_FLOWER_PATTERN) {
          decorations.push({ x, y, type: p.type, seed: 0.5, ox: (p.fx - 0.5) * TILE_SIZE, oy: (p.fy - 0.5) * TILE_SIZE });
        }
      }
    }
  }

  // Autumn Woods ONLY: the same single-tile-repeat technique, generalized
  // with per-leaf randomized color/position instead of a fixed hand-placed
  // layout — 40 fallen leaves (yellow/orange/red/brown, picked at random
  // for each of the 40, not just all one color) in one ideal 1x1 cell,
  // stamped identically onto every grass tile. Independent 40-leaf
  // patterns stack on top per tile: 50% of tiles also get a second layer
  // (80 total), and — independently, drawn from ALL green tiles including
  // ones already in that 50% — 20% of tiles get two MORE layers on top of
  // that, for 160 total (overriding the 40/80 split for just that 20%).
  if (placeCfg.fixedLeafPattern) {
    const LEAF_COLORS = ["#e8c84a", "#e08a2e", "#c23b2e", "#7a4a26"];
    const makeLeafPattern = () => Array.from({ length: 40 }, () => ({
      fx: rng(), fy: rng(), color: LEAF_COLORS[Math.floor(rng() * LEAF_COLORS.length)], rot: rng() * Math.PI * 2,
    }));
    const LEAF_PATTERN = makeLeafPattern();
    const LEAF_PATTERN_EXTRA = makeLeafPattern();
    const LEAF_PATTERN_EXTRA2 = makeLeafPattern();
    const LEAF_PATTERN_EXTRA3 = makeLeafPattern();
    const stampLeaves = (x, y, pattern) => {
      for (const leaf of pattern) {
        decorations.push({ x, y, type: "leaf", color: leaf.color, seed: leaf.rot, ox: (leaf.fx - 0.5) * TILE_SIZE, oy: (leaf.fy - 0.5) * TILE_SIZE });
      }
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        if (rng() < 0.2) {
          stampLeaves(x, y, LEAF_PATTERN);
          stampLeaves(x, y, LEAF_PATTERN_EXTRA);
          stampLeaves(x, y, LEAF_PATTERN_EXTRA2);
          stampLeaves(x, y, LEAF_PATTERN_EXTRA3);
        } else {
          stampLeaves(x, y, LEAF_PATTERN);
          if (rng() < 0.5) stampLeaves(x, y, LEAF_PATTERN_EXTRA);
        }
      }
    }
  }

  // Superseded by the tile-based "light clouds" below for Starlight
  // Riverside (no Sector currently sets `sunPatches`) — kept, not deleted.
  const sunPatches = [];
  if (placeCfg.sunPatches) {
    const worldPx = size * TILE_SIZE;
    for (let i = 0; i < 9; i++) {
      const angle = rng() * Math.PI * 2;
      sunPatches.push({
        x0: rng() * worldPx, y0: rng() * worldPx,
        vx: Math.cos(angle) * (4 + rng() * 8), vy: Math.sin(angle) * (4 + rng() * 8),
        radius: (2.5 + rng() * 2.5) * TILE_SIZE,
        alpha: 0.12 + rng() * 0.22,
      });
    }
  }

  // Starlight Riverside's "light clouds": organic blobs of 30-50 TILES
  // (grown by a random walk from a seed tile, like real cloud shapes, not
  // a smooth circle), strong yellow at the core fading to more-transparent
  // yellow at the edges, drifting very slowly as one rigid shape and
  // wrapping at the map's edges. Enough of them overlap that roughly half
  // of all green tiles are lit at any given moment (see drawLightClouds-
  // adjacent code in game.js: updateLightClouds/buildLightCloudCoverage).
  const lightClouds = [];
  if (placeCfg.lightClouds) {
    const CLOUD_COUNT = placeCfg.lightClouds.count ?? 16;
    for (let c = 0; c < CLOUD_COUNT; c++) {
      const targetSize = 30 + Math.floor(rng() * 21); // 30..50 tiles
      const members = [{ dx: 0, dy: 0 }];
      const occupied = new Set(["0,0"]);
      const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let attempts = 0;
      while (members.length < targetSize && attempts < targetSize * 20) {
        attempts++;
        const base = members[Math.floor(rng() * members.length)];
        const [ddx, ddy] = DIRS4[Math.floor(rng() * 4)];
        const nx = base.dx + ddx, ny = base.dy + ddy;
        const key = `${nx},${ny}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        members.push({ dx: nx, dy: ny });
      }
      const ccx = members.reduce((s, m) => s + m.dx, 0) / members.length;
      const ccy = members.reduce((s, m) => s + m.dy, 0) / members.length;
      let maxDist = 0;
      for (const m of members) maxDist = Math.max(maxDist, Math.hypot(m.dx - ccx, m.dy - ccy));
      for (const m of members) {
        const t = maxDist > 0 ? Math.hypot(m.dx - ccx, m.dy - ccy) / maxDist : 0;
        // A real solid core, not just the single centroid tile — every
        // tile within 40% of the cloud's radius is fully opaque (alpha 1,
        // "really really yellow, zero transparency"), then fades down to
        // a more-transparent yellow at the outer edge.
        m.alpha = t < 0.4 ? 1 : 1 - ((t - 0.4) / 0.6) * 0.85;
      }
      const angle = rng() * Math.PI * 2;
      // Seeded within the actual land circle (not the full square grid) —
      // otherwise half of every cloud's tiles would land out on open sea.
      // sqrt(rng()) spreads origins evenly across the disk's AREA instead
      // of clustering them near the center (which would just pile clouds
      // on top of each other and waste most of their coverage to overlap).
      const originAngle = rng() * Math.PI * 2, originDist = Math.sqrt(rng()) * baseRadius * 0.92;
      lightClouds.push({
        tx: cx + Math.cos(originAngle) * originDist, ty: cy + Math.sin(originAngle) * originDist,
        vtx: Math.cos(angle) * (0.4 + rng() * 0.6), // tiles/sec — 10x the original speed
        vty: Math.sin(angle) * (0.4 + rng() * 0.6),
        members,
      });
    }
  }

  // Coral Reef's shoal of bright, translucent fish: each one's "real"
  // position lives inside one ideal, periodic 2x2-tile cell (wrapping at
  // its edges), and at draw time that same cell is tessellated across the
  // *entire* rendered world — on land and over open sea alike (see
  // drawFish) — rather than 20 fish wandering one finite pond.
  const FISH_COLORS = ["#ff3b3b", "#ffd23f", "#33d17a", "#2f9bff", "#a855f7"];
  const fish = [];
  if (placeCfg.hasFish) {
    const cell = 2 * TILE_SIZE;
    for (let i = 0; i < 20; i++) {
      fish.push({
        x: rng() * cell, y: rng() * cell,
        angle: rng() * Math.PI * 2, speed: 10 + rng() * 18,
        turnPhase: rng() * 1000, seed: rng(),
        color: FISH_COLORS[i % FISH_COLORS.length],
      });
    }
  }

  // Generic periodic-cell floating 0s/1s: 10 big digits with their "real"
  // position inside one ideal 2x2-tile cell (wrapping at its edges), then
  // that same cell is tessellated across the *entire* rendered world at
  // draw time (see drawDigitCell in game.js) — the same technique as Coral
  // Reef's fish above, reused generically so any place can opt in via
  // `placeCfg.digitField` (color/size are chosen per place at draw time).
  const digitCell = [];
  if (placeCfg.digitField) {
    const dcell = 2 * TILE_SIZE;
    for (let i = 0; i < 10; i++) {
      digitCell.push({
        x: rng() * dcell, y: rng() * dcell,
        vx: (rng() * 2 - 1) * (10 + rng() * 10),
        vy: (rng() * 2 - 1) * (10 + rng() * 10),
        ch: rng() < 0.5 ? "0" : "1",
      });
    }
  }

  // Factorial Town's machines: grey, circuit-lit hard walls (same HP as a
  // reinforced Labyrinth wall — 3 Mega-level hits) that creep one tile a
  // second instead of sitting still. Kept as free-floating entities (not
  // baked into the static `tiles` grid) so they can move independently;
  // game.js's isWalkableAt/updateProjectiles treat their current tile as
  // blocking just like a wall.
  const machines = [];
  if (placeCfg.movingMachines || placeCfg.machineCoverage) {
    const candidates = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        const dx = x - spawn.x, dy = y - spawn.y;
        if (dx * dx + dy * dy < safeR2) continue;
        candidates.push({ x, y });
      }
    }
    shuffle(candidates, rng);
    // `machineCoverage` (a fraction, e.g. 0.3 for "30% of the floor") scales
    // with map size; `movingMachines` is a plain fixed count.
    const count = placeCfg.machineCoverage != null
      ? Math.round(candidates.length * placeCfg.machineCoverage)
      : Math.min(placeCfg.movingMachines, candidates.length);
    for (let i = 0; i < count; i++) {
      const spot = candidates[i];
      const vertical = rng() < 0.7; // mostly up/down, per the brief
      const dir = vertical ? (rng() < 0.5 ? { dx: 0, dy: -1 } : { dx: 0, dy: 1 }) : (rng() < 0.5 ? { dx: -1, dy: 0 } : { dx: 1, dy: 0 });
      machines.push({
        x: spot.x, y: spot.y, hp: HARD_WALL_HP, maxHp: HARD_WALL_HP,
        dirDx: dir.dx, dirDy: dir.dy,
        stepTimer: rng(), // desynced so they don't all tick in lockstep
        stepsTaken: 0, stepsUntilTurn: 15 + Math.floor(rng() * 11),
        seed: rng(),
      });
    }
  }

  // Cloning City: 4 Cloning Machines at the 4 cardinal edges of the board,
  // each fed by 4 destructible energy sources (pushed into the shared
  // `machines` array as stationary entries, so they get all the normal
  // machine damage/collision/draw plumbing for free — see
  // drawMachines/drawCloningMachines in game.js). Each Machine clones the
  // same one Giga Digimon over and over, every 10s, for as long as at
  // least one of its 4 sources is still alive (see updateCloningMachines).
  const cloningMachines = [];
  // The one recurring "nemesis" Digimon — reappears at a random still-
  // powered Machine every time it's killed (see onEnemyKilled), and is
  // also the exact same species as the final boss at the very end (see
  // checkCloningCityBoss) — always this one memorized species, never a
  // fresh random pick.
  let cloningBossSpecies = null;
  if (placeCfg.cloningCity) {
    cloningBossSpecies = DG_DATA.pickRandomByStage("giga");
    const ENERGY_SOURCE_HP = Math.round(HARD_WALL_HP * 0.5);
    const edgeAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // N, E, S, W
    for (let i = 0; i < 4; i++) {
      const angle = edgeAngles[i];
      const mx = Math.round(cx + Math.cos(angle) * baseRadius * 0.85);
      const my = Math.round(cy + Math.sin(angle) * baseRadius * 0.85);
      const species = DG_DATA.pickRandomByStage("giga");
      cloningMachines.push({ index: i, x: mx, y: my, species, spawnTimer: rng() * 7 });
      const offsets = [[-3, 0], [3, 0], [0, -3], [0, 3]];
      for (const [odx, ody] of offsets) {
        const ex = mx + odx, ey = my + ody;
        if (!inBounds(ex, ey, size)) continue;
        machines.push({ x: ex, y: ey, hp: ENERGY_SOURCE_HP, maxHp: ENERGY_SOURCE_HP, stationary: true, kind: "energySource", cloningIndex: i, seed: rng() });
      }
    }
  }

  // Generic big-icon moving hazards (Gear Meadows' gears, Chaos Zone's
  // chaos objects, etc.) — continuous (non-grid-stepped) movement, pure
  // contact damage, never blocks. See updateHazards/drawHazards in game.js.
  const hazards = [];
  if (placeCfg.hazardObjects) {
    const { count, dmg, icons, dirSet, speedTiles } = placeCfg.hazardObjects;
    const speed = (speedTiles ?? 8) * TILE_SIZE;
    const candidatesH = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] !== TILE.GRASS) continue;
        const dx = x - spawn.x, dy = y - spawn.y;
        if (dx * dx + dy * dy < safeR2) continue;
        candidatesH.push({ x, y });
      }
    }
    shuffle(candidatesH, rng);
    const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
    const dirsPool = dirSet === 8 ? DIRS8 : DIRS4;
    const n = Math.min(count, candidatesH.length);
    for (let i = 0; i < n; i++) {
      const spot = candidatesH[i];
      const [dx, dy] = dirsPool[Math.floor(rng() * dirsPool.length)];
      hazards.push({
        x: spot.x * TILE_SIZE + TILE_SIZE / 2, y: spot.y * TILE_SIZE + TILE_SIZE / 2,
        dirDx: dx, dirDy: dy, speed, dmg,
        kind: icons[Math.floor(rng() * icons.length)],
        seed: rng(), rot: rng() * Math.PI * 2,
      });
    }
  }

  // Perennial fire animation (see drawFlame) on a fraction of the FIRE
  // tiles — 80% of the "dark red" ones (hazardGround-reclassified, #4a0a04
  // — currently only the Fire Sector) and 20% of the plain "red" ones
  // (#8a2b12, the un-reclassified FIRE color most other fireBlobs Sectors
  // use, e.g. Sarba Continent) — decided once at generation time so it
  // stays stable per tile instead of flickering every frame.
  const fireAnimated = new Set();
  const fireAnimChance = placeCfg.isCrystalPalace ? 1 : placeCfg.hazardGround ? 0.8 : 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (tiles[y][x] === TILE.FIRE && rng() < fireAnimChance) fireAnimated.add(`${x},${y}`);
    }
  }
  // hazardGround Sectors' "light red" ground (reclassified GRASS, not the
  // "dark red" FIRE tiles above) gets the same 20% flame chance that plain
  // "red" FIRE tiles get everywhere else (e.g. Sarba Continent) — some
  // flames on the ordinary scorching ground too, not just the lava.
  if (placeCfg.hazardGround) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (tiles[y][x] === TILE.GRASS && rng() < 0.2) fireAnimated.add(`${x},${y}`);
      }
    }
  }

  // per-tile grass shade (stable noise-based variation, purely cosmetic)
  const grassShade = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => (shadeNoise(x * 1.7, y * 1.7) + 1) / 2)
  );

  // candidate walkable tiles for spawning enemies/items — must also be
  // reachable (see BFS above), or nothing would ever guarantee a spawn
  // isn't stranded on a disconnected pocket.
  const allWalkable = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = tiles[y][x];
      if (t === TILE.SEA || t === TILE.ROCK || t === TILE.TREE || t === TILE.VILLAGE || t === TILE.PORTAL || t === TILE.GATE_LOCKED) continue;
      if (!reachable.has(`${x},${y}`)) continue;
      if (sealedInterior.has(`${x},${y}`)) continue;
      allWalkable.push({ x, y });
    }
  }
  const walkable = allWalkable.filter(({ x, y }) => {
    const dx = x - spawn.x, dy = y - spawn.y;
    return dx * dx + dy * dy >= safeR2 * 1.5;
  });
  shuffle(walkable, rng);

  const enemyCount = placeCfg.enemyCount ?? 0;
  const itemCount = placeCfg.itemCount ?? 0;
  const enemySpawns = walkable.slice(0, enemyCount);
  const itemSpawns = walkable.slice(enemyCount, enemyCount + itemCount);

  return {
    size, tiles, rockHP, spawn,
    enemySpawns, itemSpawns,
    portals, concealedGates, sectorGate,
    decorations, grassShade,
    allWalkable,
    homeostasisBlock,
    wallMaterial, guardianCubeCenter,
    burningTiles: new Map(), // "x,y" -> expiresAtMs, populated as trees are burned down
    safeGround: new Set(), // "x,y" tiles revealed by breaking a wall in a hazardGround Sector — never damaging
    fish,
    digitCell,
    sunPatches,
    lightClouds,
    machines,
    fireAnimated,
    hazards,
    cloningMachines,
    cloningBossSpecies,
    crystalDoors,
    castleBounds,
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// A steady trickle — barely felt by a Mega+ with hundreds of HP, but a real
// hazard for anyone still small who lingers too long in the lava.
function tileDamagePerSecond(type, placeCfg, playerStage) {
  if (type !== TILE.FIRE) return 0;
  const fd = placeCfg?.fireDamage;
  // Cloning City: the ground itself is tuned for Giga-level visitors (2
  // HP/sec) — anyone Mega or below takes more (5 HP/sec), so being
  // underprepared for this Sector actually means something, not just
  // "every Sector's fire feels the same".
  if (fd && typeof fd === "object") {
    return DG_DATA.stageIndex(playerStage) >= DG_DATA.stageIndex("giga") ? fd.giga : fd.lower;
  }
  return fd ?? 1;
}

// `riverSlowMult` (from the current place's config) lets specific water
// Sectors have noticeably stronger currents than the default river.
function tileSpeedMultiplier(type, riverSlowMult) {
  if (type === TILE.RIVER) return riverSlowMult ?? 0.8;
  return 1.0;
}
