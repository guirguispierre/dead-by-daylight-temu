// Grid A* with diagonal movement (no corner cutting) plus line-of-sight
// path smoothing. The map is small (~86x58) so a plain array open list
// with lazy sorting is plenty fast.

import { CELL } from './map.js';

// Samples a line against SOLID cells (not vision: windows and generators
// are see-through but block movement, so smoothing must use solidity).
function walkableLine(map, x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(dist / (CELL / 4));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.floor((x0 + (x1 - x0) * t) / CELL);
    const cy = Math.floor((y0 + (y1 - y0) * t) / CELL);
    if (map.isSolid(cx, cy)) return false;
  }
  return true;
}

// Body clearance: the center line plus two lines offset perpendicular by
// `radius` must all be walkable, so a circle of that radius can travel the
// segment without snagging corners.
function hasClearLine(map, x0, y0, x1, y1, radius) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  if (d === 0) return true;
  const px = -(y1 - y0) / d * radius;
  const py = (x1 - x0) / d * radius;
  return walkableLine(map, x0, y0, x1, y1) &&
         walkableLine(map, x0 + px, y0 + py, x1 + px, y1 + py) &&
         walkableLine(map, x0 - px, y0 - py, x1 - px, y1 - py);
}

export function findPath(map, fromX, fromY, toX, toY, radius = CELL * 0.45) {
  const sx = Math.floor(fromX / CELL);
  const sy = Math.floor(fromY / CELL);
  let tx = Math.floor(toX / CELL);
  let ty = Math.floor(toY / CELL);

  // If target cell is solid (e.g. a generator), path to a walkable neighbor
  if (map.isSolid(tx, ty)) {
    const n = nearestWalkable(map, tx, ty);
    if (!n) return null;
    tx = n.cx;
    ty = n.cy;
  }
  if (map.isSolid(sx, sy)) {
    const n = nearestWalkable(map, sx, sy);
    if (n) { /* start from neighbor */ }
  }

  const w = map.w;
  const key = (cx, cy) => cy * w + cx;
  const open = [{ cx: sx, cy: sy, g: 0, f: 0 }];
  const gScore = new Map([[key(sx, sy), 0]]);
  const cameFrom = new Map();
  const closed = new Set();

  while (open.length > 0) {
    // Pop lowest f
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.cx, cur.cy);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (cur.cx === tx && cur.cy === ty) {
      return smooth(map, reconstruct(cameFrom, cur, key, w), radius);
    }

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.cx + dx;
        const ny = cur.cy + dy;
        if (map.isSolid(nx, ny)) continue;
        // No cutting corners diagonally past a solid cell
        if (dx !== 0 && dy !== 0 &&
            (map.isSolid(cur.cx + dx, cur.cy) || map.isSolid(cur.cx, cur.cy + dy))) {
          continue;
        }
        const nk = key(nx, ny);
        if (closed.has(nk)) continue;
        const cost = (dx !== 0 && dy !== 0) ? Math.SQRT2 : 1;
        const g = cur.g + cost;
        if (g < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, g);
          cameFrom.set(nk, ck);
          const hCost = Math.hypot(nx - tx, ny - ty);
          open.push({ cx: nx, cy: ny, g, f: g + hCost });
        }
      }
    }
  }
  return null; // unreachable
}

function nearestWalkable(map, cx, cy) {
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!map.isSolid(cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
      }
    }
  }
  return null;
}

function reconstruct(cameFrom, end, key, w) {
  const path = [];
  let k = key(end.cx, end.cy);
  while (k !== undefined) {
    path.push({ x: ((k % w) + 0.5) * CELL, y: (Math.floor(k / w) + 0.5) * CELL });
    k = cameFrom.get(k);
  }
  path.reverse();
  return path;
}

// Drop intermediate waypoints when the body can travel directly between
// them (clearance-aware, so corners don't snag the moving circle).
function smooth(map, path, radius) {
  if (path.length <= 2) return path;
  const out = [path[0]];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    if (!hasClearLine(map, path[anchor].x, path[anchor].y, path[i].x, path[i].y, radius)) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}
