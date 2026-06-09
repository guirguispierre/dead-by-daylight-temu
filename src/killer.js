// The Killer: a relentless AI that patrols generators, chases survivors,
// and carries downed ones to hooks.
// States: patrol -> chase -> search -> patrol, plus pickup/carry/stunned.

import { KILLER, METER } from './config.js';
import { hasLineOfSight, collideWithMap } from './map.js';
import { findPath } from './pathfind.js';
import { STANCE, HEALTH, damageSurvivor, hookSurvivor } from './survivor.js';

const SEE_RANGE = 24 * METER;        // LOS detection range, walking survivor
const SEE_RANGE_CROUCH = 8 * METER;  // crouched survivors are stealthy
const HEAR_RANGE = 10 * METER;       // running survivors are heard through walls
const LOSE_SIGHT_SECONDS = 3;        // grace before dropping chase
const SEARCH_SECONDS = 4;            // lingering at last seen position
const REPATH_INTERVAL = 0.35;

const ATTACK_COOLDOWN = 2.7;         // seconds between swings (weapon wipe)
const ATTACK_SLOW_SECONDS = 1.0;     // crawl while wiping the blade
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
    patrolTarget: null,      // generator being checked
    lastSeen: null,          // {x, y} of survivor when sight was lost
    loseSightTimer: 0,
    searchTimer: 0,
    speedMult: 1,
    attackCooldown: 0,
    pickupTimer: 0,
    stunTimer: 0,
    targetHook: null,
    breakTimer: 0,
    breakTarget: null,
  };
}

