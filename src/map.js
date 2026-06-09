// Procedural map generation, DBD-style: a coarse grid of zones, each filled
// with a prefab "tile" (loop structure) or left open. Templates contain
// candidate spots for generators, pallets, windows and hooks; after stamping,
// we keep a budgeted number of each and turn the rest into plain floor/wall.

import { METER, GAME } from './config.js';
import { createRng } from './rng.js';

export const CELL = METER;       // 1 cell = 1 meter = 16 px

// Grid cell values
export const T = {
  FLOOR: 0,
  WALL: 1,
  WINDOW: 2,   // solid, vaultable
  GEN: 3,      // solid, repairable from adjacent cells
  HOOK: 4,     // solid
  GATE: 5,     // solid until opened
};

// 12x12 prefab templates. Legend: '.' floor, '#' wall, 'W' window,
// 'P' pallet (floor + pallet entity), 'G' gen candidate, 'H' hook candidate.
const TEMPLATES = [
  [ // killer shack
    '............',
    '..########..',
    '..#......#..',
    '..#......#..',
    '..W......#..',
    '..#......#..',
    '..#......#..',
    '..####P###..',
    '............',
    '......H.....',
    '............',
    '............',
  ],
  [ // L-wall with window
    '............',
    '..########..',
    '..#.........',
    '..#.........',
    '..#....G....',
    '..W.........',
    '..#.........',
    '..########..',
    '............',
    '.........H..',
    '............',
    '............',
  ],
  [ // pallet gym: parallel walls
    '............',
    '.#########..',
    '.........P..',
    '.#########..',
    '............',
    '.....G......',
    '............',
    '.####W####..',
    '............',
    '..H.........',
    '............',
    '............',
  ],
  [ // debris field: rocks and a pallet
    '............',
    '............',
    '...##.......',
    '...##....P..',
    '.........#..',
    '.........#..',
    '...G........',
    '.##.........',
    '.##...##....',
    '......##H...',
    '............',
    '............',
  ],
  [ // long wall with pallet gap
    '............',
    '............',
    '..####P####.',
    '............',
    '............',
    '......G.....',
    '............',
    '............',
    '.....H......',
    '............',
    '............',
    '............',
  ],
  [ // open field
    '............',
    '............',
    '............',
    '.....G......',
    '............',
    '............',
    '........H...',
    '............',
    '............',
    '............',
    '............',
    '............',
  ],
];

const ZONE = 14;          // zone size in cells (12 template + 2 padding)
const ZONES_X = 6;
const ZONES_Y = 4;
export const MAP_W = ZONES_X * ZONE + 2;  // +2 for border walls
export const MAP_H = ZONES_Y * ZONE + 2;

const HOOK_BUDGET = 8;
const PALLET_BUDGET = 9;

export function generateMap(seed) {
  const rng = createRng(seed);
  const grid = new Uint8Array(MAP_W * MAP_H);

  const map = {
    seed,
    w: MAP_W,
    h: MAP_H,
    grid,
    generators: [],   // {cx, cy, x, y, progress, done}
    pallets: [],      // {cx, cy, x, y, state: 'upright'|'dropped'|'broken'}
    windows: [],      // {cx, cy, x, y}
    hooks: [],        // {cx, cy, x, y, occupied}
    gates: [],        // {cells: [{cx,cy}], x, y, side, progress, open}
    survivorSpawn: null,
    killerSpawn: null,

    at(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return T.WALL;
      return grid[cy * MAP_W + cx];
    },
    set(cx, cy, v) {
      grid[cy * MAP_W + cx] = v;
    },
    isSolid(cx, cy) {
      const t = map.at(cx, cy);
      if (t === T.GATE) {
        const gate = map.gates.find(g => g.cells.some(c => c.cx === cx && c.cy === cy));
        return !(gate && gate.open);
      }
      return t !== T.FLOOR;
    },
  };

  // Border walls
  for (let x = 0; x < MAP_W; x++) { map.set(x, 0, T.WALL); map.set(x, MAP_H - 1, T.WALL); }
  for (let y = 0; y < MAP_H; y++) { map.set(0, y, T.WALL); map.set(MAP_W - 1, y, T.WALL); }

  // Stamp a shuffled template into each zone
  const genCandidates = [];
  const hookCandidates = [];
  const palletCandidates = [];

  let templateOrder = [];
  for (let zy = 0; zy < ZONES_Y; zy++) {
    for (let zx = 0; zx < ZONES_X; zx++) {
      if (templateOrder.length === 0) templateOrder = rng.shuffle(TEMPLATES);
      const tpl = templateOrder.pop();
      const ox = 1 + zx * ZONE + 1;
      const oy = 1 + zy * ZONE + 1;
      for (let ty = 0; ty < 12; ty++) {
        for (let tx = 0; tx < 12; tx++) {
          const ch = tpl[ty][tx];
          const cx = ox + tx;
          const cy = oy + ty;
          switch (ch) {
            case '#': map.set(cx, cy, T.WALL); break;
            case 'W': map.set(cx, cy, T.WINDOW); map.windows.push(cellEntity(cx, cy)); break;
            case 'P': palletCandidates.push({ cx, cy }); break;
            case 'G': genCandidates.push({ cx, cy }); break;
            case 'H': hookCandidates.push({ cx, cy }); break;
          }
        }
      }
    }
  }

  // Budget generators: pick well-spread candidates
  for (const c of pickSpread(rng.shuffle(genCandidates), GAME.GENERATORS_TOTAL, 16)) {
    map.set(c.cx, c.cy, T.GEN);
    map.generators.push({ ...cellEntity(c.cx, c.cy), progress: 0, done: false });
  }

  // Budget hooks
  for (const c of pickSpread(rng.shuffle(hookCandidates), HOOK_BUDGET, 12)) {
    map.set(c.cx, c.cy, T.HOOK);
    map.hooks.push({ ...cellEntity(c.cx, c.cy), occupied: false });
  }

  // Budget pallets (cell stays floor; the entity carries state)
  for (const c of rng.shuffle(palletCandidates).slice(0, PALLET_BUDGET)) {
    map.pallets.push({ ...cellEntity(c.cx, c.cy), state: 'upright' });
  }

  // Two exit gates on opposite borders, 3 cells wide
  placeGate(map, rng, 'top');
  placeGate(map, rng, 'bottom');

  // Spawns: survivor near one corner, killer near the opposite
  map.survivorSpawn = findOpenNear(map, 4, 4);
  map.killerSpawn = findOpenNear(map, MAP_W - 5, MAP_H - 5);

  return map;
}

