// Finds the closest available interaction for the survivor.
// Priority: pallets (drop/vault) > window vault > generator > self-heal,
// so mid-chase inputs always favor the escape move.

import { CELL } from './map.js';

const GEN_RANGE = 1.6 * CELL;
const PALLET_RANGE = 1.4 * CELL;
const WINDOW_RANGE = 1.4 * CELL;

export function findInteraction(world) {
  const s = world.survivor;

  // Pallets: drop an upright one, vault a dropped one
  let best = null;
  let bestDist = Infinity;
  for (const p of world.map.pallets) {
    if (p.state === 'broken') continue;
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d < PALLET_RANGE && d < bestDist) {
      best = p.state === 'upright'
        ? { type: 'drop-pallet', target: p, label: 'Drop pallet' }
        : { type: 'vault', target: p, label: 'Vault pallet' };
      bestDist = d;
    }
  }
  if (best) return best;

  // Windows
  bestDist = Infinity;
  for (const wd of world.map.windows) {
    const d = Math.hypot(wd.x - s.x, wd.y - s.y);
    if (d < WINDOW_RANGE && d < bestDist) {
      best = { type: 'vault', target: wd, label: 'Vault window' };
      bestDist = d;
    }
  }
  if (best) return best;

  // Teammates: unhook or heal them
  bestDist = Infinity;
  for (const t of world.survivors) {
    if (t === s) continue;
    const d = Math.hypot(t.x - s.x, t.y - s.y);
    if (d >= 1.6 * CELL || d >= bestDist) continue;
    if (t.health === 'hooked') {
      best = { type: 'unhook', target: t, label: `Unhook ${t.name}` };
      bestDist = d;
    } else if ((t.health === 'injured' || t.health === 'downed') &&
               s.health !== 'downed') {
      best = { type: 'heal-other', target: t, label: `Heal ${t.name}` };
      bestDist = d;
    }
  }
  if (best) return best;

  // Exit gate switches (only once powered)
  if (world.gatesPowered) {
    bestDist = Infinity;
    for (const g of world.map.gates) {
      if (g.open) continue;
      const d = Math.hypot(g.x - s.x, g.y - s.y);
      if (d < 2.2 * CELL && d < bestDist) {
        best = { type: 'open-gate', target: g, label: 'Open exit gate' };
        bestDist = d;
      }
    }
    if (best) return best;
  }

  // Generators
  bestDist = Infinity;
  for (const g of world.map.generators) {
    if (g.done) continue;
    const d = Math.hypot(g.x - s.x, g.y - s.y);
    if (d < GEN_RANGE && d < bestDist) {
      best = { type: 'repair', target: g, label: 'Repair generator' };
      bestDist = d;
    }
  }
  if (best) return best;

  // Nothing nearby and hurt? Patch yourself up.
  if (s.health === 'injured') {
    return { type: 'heal', target: null, label: 'Self-heal' };
  }

  return null;
}