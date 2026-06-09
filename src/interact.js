// Finds the closest available interaction for the survivor.

import { CELL } from './map.js';

const GEN_RANGE = 1.6 * CELL;

export function findInteraction(world) {
  const s = world.survivor;

  // Generators
  let best = null;
  let bestDist = Infinity;
  for (const g of world.map.generators) {
    if (g.done) continue;
    const d = Math.hypot(g.x - s.x, g.y - s.y);
    if (d < GEN_RANGE && d < bestDist) {
      best = { type: 'repair', target: g, label: 'Repair generator' };
      bestDist = d;
    }
  }

  return best;
}