export function updateKiller(k, world, dt) {
  const s = world.survivor;
  const map = world.map;

  k.repathTimer -= dt;
  if (k.attackCooldown > 0) k.attackCooldown -= dt;

  // Swinging slows the killer; otherwise full speed
  k.speedMult = (k.attackCooldown > ATTACK_COOLDOWN - ATTACK_SLOW_SECONDS) ? 0.3 : 1;

  // Downed survivor nearby-ish? Go pick them up.
  if (s.health === HEALTH.DOWNED &&
      k.state !== 'pickup' && k.state !== 'carry' && k.state !== 'stunned') {
    k.state = 'pickup';
    k.path = null;
  }

  // Hooked or dead survivor: nothing to chase, go patrol
  if ((s.health === HEALTH.HOOKED || s.health === HEALTH.DEAD) &&
      (k.state === 'chase' || k.state === 'search' || k.state === 'pickup')) {
    k.state = 'patrol';
    k.patrolTarget = null;
    k.path = null;
  }

  // Gen explosions attract the killer from anywhere
  for (const e of world.events) {
    if (e.type === 'gen-explode' && (k.state === 'patrol' || k.state === 'search')) {
      k.state = 'search';
      k.lastSeen = { x: e.gen.x, y: e.gen.y };
      k.searchTimer = SEARCH_SECONDS;
      k.path = null;
    }
  }

  const canSee = (s.health === HEALTH.HEALTHY || s.health === HEALTH.INJURED) &&
                 detect(k, s, map);

  switch (k.state) {
    case 'patrol': {
      if (canSee) { enterChase(k, world); break; }
      if (!k.patrolTarget || k.patrolTarget.done || arrived(k, k.patrolTarget)) {
        k.patrolTarget = pickPatrolGen(k, world);
        k.path = null;
      }
      if (k.patrolTarget) moveAlongPath(k, map, k.patrolTarget, dt);
      break;
    }

    case 'chase': {
      if (canSee) {
        k.lastSeen = { x: s.x, y: s.y };
        k.loseSightTimer = 0;
      } else if (s.health === HEALTH.HEALTHY || s.health === HEALTH.INJURED) {
        k.loseSightTimer += dt;
        if (k.loseSightTimer > LOSE_SIGHT_SECONDS) {
          k.state = 'search';
          k.searchTimer = SEARCH_SECONDS;
          k.path = null;
          break;
        }
      }
      moveAlongPath(k, map, k.lastSeen ?? s, dt);

      // Dropped pallet in the face? Smash it.
      const pallet = nearbyDroppedPallet(k, map);
      if (pallet) {
        k.state = 'break';
        k.breakTimer = BREAK_SECONDS;
        k.breakTarget = pallet;
        k.path = null;
        break;
      }

      // Swing when in lunge range
      const d = Math.hypot(s.x - k.x, s.y - k.y);
      if (d <= KILLER.LUNGE_RANGE && k.attackCooldown <= 0 &&
          (s.health === HEALTH.HEALTHY || s.health === HEALTH.INJURED)) {
        k.attackCooldown = ATTACK_COOLDOWN;
        const event = damageSurvivor(s);
        if (event) world.events.push({ type: event });
      }
      break;
    }

    case 'search': {
      if (canSee) { enterChase(k, world); break; }
      if (k.lastSeen && !arrived(k, k.lastSeen)) {
        moveAlongPath(k, map, k.lastSeen, dt);
      } else {
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
      if (s.health !== HEALTH.DOWNED) { k.state = 'patrol'; k.path = null; break; }
      const d = Math.hypot(s.x - k.x, s.y - k.y);
      if (d > 1.2 * METER) {
        k.pickupTimer = 0;
        moveAlongPath(k, map, s, dt);
      } else {
        k.pickupTimer += dt;
        if (k.pickupTimer >= PICKUP_SECONDS) {
          s.health = HEALTH.CARRIED;
          s.wiggle = 0;
          s.action = null;
          k.state = 'carry';
          k.targetHook = nearestFreeHook(k, map);
          k.path = null;
          world.events.push({ type: 'picked-up' });
        }
      }
      break;
    }

    case 'carry': {
      // Survivor rides on the shoulder
      s.x = k.x + Math.cos(k.facing + Math.PI / 2) * 6;
      s.y = k.y + Math.sin(k.facing + Math.PI / 2) * 6;

      if (s.wiggle >= 1) {
        // Wiggled free: survivor escapes, killer is stunned
        s.health = HEALTH.INJURED;
        s.sprintBurst = 1.8;
        s.wiggle = 0;
        k.state = 'stunned';
        k.stunTimer = WIGGLE_STUN_SECONDS;
        world.events.push({ type: 'wiggle-free' });
        break;
      }

      if (!k.targetHook || k.targetHook.occupied) {
        k.targetHook = nearestFreeHook(k, map);
      }
      if (!k.targetHook) break; // nowhere to hook; keep lugging

      k.speedMult = CARRY_SPEED_MULT;
      moveAlongPath(k, map, k.targetHook, dt);
      if (Math.hypot(k.targetHook.x - k.x, k.targetHook.y - k.y) <= HOOK_RANGE) {
        const event = hookSurvivor(s, k.targetHook);
        world.events.push({ type: event });
        k.state = 'patrol';
        k.patrolTarget = null;
        k.targetHook = null;
        k.path = null;
      }
      break;
    }

    case 'break': {
      k.breakTimer -= dt;
      if (k.breakTimer <= 0) {
        if (k.breakTarget) k.breakTarget.state = 'broken';
        k.breakTarget = null;
        world.events.push({ type: 'pallet-break' });
        k.state = 'chase';
        k.lastSeen = { x: s.x, y: s.y };
        k.loseSightTimer = 0;
        k.path = null;
      }
      break;
    }

    case 'stunned': {
      k.stunTimer -= dt;
      if (k.stunTimer <= 0) {
        k.state = 'chase';
        k.lastSeen = { x: s.x, y: s.y };
        k.loseSightTimer = 0;
        k.path = null;
      }
      break;
    }
  }
}

function enterChase(k, world) {
  const s = world.survivor;
  k.state = 'chase';
  k.lastSeen = { x: s.x, y: s.y };
  k.loseSightTimer = 0;
  k.path = null;
  world.events.push({ type: 'chase-start' });
}

function detect(k, s, map) {
  const d = Math.hypot(s.x - k.x, s.y - k.y);

  // Hearing: running makes noise through walls
  if (s.stance === STANCE.RUN && s.moving && d < HEAR_RANGE) return true;

  const range = s.stance === STANCE.CROUCH ? SEE_RANGE_CROUCH : SEE_RANGE;
  if (d > range) return false;
  return hasLineOfSight(map, k.x, k.y, s.x, s.y);
}

function pickPatrolGen(k, world) {
  // Endgame: guard the exits instead of dead generators
  let candidates;
  if (world.gatesPowered) {
    candidates = world.map.gates.slice();
    if (world.map.hatch && world.map.hatch.open) candidates.push(world.map.hatch);
  } else {
    candidates = world.map.generators.filter(g => !g.done);
  }
  if (candidates.length === 0) return null;
  // Prefer gens away from the current position so the killer roams
  const sorted = candidates.slice().sort((a, b) =>
    Math.hypot(a.x - k.x, a.y - k.y) - Math.hypot(b.x - k.x, b.y - k.y));
  const pool = sorted.slice(Math.floor(sorted.length / 2));
  return pool[Math.floor(world.rng.next() * pool.length)] ?? sorted[0];
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
  const speed = KILLER.SPEED * k.speedMult;
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
