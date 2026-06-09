// AI survivor teammates. They repair generators, flee the killer, rescue
// hooked friends, heal the wounded, and head for the exits at endgame.

import { SURVIVOR, GAME, METER } from './config.js';
import { createSurvivor, HEALTH, STANCE, unhookSurvivor } from './survivor.js';
import { crewRate, creditRegressionPause } from './generators.js';
import { collideWithMap } from './map.js';
import { findPath } from './pathfind.js';

const FLEE_RANGE = 13 * METER;      // killer this close (with LOS) => run away
const FLEE_DISTANCE = 22 * METER;   // how far to run before settling
// Work ranges are 2.2m because paths end at a solid target's *neighbor*
// cell, which can be up to ~1.7m from the target's center.
const UNHOOK_RANGE = 2.2 * METER;
const UNHOOK_SECONDS = 1;     // matches DBD's unhook action
const HEAL_RANGE = 2.2 * METER;
const HEAL_SECONDS = 16;      // altruistic heal duration
const REPATH_INTERVAL = 0.5;
const GEN_WORK_RANGE = 2.2 * METER;

export const BOT_NAMES = ['Dwight', 'Meg', 'Claudette'];
const BOT_COLORS = ['#7d9ec7', '#c77d7d', '#7dc78e'];

export function createBot(x, y, index) {
  const bot = createSurvivor(x, y);
  bot.isBot = true;
  bot.index = index;
  bot.name = BOT_NAMES[index % BOT_NAMES.length];
  bot.color = BOT_COLORS[index % BOT_COLORS.length];
  bot.goal = null;          // {kind, target, timer}
  bot.path = null;
  bot.pathIndex = 0;
  bot.repathTimer = 0;
  bot.escapedFlag = false;
  return bot;
}

