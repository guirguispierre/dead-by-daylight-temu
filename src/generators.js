// Generator repair + skill check minigame.
//
// Press Space near a generator to latch on; moving cancels. While repairing,
// random skill checks appear: a needle sweeps a dial and you must press Space
// inside the success zone. Great zone gives bonus progress; a miss "explodes"
// the generator, losing progress and (eventually) alerting the killer.

import { GAME } from './config.js';

const SKILLCHECK_CHANCE_PER_SEC = 1 / 9;   // average one every ~9s of repair
const SKILLCHECK_SWEEP_SECONDS = 1.1;      // needle full revolution time
const MISS_PENALTY = 0.10;                 // 10% progress lost
const GREAT_BONUS = 0.01;                  // +1% progress
const ZONE_SIZE = Math.PI * 0.32;          // success zone arc (~58 deg)
const GREAT_SIZE = Math.PI * 0.09;         // great zone arc (~16 deg)

export function startRepair(survivor, gen, rng) {
  survivor.action = {
    type: 'repair',
    gen,
    rng,
    skillCheck: null,
  };
}

export function cancelAction(survivor) {
  survivor.action = null;
}

/**
 * Advance an in-progress repair. Returns events that occurred this tick
 * (e.g. {type:'gen-explode', gen} or {type:'gen-done', gen}) for the killer
 * AI and audio to react to.
 */
export function updateRepair(survivor, inp, dt, rng) {
  const action = survivor.action;
  const gen = action.gen;
  const events = [];

  if (gen.done) {
    survivor.action = null;
    return events;
  }

  const sc = action.skillCheck;
  if (sc) {
    sc.angle += (Math.PI * 2 / SKILLCHECK_SWEEP_SECONDS) * dt;

    if (inp.interactPressed) {
      const inZone = sc.angle >= sc.zoneStart && sc.angle <= sc.zoneStart + ZONE_SIZE;
      const inGreat = sc.angle >= sc.zoneStart && sc.angle <= sc.zoneStart + GREAT_SIZE;
      if (inGreat) {
        gen.progress = Math.min(1, gen.progress + GREAT_BONUS);
        events.push({ type: 'skillcheck-great' });
      } else if (inZone) {
        events.push({ type: 'skillcheck-good' });
      } else {
        explode(gen, events);
      }
      action.skillCheck = null;
    } else if (sc.angle > sc.zoneStart + ZONE_SIZE) {
      // Needle swept past the zone without a press
      explode(gen, events);
      action.skillCheck = null;
    }
  } else {
    // Normal repair progress
    gen.progress += dt / GAME.GEN_REPAIR_SECONDS;

    // Maybe spawn a skill check
    if (rng.chance(SKILLCHECK_CHANCE_PER_SEC * dt)) {
      const zoneStart = Math.PI * 0.5 + rng.next() * Math.PI * 1.1;
      action.skillCheck = { angle: 0, zoneStart };
      events.push({ type: 'skillcheck-warn' });
    }
  }

  if (gen.progress >= 1) {
    gen.progress = 1;
    gen.done = true;
    survivor.action = null;
    events.push({ type: 'gen-done', gen });
  }

  return events;
}

function explode(gen, events) {
  gen.progress = Math.max(0, gen.progress - MISS_PENALTY);
  events.push({ type: 'gen-explode', gen });
}

export function skillCheckGeometry() {
  return { ZONE_SIZE, GREAT_SIZE };
}

export function generatorsDone(map) {
  return map.generators.filter(g => g.done).length;
}

export function generatorsRemaining(map) {
  return Math.max(0, GAME.GENERATORS_REQUIRED - generatorsDone(map));
}
