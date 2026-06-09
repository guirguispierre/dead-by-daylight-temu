// The Killer: a relentless AI that patrols generators, chases the nearest
// detectable survivor (player or bot), and carries downed ones to hooks.
// States: patrol -> chase -> search -> patrol, plus pickup/carry/break/stunned.

import { KILLER, METER } from './config.js';
import { hasLineOfSight, collideWithMap } from './map.js';
import { findPath } from './pathfind.js';
import { STANCE, HEALTH, damageSurvivor, hookSurvivor } from './survivor.js';

const SEE_RANGE = 20 * METER;        // LOS detection range, walking survivor
const SEE_RANGE_CROUCH = 8 * METER;  // crouched survivors are stealthy
const HEAR_RANGE = 8 * METER;        // running survivors are heard through walls
const LOSE_SIGHT_SECONDS = 3;        // grace before dropping chase
const SEARCH_SECONDS = 4;            // lingering at last seen position
const GRUNT_RANGE = 5 * METER;       // injured survivors are heard up close
const SCRATCH_TRACK_RANGE = 14 * METER; // follow fresh scratch marks while searching
const REPATH_INTERVAL = 0.35;

const HIT_COOLDOWN = 2.7;            // weapon wipe after a landed hit
const HIT_SLOW_MULT = 0.1;           // ~0.46 m/s during the wipe
const MISS_COOLDOWN = 1.5;           // whiffed swing recovery
const MISS_SLOW_MULT = 0.2;          // ~0.92 m/s while recovering
const LUNGE_SPEED_MULT = 1.5;        // 6.9 m/s lunge for a 4.6 m/s killer
const LUNGE_SECONDS = 0.3;           // lunge commitment window
const LUNGE_TRIGGER = 2.6;           // start a lunge within this range (meters)
// Bloodlust: long chases speed the killer up; lost on hit/pallet break/chase end
const BLOODLUST_TIERS = [            // [chase seconds, bonus m/s]
  [35, 0.6],
  [25, 0.4],
  [15, 0.2],
];
const KICK_SECONDS = 1.8;            // damaging a generator
const KICK_INSTANT_LOSS = 0.05;      // -5% on kick
export const REGRESS_PER_SEC = 0.25 / 90; // -0.25 charges/s on a 90-charge gen
const PICKUP_SECONDS = 1.0;
const CARRY_SPEED_MULT = 0.8;
const WIGGLE_STUN_SECONDS = 2.5;
const HOOK_RANGE = 2.2 * METER; // path ends at the hook's neighbor cell
const BREAK_SECONDS = 2.6;      // pallet break channel
const BREAK_RANGE = 1.3 * METER;

export function createKiller(x, y) {
  return {
    x, y,
    radius: KILLER.RADIUS,
    facing: 0,
    state: 'patrol',
    path: null,
    pathIndex: 0,
    repathTimer: 0,
    patrolTarget: null,      // generator/gate being checked
    target: null,            // survivor being chased / picked up / carried
    lastSeen: null,          // {x, y} of target when sight was lost
    loseSightTimer: 0,
    searchTimer: 0,
    speedMult: 1,
    attackCooldown: 0,
    pickupTimer: 0,
    stunTimer: 0,
    targetHook: null,
    breakTimer: 0,
    breakTarget: null,
    swingSlowMult: 1,        // active cooldown slow (hit vs miss differ)
    chaseTimer: 0,           // time in current chase, drives bloodlust
    bloodlust: 0,            // current bonus in m/s
    lungeTimer: 0,           // >0 while committed to a lunge
    kickTimer: 0,
    kickTarget: null,
  };
}

const chaseable = (s) => s.health === HEALTH.HEALTHY || s.health === HEALTH.INJURED;