export function updateBot(bot, world, dt) {
  const k = world.killer;

  switch (bot.health) {
    case HEALTH.DEAD:
      return;
    case HEALTH.CARRIED:
      bot.wiggle += dt / 16;
      return;
    case HEALTH.HOOKED:
      // Hook timers for bots are advanced by updateHookedBot in main
      return;
    case HEALTH.DOWNED: {
      bot.bleedOut -= dt;
      if (bot.bleedOut <= 0) bot.health = HEALTH.DEAD;
      // Crawl away from the killer, slowly
      crawl(bot, world, dt);
      return;
    }
  }

  if (bot.sprintBurst > 0) bot.sprintBurst -= dt;
  if (bot.endurance > 0) bot.endurance -= dt;

  // --- Decide goal (priority order) ---
  const threat = isThreatened(bot, k, world.map);
  if (threat) {
    if (!bot.goal || bot.goal.kind !== 'flee') {
      bot.goal = { kind: 'flee' };
      bot.path = null;
    }
  } else if (bot.goal && bot.goal.kind === 'flee') {
    bot.goal = null; // calm again
  }

  if (!threat) {
    // Rescue takes priority over everything else
    const hooked = world.survivors.find(s => s !== bot && s.health === HEALTH.HOOKED);
    const rescuer = hooked && designatedRescuer(world, hooked);
    if (hooked && rescuer === bot) {
      if (!bot.goal || bot.goal.kind !== 'rescue' || bot.goal.target !== hooked) {
        bot.goal = { kind: 'rescue', target: hooked, timer: UNHOOK_SECONDS };
        bot.path = null;
      }
    } else if (!bot.goal || bot.goal.kind === 'idle' || bot.goal.kind === 'rescue') {
      bot.goal = null;
    }

    // Heal a hurt teammate standing close by (or be healed)
    if (!bot.goal) {
      const patient = world.survivors.find(s =>
        s !== bot && // any survivor including the player
        (s.health === HEALTH.INJURED || s.health === HEALTH.DOWNED) &&
        Math.hypot(s.x - bot.x, s.y - bot.y) < 6 * METER);
      if (patient) {
        bot.goal = { kind: 'heal', target: patient, timer: HEAL_SECONDS };
        bot.path = null;
      }
    }

    // Endgame: leave
    if (!bot.goal && world.gatesPowered) {
      const openGate = world.map.gates.find(g => g.open);
      const target = openGate ?? world.map.gates[0];
      bot.goal = { kind: openGate ? 'leave' : 'open-gate', target };
    }

    // Otherwise: fix generators
    if (!bot.goal) {
      const gen = nearestUnfinishedGen(bot, world);
      bot.goal = gen ? { kind: 'repair', target: gen } : { kind: 'idle' };
    }
  }

  // --- Execute goal ---
  switch (bot.goal && bot.goal.kind) {
    case 'flee': {
      // Slam a nearby pallet if the killer is closing in — but only one
      // that's between us and the killer, so we don't wall ourselves in
      const kd = Math.hypot(k.x - bot.x, k.y - bot.y);
      if (kd < 5 * METER) {
        const pallet = world.map.pallets.find(p => {
          if (p.state !== 'upright') return false;
          const d = Math.hypot(p.x - bot.x, p.y - bot.y);
          if (d > 1.6 * METER) return false;
          const towardKiller = (p.x - bot.x) * (k.x - bot.x) + (p.y - bot.y) * (k.y - bot.y);
          return towardKiller > 0;
        });
        if (pallet) {
          pallet.state = 'dropped';
          world.events.push({ type: 'pallet-drop' });
          if (Math.hypot(k.x - pallet.x, k.y - pallet.y) < 1.8 * METER && k.state !== 'carry') {
            k.state = 'stunned';
            k.stunTimer = 2.0;
            k.path = null;
            world.events.push({ type: 'pallet-stun' });
          }
        }
      }
      const away = fleePoint(bot, k, world.map);
      moveToward(bot, world, away, dt, true);
      break;
    }

    case 'rescue': {
      const t = bot.goal.target;
      if (t.health !== HEALTH.HOOKED) { bot.goal = null; break; }
      const d = Math.hypot(t.x - bot.x, t.y - bot.y);
      if (d > UNHOOK_RANGE) {
        moveToward(bot, world, t, dt, true);
      } else {
        bot.goal.timer -= dt;
        if (bot.goal.timer <= 0) {
          unhookSurvivor(t);
          world.events.push({ type: 'unhooked', who: t });
          bot.goal = null;
        }
      }
      break;
    }

    case 'heal': {
      const t = bot.goal.target;
      if (t.health !== HEALTH.INJURED && t.health !== HEALTH.DOWNED) { bot.goal = null; break; }
      const d = Math.hypot(t.x - bot.x, t.y - bot.y);
      if (d > HEAL_RANGE) {
        moveToward(bot, world, t, dt, false);
      } else {
        bot.goal.timer -= dt;
        if (bot.goal.timer <= 0) {
          // Downed -> injured, injured -> healthy (like DBD)
          t.health = t.health === HEALTH.DOWNED ? HEALTH.INJURED : HEALTH.HEALTHY;
          world.events.push({ type: 'healed', who: t });
          bot.goal = null;
        }
      }
      break;
    }

    case 'repair': {
      const gen = bot.goal.target;
      if (gen.done) { bot.goal = null; break; }
      const d = Math.hypot(gen.x - bot.x, gen.y - bot.y);
      if (d > GEN_WORK_RANGE) {
        moveToward(bot, world, gen, dt, false);
      } else {
        bot.moving = false;
        bot.stance = STANCE.WALK;
        const delta = crewRate(gen.crew) * dt / GAME.GEN_REPAIR_SECONDS;
        gen.progress += delta;
        creditRegressionPause(gen, delta);
        if (gen.progress >= 1) {
          gen.progress = 1;
          gen.done = true;
          world.events.push({ type: 'gen-done', gen });
          bot.goal = null;
        }
      }
      break;
    }

    case 'open-gate': {
      const gate = bot.goal.target;
      if (gate.open) { bot.goal = null; break; }
      const d = Math.hypot(gate.x - bot.x, gate.y - bot.y);
      if (d > 2.2 * METER) {
        moveToward(bot, world, gate, dt, true);
      } else {
        gate.progress += dt / 20; // 20s gate opening, like DBD
        if (gate.progress >= 1) {
          gate.progress = 1;
          gate.open = true;
          world.events.push({ type: 'gate-open' });
          if (world.collapseTimer === null) world.collapseTimer = 120;
          bot.goal = null;
        }
      }
      break;
    }

    case 'leave': {
      const gate = bot.goal.target;
      moveToward(bot, world, gate, dt, true);
      const cx = Math.floor(bot.x / 16);
      const cy = Math.floor(bot.y / 16);
      if (gate.open && gate.cells.some(c => c.cx === cx && c.cy === cy)) {
        bot.escapedFlag = true;
        bot.health = HEALTH.DEAD; // out of the trial (not chaseable)
        world.events.push({ type: 'bot-escaped', who: bot });
      }
      break;
    }

    default:
      bot.moving = false;
      break;
  }
}

function isThreatened(bot, k, map) {
  const d = Math.hypot(k.x - bot.x, k.y - bot.y);
  if (d > FLEE_RANGE) return false;
  // Chased directly, or killer simply too close for comfort
  if (k.target === bot && k.state === 'chase') return true;
  // Rescuers hold their nerve unless the killer is right on top of them
  if (bot.goal && bot.goal.kind === 'rescue') return d < 4 * METER;
  return d < FLEE_RANGE * 0.7;
}