function cellEntity(cx, cy) {
  return { cx, cy, x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL };
}

// Greedy max-spread pick: take candidates that are at least minDist cells
// from every already-picked one; relax if we run out.
function pickSpread(candidates, count, minDist) {
  const picked = [];
  let dist = minDist;
  while (picked.length < count && dist >= 0) {
    for (const c of candidates) {
      if (picked.length >= count) break;
      if (picked.includes(c)) continue;
      if (picked.every(p => Math.hypot(p.cx - c.cx, p.cy - c.cy) >= dist)) {
        picked.push(c);
      }
    }
    dist -= 4;
  }
  return picked;
}

function placeGate(map, rng, side) {
  const y = side === 'top' ? 0 : MAP_H - 1;
  const start = rng.int(8, MAP_W - 12);
  const cells = [];
  for (let i = 0; i < 3; i++) {
    map.set(start + i, y, T.GATE);
    cells.push({ cx: start + i, cy: y });
  }
  map.gates.push({
    cells,
    x: (start + 1.5) * CELL,
    y: (y + 0.5) * CELL,
    side,
    progress: 0,
    open: false,
  });
}

function findOpenNear(map, cx, cy) {
  // Spiral out until we find a floor cell
  for (let r = 0; r < Math.max(MAP_W, MAP_H); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (map.at(x, y) === T.FLOOR) {
          return { x: (x + 0.5) * CELL, y: (y + 0.5) * CELL };
        }
      }
    }
  }
  return { x: (MAP_W / 2) * CELL, y: (MAP_H / 2) * CELL };
}

/**
 * Resolve a circle of `radius` at proposed position (x, y) against solid
 * cells by pushing it out of any overlapping cell AABB. Gives natural
 * wall sliding and never wedges. (fromX/fromY kept for call-site symmetry.)
 */
export function collideWithMap(map, fromX, fromY, x, y, radius) {
  const r = radius + 0.01; // epsilon so the resolved position is stable
  let px = x;
  let py = y;
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    const minCx = Math.floor((px - r) / CELL);
    const maxCx = Math.floor((px + r) / CELL);
    const minCy = Math.floor((py - r) / CELL);
    const maxCy = Math.floor((py + r) / CELL);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!map.isSolid(cx, cy)) continue;
        const x0 = cx * CELL;
        const y0 = cy * CELL;
        const closestX = Math.max(x0, Math.min(px, x0 + CELL));
        const closestY = Math.max(y0, Math.min(py, y0 + CELL));
        const dx = px - closestX;
        const dy = py - closestY;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 === 0) {
          // Center inside the box: push out along the axis of least penetration
          const bx = x0 + CELL / 2;
          const by = y0 + CELL / 2;
          if (Math.abs(px - bx) > Math.abs(py - by)) {
            px = px > bx ? x0 + CELL + r : x0 - r;
          } else {
            py = py > by ? y0 + CELL + r : y0 - r;
          }
        } else {
          const d = Math.sqrt(d2);
          px = closestX + (dx / d) * r;
          py = closestY + (dy / d) * r;
        }
        pushed = true;
      }
    }
    if (!pushed) break;
  }
  return { x: px, y: py };
}

/** Line of sight between two world points, sampled against solid cells. */
export function hasLineOfSight(map, x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(dist / (CELL / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = Math.floor((x0 + (x1 - x0) * t) / CELL);
    const cy = Math.floor((y0 + (y1 - y0) * t) / CELL);
    const tile = map.at(cx, cy);
    if (tile === T.WALL || tile === T.GATE) return false;
  }
  return true;
}