export function updateKiller(k, world, dt) {
  const map = world.map;
  const survivors = world.survivors;

  k.repathTimer -= dt;
  if (k.attackCooldown > 0) k.attackCooldown -= dt;

  // Swing recovery slows the killer; otherwise full speed
  k.speedMult = k.attackCooldown > 0 ? k.swingSlowMult : 1;

  // Bloodlust builds while in chase, fades otherwise
  if (k.state === 'chase') {
    k.chaseTimer += dt;
    k.bloodlust = 0;
    for (const [t, bonus] of BLOODLUST_TIERS) {
      if (k.chaseTimer >= t) { k.bloodlust = bonus; break; }
    }
  } else {
    k.chaseTimer = 0;
    k.bloodlust = 0;
  }

  // A downed survivor takes priority: go pick them up
  if (k.state !== 'pickup' && k.state !== 'carry' && k.state !== 'stunned') {
    const downed = nearest(k, survivors.filter(s => s.health === HEALTH.DOWNED));
    if (downed) {
      k.state = 'pickup';
      k.target = downed;
      k.path = null;
    }
  }

  // Current chase target gone (hooked/dead/escaped)? Reset to patrol.
  if ((k.state === 'chase' || k.state === 'search') &&
      k.target && !chaseable(k.target)) {
    k.state = 'patrol';
    k.target = null;
    k.patrolTarget = null;
    k.path = null;
  }

  // Loud noises (gen explosions, botched heals) attract the killer
  for (const e of world.events) {
    const isNoise = e.type === 'gen-explode' || e.type === 'heal-fail';
    if (isNoise && (k.state === 'patrol' || k.state === 'search')) {
      k.state = 'search';
      k.lastSeen = { x: e.gen ? e.gen.x : e.x, y: e.gen ? e.gen.y : e.y };
      k.searchTimer = SEARCH_SECONDS;
      k.path = null;
    }
  }

  // Spot the nearest detectable survivor
  const spotted = nearest(k, survivors.filter(s => chaseable(s) && detect(k, s, map)));

  switch (k.state) {
    case 'patrol': {
      if (spotted) { enterChase(k, world, spotted); break; }
      if (k.patrolTarget && !k.patrolTarget.done && arrived(k, k.patrolTarget) &&
          k.patrolTarget.progress > 0.01 && !k.patrolTarget.regressing) {
        // Found a worked-on generator: kick it
        k.state = 'kick';
        k.kickTimer = KICK_SECONDS;
        k.kickTarget = k.patrolTarget;
        break;
      }
      if (!k.patrolTarget || k.patrolTarget.done || arrived(k, k.patrolTarget)) {
        k.patrolTarget = pickPatrolTarget(k, world);
        k.path = null;
      }
      if (k.patrolTarget) moveAlongPath(k, map, k.patrolTarget, dt);
      break;
    }

    case 'chase': {
      const t = k.target;
      const canSee = t && chaseable(t) && detect(k, t, map);
      if (canSee) {
        k.lastSeen = { x: t.x, y: t.y };
        k.loseSightTimer = 0;
      } else {
        // Maybe someone else ran into view
        if (spotted && spotted !== t) { enterChase(k, world, spotted); break; }
        k.loseSightTimer += dt;
        if (k.loseSightTimer > LOSE_SIGHT_SECONDS) {
          k.state = 'search';
          k.searchTimer = SEARCH_SECONDS;
          k.path = null;
          break;
        }
      }
      moveAlongPath(k, map, k.lastSeen ?? t, dt);

      // Dropped pallet in the face? Smash it.
      const pallet = nearbyDroppedPallet(k, map);
      if (pallet) {
        k.state = 'break';
        k.breakTimer = BREAK_SECONDS;
        k.breakTarget = pallet;
        k.path = null;
        break;
      }

      // Lunge: commit to a 0.3s burst at 1.5x speed when close enough
      if (t && chaseable(t)) {
        const d = Math.hypot(t.x - k.x, t.y - k.y);

        if (k.lungeTimer > 0) {
          k.lungeTimer -= dt;
          lungeStep(k, map, t, dt);
          if (Math.hypot(t.x - k.x, t.y - k.y) <= KILLER.LUNGE_RANGE * 0.55) {
            // Contact: hit lands
            k.lungeTimer = 0;
            k.attackCooldown = HIT_COOLDOWN;
            k.swingSlowMult = HIT_SLOW_MULT;
            k.chaseTimer = 0; // a hit resets bloodlust
            const event = damageSurvivor(t);
            if (event) world.events.push({ type: event, who: t });
          } else if (k.lungeTimer <= 0) {
            // Whiffed: shorter but real recovery
            k.attackCooldown = MISS_COOLDOWN;
            k.swingSlowMult = MISS_SLOW_MULT;
            world.events.push({ type: 'swing-miss' });
          }
        } else if (d <= LUNGE_TRIGGER * METER && k.attackCooldown <= 0) {
          k.lungeTimer = LUNGE_SECONDS;
        }
      }
      break;
    }

    case 'kick': {
      k.kickTimer -= dt;
      if (k.kickTimer <= 0) {
        const g = k.kickTarget;
        if (g && !g.done) {
          g.progress = Math.max(0, g.progress - KICK_INSTANT_LOSS);
          g.regressing = g.progress > 0;
          g.repairSinceRegress = 0;
          world.events.push({ type: 'gen-kick', gen: g });
        }
        k.kickTarget = null;
        k.state = 'patrol';
        k.patrolTarget = null;
        k.path = null;
      }
      break;
    }

    case 'search': {
      if (spotted) { enterChase(k, world, spotted); break; }
      if (k.lastSeen && !arrived(k, k.lastSeen)) {
        moveAlongPath(k, map, k.lastSeen, dt);
      } else {
        // Arrived empty-handed: follow fresh scratch marks if any lead away
        const scratch = freshestScratch(k, world);
        if (scratch) {
          k.lastSeen = { x: scratch.x, y: scratch.y };
          k.searchTimer = SEARCH_SECONDS;
          k.path = null;
          break;
        }
        k.searchTimer -= dt;
        // Spin around looking
        k.facing += dt * 2.2;
        if (k.searchTimer <= 0) {
          k.state = 'patrol';
          k.patrolTarget = null;
          k.lastSeen = null;
        }
      }
      break;
    }

    case 'pickup': {
      const t = k.target;
      if (!t || t.health !== HEALTH.DOWNED) { k.state = 'patrol'; k.path = null; break; }
      const d = Math.hypot(t.x - k.x, t.y - k.y);
      if (d > 1.2 * METER) {
        k.pickupTimer = 0;
        moveAlongPath(k, map, t, dt);
      } else {
        k.pickupTimer += dt;
        if (k.pickupTimer >= PICKUP_SECONDS) {
          t.health = HEALTH.CARRIED;
          t.wiggle = 0;
          t.action = null;
          k.state = 'carry';
          k.targetHook = nearestFreeHook(k, map);
          k.path = null;
          world.events.push({ type: 'picked-up', who: t });
        }
      }
      break;
    }

    case 'carry': {
      const t = k.target;
      if (!t || t.health !== HEALTH.CARRIED) { k.state = 'patrol'; k.path = null; break; }
      // Survivor rides on the shoulder
      t.x = k.x + Math.cos(k.facing + Math.PI / 2) * 6;
      t.y = k.y + Math.sin(k.facing + Math.PI / 2) * 6;

      if (t.wiggle >= 1) {
        // Wiggled free: survivor escapes, killer is stunned
        t.health = HEALTH.INJURED;
        t.sprintBurst = 1.8;
        t.wiggle = 0;
        k.state = 'stunned';
        k.stunTimer = WIGGLE_STUN_SECONDS;
        world.events.push({ type: 'wiggle-free', who: t });
        break;
      }

      if (!k.targetHook || k.targetHook.occupied) {
        k.targetHook = nearestFreeHook(k, map);
      }
      if (!k.targetHook) break; // nowhere to hook; keep lugging

      k.speedMult = CARRY_SPEED_MULT;
      moveAlongPath(k, map, k.targetHook, dt);
      if (Math.hypot(k.targetHook.x - k.x, k.targetHook.y - k.y) <= HOOK_RANGE) {
        const event = hookSurvivor(t, k.targetHook);
        world.events.push({ type: event, who: t });
        k.state = 'patrol';
        k.patrolTarget = null;
        k.targetHook = null;
        k.target = null;
        k.path = null;
      }
      break;
    }

    case 'break': {
      k.breakTimer -= dt;
      if (k.breakTimer <= 0) {
        if (k.breakTarget) k.breakTarget.state = 'broken';
        k.breakTarget = null;
        k.chaseTimer = 0; // breaking a pallet resets bloodlust
        world.events.push({ type: 'pallet-break' });
        k.state = k.target && chaseable(k.target) ? 'chase' : 'patrol';
        if (k.target) {
          k.lastSeen = { x: k.target.x, y: k.target.y };
          k.loseSightTimer = 0;
        }
        k.path = null;
      }
      break;
    }

    case 'stunned': {
      k.stunTimer -= dt;
      if (k.stunTimer <= 0) {
        if (k.target && chaseable(k.target)) {
          k.state = 'chase';
          k.lastSeen = { x: k.target.x, y: k.target.y };
          k.loseSightTimer = 0;
        } else {
          k.state = 'patrol';
          k.patrolTarget = null;
        }
        k.path = null;
      }
      break;
    }
  }
}