function fleePoint(bot, k, map) {
  const ax = bot.x - k.x;
  const ay = bot.y - k.y;
  const al = Math.hypot(ax, ay) || 1;

  // Real survivor instinct: run TO a pallet, not into open space.
  let best = null;
  let bestScore = -Infinity;
  for (const p of map.pallets) {
    if (p.state !== 'upright') continue;
    const px = p.x - bot.x;
    const py = p.y - bot.y;
    const pl = Math.hypot(px, py) || 1;
    if (pl > 28 * METER) continue;
    // Prefer pallets roughly away from the killer and close to us
    const dot = (ax / al) * (px / pl) + (ay / al) * (py / pl);
    if (dot < -0.15) continue; // don't run through the killer
    const score = dot * 2 - pl / (28 * METER);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) {
    // Aim just PAST the pallet (away from the killer) so it ends up
    // between us and the killer, ready to slam
    return { x: best.x + (ax / al) * 1.2 * METER, y: best.y + (ay / al) * 1.2 * METER };
  }

  // No pallets left: straight away
  const x = Math.max(24, Math.min((map.w - 2) * 16, bot.x + (ax / al) * FLEE_DISTANCE));
  const y = Math.max(24, Math.min((map.h - 2) * 16, bot.y + (ay / al) * FLEE_DISTANCE));
  return { x, y };
}

function designatedRescuer(world, hooked) {
  // The closest healthy-ish bot does the save (player rescues manually)
  let best = null;
  let bestD = Infinity;
  for (const s of world.survivors) {
    if (!s.isBot || s === hooked) continue;
    if (s.health !== HEALTH.HEALTHY && s.health !== HEALTH.INJURED) continue;
    const d = Math.hypot(s.x - hooked.x, s.y - hooked.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

function nearestUnfinishedGen(bot, world) {
  const gens = world.map.generators
    .filter(g => !g.done)
    .sort((a, b) =>
      Math.hypot(a.x - bot.x, a.y - bot.y) - Math.hypot(b.x - bot.x, b.y - bot.y));
  if (gens.length === 0) return null;
  // Spread the team: each bot prefers a different nearby gen
  return gens[bot.index % Math.min(gens.length, 3)] ?? gens[0];
}

function crawl(bot, world, dt) {
  const k = world.killer;
  const away = fleePoint(bot, k, world.map);
  const dx = away.x - bot.x;
  const dy = away.y - bot.y;
  const len = Math.hypot(dx, dy) || 1;
  const speed = 0.7 * METER;
  const next = collideWithMap(world.map, bot.x, bot.y,
    bot.x + (dx / len) * speed * dt, bot.y + (dy / len) * speed * dt, bot.radius);
  bot.x = next.x;
  bot.y = next.y;
  bot.moving = true;
  bot.stance = STANCE.CROUCH;
}

function moveToward(bot, world, target, dt, run) {
  const map = world.map;
  bot.repathTimer -= dt;
  // Repath on a timer or when the goal has moved meaningfully — NOT every
  // time a continuously-recomputed goal shifts by a pixel, or the bot
  // spends every tick walking back to its own cell center.
  const goalMoved = bot.pathGoalX === undefined ||
    Math.hypot(bot.pathGoalX - target.x, bot.pathGoalY - target.y) > 32;
  if (!bot.path || bot.repathTimer <= 0 || goalMoved) {
    bot.path = findPath(map, bot.x, bot.y, target.x, target.y, bot.radius + 3);
    // Skip waypoint 0 (our own cell center) when there's a next one
    bot.pathIndex = bot.path && bot.path.length > 1 ? 1 : 0;
    bot.repathTimer = REPATH_INTERVAL;
    bot.pathGoalX = target.x;
    bot.pathGoalY = target.y;
  }
  if (!bot.path || bot.path.length === 0) { bot.moving = false; return; }

  while (bot.pathIndex < bot.path.length &&
         Math.hypot(bot.path[bot.pathIndex].x - bot.x, bot.path[bot.pathIndex].y - bot.y) < 5) {
    bot.pathIndex++;
  }
  if (bot.pathIndex >= bot.path.length) { bot.moving = false; return; }

  const wp = bot.path[bot.pathIndex];
  const d = Math.hypot(wp.x - bot.x, wp.y - bot.y);
  let speed = run ? SURVIVOR.RUN_SPEED : SURVIVOR.WALK_SPEED;
  if (bot.sprintBurst > 0) speed = SURVIVOR.RUN_SPEED * 1.5;
  const step = Math.min(speed * dt, d);
  const nx = bot.x + ((wp.x - bot.x) / d) * step;
  const ny = bot.y + ((wp.y - bot.y) / d) * step;
  bot.facing = Math.atan2(wp.y - bot.y, wp.x - bot.x);
  // Injured bots sneak when not sprinting (harder for the killer to spot)
  bot.stance = run ? STANCE.RUN :
    (bot.health === HEALTH.INJURED ? STANCE.CROUCH : STANCE.WALK);
  bot.moving = true;

  const resolved = collideWithMap(map, bot.x, bot.y, nx, ny, bot.radius);
  bot.x = resolved.x;
  bot.y = resolved.y;
}
