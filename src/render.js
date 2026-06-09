// World rendering: map tiles + entities. Assumes ctx is already translated
// so world coordinates draw in the right place.

import { COLORS } from './config.js';
import { CELL, T } from './map.js';

export function drawMap(ctx, map, viewX, viewY, viewW, viewH) {
  const minCx = Math.max(0, Math.floor(viewX / CELL));
  const maxCx = Math.min(map.w - 1, Math.floor((viewX + viewW) / CELL));
  const minCy = Math.max(0, Math.floor(viewY / CELL));
  const maxCy = Math.min(map.h - 1, Math.floor((viewY + viewH) / CELL));

  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const t = map.at(cx, cy);
      const x = cx * CELL;
      const y = cy * CELL;
      switch (t) {
        case T.FLOOR:
          ctx.fillStyle = ((cx + cy) % 2 === 0) ? COLORS.FLOOR : COLORS.FLOOR_ALT;
          ctx.fillRect(x, y, CELL, CELL);
          break;
        case T.WALL:
          ctx.fillStyle = COLORS.WALL;
          ctx.fillRect(x, y, CELL, CELL);
          ctx.fillStyle = COLORS.WALL_EDGE;
          ctx.fillRect(x, y, CELL, 3);
          break;
        case T.WINDOW:
          ctx.fillStyle = COLORS.WALL;
          ctx.fillRect(x, y, CELL, CELL);
          ctx.fillStyle = COLORS.WINDOW;
          ctx.fillRect(x + 2, y + 4, CELL - 4, CELL - 8);
          break;
        case T.GEN:
          ctx.fillStyle = ((cx + cy) % 2 === 0) ? COLORS.FLOOR : COLORS.FLOOR_ALT;
          ctx.fillRect(x, y, CELL, CELL);
          break;
        case T.HOOK:
          ctx.fillStyle = ((cx + cy) % 2 === 0) ? COLORS.FLOOR : COLORS.FLOOR_ALT;
          ctx.fillRect(x, y, CELL, CELL);
          break;
        case T.GATE: {
          const gate = map.gates.find(g => g.cells.some(c => c.cx === cx && c.cy === cy));
          ctx.fillStyle = gate && gate.open ? COLORS.FLOOR : COLORS.GATE;
          ctx.fillRect(x, y, CELL, CELL);
          if (!(gate && gate.open)) {
            ctx.fillStyle = '#314531';
            ctx.fillRect(x, y + CELL / 2 - 2, CELL, 4);
          }
          break;
        }
      }
    }
  }

  drawEntities(ctx, map);
}

function drawEntities(ctx, map) {
  // Generators: yellow box with progress glow
  for (const g of map.generators) {
    const x = g.cx * CELL;
    const y = g.cy * CELL;
    ctx.fillStyle = g.done ? COLORS.GENERATOR_DONE : COLORS.GENERATOR;
    ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
    ctx.fillStyle = '#3a3014';
    ctx.fillRect(x + 5, y + 5, CELL - 10, CELL - 10);

    // Progress pips above gens that have been started
    if (!g.done && g.progress > 0.005) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x, y - 5, CELL, 3);
      ctx.fillStyle = g.regressing ? '#c0392b' : '#caa84e';
      ctx.fillRect(x, y - 5, CELL * g.progress, 3);
    }
    if (g.done) {
      // Lit generator glow
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = COLORS.GENERATOR_DONE;
      ctx.beginPath();
      ctx.arc(g.x, g.y, CELL * 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Hooks: post with a curve
  for (const h of map.hooks) {
    ctx.strokeStyle = COLORS.HOOK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(h.x, h.y + CELL / 2 - 2);
    ctx.lineTo(h.x, h.y - CELL / 2);
    ctx.arc(h.x + 4, h.y - CELL / 2, 4, Math.PI, Math.PI * 1.9);
    ctx.stroke();
  }

  // Hatch (visible only once open)
  if (map.hatch && map.hatch.open) {
    const hx = map.hatch.x;
    const hy = map.hatch.y;
    ctx.fillStyle = '#05050a';
    ctx.beginPath();
    ctx.ellipse(hx, hy, CELL * 0.7, CELL * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4a4a3a';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Faint glow so it can be spotted
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#c9c98a';
    ctx.beginPath();
    ctx.arc(hx, hy, CELL * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Pallets
  for (const p of map.pallets) {
    if (p.state === 'broken') continue;
    ctx.fillStyle = COLORS.PALLET;
    if (p.state === 'upright') {
      // Standing on edge: thin tall rectangle
      ctx.fillRect(p.x - 2, p.y - CELL / 2, 4, CELL);
    } else {
      // Dropped: flat across the cell
      ctx.fillRect(p.x - CELL / 2, p.y - CELL / 2, CELL, CELL);
      ctx.strokeStyle = '#5e4527';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const yy = p.y - CELL / 2 + (CELL / 4) * i;
        ctx.beginPath();
        ctx.moveTo(p.x - CELL / 2, yy);
        ctx.lineTo(p.x + CELL / 2, yy);
        ctx.stroke();
      }
    }
  }
}