function enterChase(k, world, target) {
  k.state = 'chase';
  k.target = target;
  k.lastSeen = { x: target.x, y: target.y };
  k.loseSightTimer = 0;
  k.path = null;
  world.events.push({ type: 'chase-start', who: target });
}

function nearest(k, list) {
  let best = null;
  let bestD = Infinity;
  for (const s of list) {
    const d = Math.hypot(s.x - k.x, s.y - k.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

function detect(k, s, map) {
  const d = Math.hypot(s.x - k.x, s.y - k.y);

  // Hearing: running makes noise through walls
  if (s.stance === STANCE.RUN && s.moving && d < HEAR_RANGE) return true;

  // Injured survivors grunt in pain — audible up close even through walls
  if (s.health === HEALTH.INJURED && d < GRUNT_RANGE) return true;

  const range = s.stance === STANCE.CROUCH ? SEE_RANGE_CROUCH : SEE_RANGE;
  if (d > range) return false;
  return hasLineOfSight(map, k.x, k.y, s.x, s.y);
}

function pickPatrolTarget(k, world) {
  // Endgame: guard the exits instead of dead generators
  let candidates;
  if (world.gatesPowered) {
    candidates = world.map.gates.slice();
    if (world.map.hatch && world.map.hatch.open) candidates.push(world.map.hatch);
  } else {
    candidates = world.map.generators.filter(g => !g.done);
  }
  if (candidates.length === 0) return null;
  // Prefer targets away from the current position so the killer roams
  const sorted = candidates.slice().sort((a, b) =>
    Math.hypot(a.x - k.x, a.y - k.y) - Math.hypot(b.x - k.x, b.y - k.y));
  const pool = sorted.slice(Math.floor(sorted.length / 2));
  return pool[Math.floor(world.rng.next() * pool.length)] ?? sorted[0];
}

// Freshest scratch mark in tracking range, ignoring ones we're standing on
function freshestScratch(k, world) {
  let best = null;
  for (const m of world.scratches || []) {
    const d = Math.hypot(m.x - k.x, m.y - k.y);
    if (d < METER || d > SCRATCH_TRACK_RANGE) continue;
    if (!best || m.age < best.age) best = m;
  }
  return best;
}

// Straight-line burst at the lunge speed, ignoring the path
function lungeStep(k, map, t, dt) {
  const d = Math.hypot(t.x - k.x, t.y - k.y);
  if (d === 0) return;
  const speed = KILLER.SPEED * LUNGE_SPEED_MULT;
  const step = Math.min(speed * dt, d);
  const nx = k.x + ((t.x - k.x) / d) * step;
  const ny = k.y + ((t.y - k.y) / d) * step;
  k.facing = Math.atan2(t.y - k.y, t.x - k.x);
  const resolved = collideWithMap(map, k.x, k.y, nx, ny, k.radius);
  k.x = resolved.x;
  k.y = resolved.y;
}

function nearbyDroppedPallet(k, map) {
  for (const p of map.pallets) {
    if (p.state !== 'dropped') continue;
    if (Math.hypot(p.x - k.x, p.y - k.y) < BREAK_RANGE + k.radius) return p;
  }
  return null;
}

function nearestFreeHook(k, map) {
  let best = null;
  let bestD = Infinity;
  for (const h of map.hooks) {
    if (h.occupied) continue;
    const d = Math.hypot(h.x - k.x, h.y - k.y);
    if (d < bestD) { best = h; bestD = d; }
  }
  return best;
}

function arrived(k, target) {
  return Math.hypot(target.x - k.x, target.y - k.y) < 2.2 * METER;
}

function moveAlongPath(k, map, target, dt) {
  // Re-path periodically or when we have no path
  if (!k.path || k.repathTimer <= 0) {
    // Clearance = body radius + margin so smoothing never hugs corners
    k.path = findPath(map, k.x, k.y, target.x, target.y, k.radius + 3);
    k.pathIndex = 0;
    k.repathTimer = REPATH_INTERVAL;
  }
  if (!k.path || k.path.length === 0) return;

  // Advance waypoints we've reached
  while (k.pathIndex < k.path.length &&
         Math.hypot(k.path[k.pathIndex].x - k.x, k.path[k.pathIndex].y - k.y) < 6) {
    k.pathIndex++;
  }
  if (k.pathIndex >= k.path.length) return;

  const wp = k.path[k.pathIndex];
  const d = Math.hypot(wp.x - k.x, wp.y - k.y);
  const speed = (KILLER.SPEED + k.bloodlust * METER) * k.speedMult;
  const step = Math.min(speed * dt, d);
  const nx = k.x + ((wp.x - k.x) / d) * step;
  const ny = k.y + ((wp.y - k.y) / d) * step;
  k.facing = Math.atan2(wp.y - k.y, wp.x - k.x);

  const resolved = collideWithMap(map, k.x, k.y, nx, ny, k.radius);
  const moved = Math.hypot(resolved.x - k.x, resolved.y - k.y);
  k.x = resolved.x;
  k.y = resolved.y;

  // Wedged on geometry: force an immediate repath from the current spot
  if (moved < step * 0.25) {
    k.stuckTime = (k.stuckTime || 0) + dt;
    if (k.stuckTime > 0.2) {
      k.path = null;
      k.repathTimer = 0;
      k.stuckTime = 0;
    }
  } else {
    k.stuckTime = 0;
  }
}

/** 0 (outside terror radius) .. 1 (on top of you). Drives heartbeat + vignette. */
export function terrorIntensity(k, s) {
  const d = Math.hypot(s.x - k.x, s.y - k.y);
  if (d > KILLER.TERROR_RADIUS) return 0;
  return 1 - d / KILLER.TERROR_RADIUS;
}
