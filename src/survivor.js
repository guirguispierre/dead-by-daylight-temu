import { SURVIVOR, METER } from './config.js';

// Movement stances
export const STANCE = { WALK: 'walk', RUN: 'run', CROUCH: 'crouch' };

// Health states
export const HEALTH = {
  HEALTHY: 'healthy',
  INJURED: 'injured',
  DOWNED: 'downed',     // crawling, killer can pick up
  CARRIED: 'carried',   // on the killer's shoulder, wiggle to escape
  HOOKED: 'hooked',     // on a hook, sacrifice in progress
  DEAD: 'dead',
};

const CRAWL_SPEED = 0.7 * METER;
const SPRINT_BURST_SECONDS = 1.8;  // speed boost after taking a hit
const SPRINT_BURST_MULT = 1.5;
const WIGGLE_SECONDS = 14;         // mash to escape the killer's grip
const BLEED_OUT_SECONDS = 240;     // downed survivors slowly die

export const HOOK_STAGE_SECONDS = 50;   // per stage; 2 stages then death
export const SELF_UNHOOK_CHANCE = 0.04; // per attempt, 3 attempts (DBD's 4%)
export const SELF_UNHOOK_PENALTY = 12;  // seconds of stage 1 lost per failure
export const SELF_HEAL_SECONDS = 28;    // injured -> healthy, solo

export function createSurvivor(x, y) {
  return {
    x, y,
    vx: 0, vy: 0,
    radius: SURVIVOR.RADIUS,
    facing: 0,          // radians, for rendering
    stance: STANCE.WALK,
    moving: false,
    action: null,       // current interaction, e.g. {type:'repair', gen}

    health: HEALTH.HEALTHY,
    sprintBurst: 0,     // seconds of post-hit speed boost remaining
    wiggle: 0,          // 0..1 escape progress while carried
    bleedOut: BLEED_OUT_SECONDS,
    hookState: null,    // {hook, stage, timer, attemptsLeft}
    hookedCount: 0,     // hooks survived; 3rd hook = instant sacrifice
  };
}

/** Killer landed a hit. Returns the event type that occurred. */
export function damageSurvivor(s) {
  if (s.health === HEALTH.HEALTHY) {
    s.health = HEALTH.INJURED;
    s.sprintBurst = SPRINT_BURST_SECONDS;
    s.action = null;
    return 'survivor-hit';
  }
  if (s.health === HEALTH.INJURED) {
    s.health = HEALTH.DOWNED;
    s.action = null;
    return 'survivor-downed';
  }
  return null;
}

export function hookSurvivor(s, hook) {
  s.health = HEALTH.HOOKED;
  s.x = hook.x;
  s.y = hook.y + 2;
  s.wiggle = 0;
  s.hookedCount += 1;
  hook.occupied = true;
  if (s.hookedCount >= 3) {
    s.health = HEALTH.DEAD;
    hook.occupied = false;
    return 'sacrificed';
  }
  s.hookState = {
    hook,
    stage: s.hookedCount,            // 2nd hook starts at struggle phase
    timer: HOOK_STAGE_SECONDS,
    attemptsLeft: s.hookedCount === 1 ? 3 : 0,
  };
  return 'hooked';
}

export function unhookSurvivor(s) {
  const hook = s.hookState.hook;
  hook.occupied = false;
  s.hookState = null;
  s.health = HEALTH.INJURED;
  s.sprintBurst = SPRINT_BURST_SECONDS;
}

/**
 * Per-tick update while hooked. Space attempts a self-unhook in stage 1.
 * Returns an event string or null.
 */
export function updateHooked(s, inp, dt, rng) {
  const hs = s.hookState;
  hs.timer -= dt;

  if (hs.stage === 1 && inp.interactPressed && hs.attemptsLeft > 0) {
    hs.attemptsLeft -= 1;
    if (rng.chance(SELF_UNHOOK_CHANCE)) {
      unhookSurvivor(s);
      return 'self-unhook';
    }
    hs.timer -= SELF_UNHOOK_PENALTY;
  }

  if (hs.timer <= 0) {
    if (hs.stage === 1) {
      hs.stage = 2;
      hs.timer = HOOK_STAGE_SECONDS;
      return 'hook-stage-2';
    }
    s.hookState.hook.occupied = false;
    s.hookState = null;
    s.health = HEALTH.DEAD;
    return 'sacrificed';
  }
  return null;
}

/** Per-tick self-heal progress; partial progress persists if interrupted. */
export function updateHeal(s, dt) {
  s.healProgress = (s.healProgress || 0) + dt / SELF_HEAL_SECONDS;
  if (s.healProgress >= 1) {
    s.healProgress = 0;
    s.health = HEALTH.HEALTHY;
    s.action = null;
    return 'healed';
  }
  return null;
}

/**
 * Update survivor position from input. `collide` is a function
 * (x, y, radius) => {x, y} that resolves the proposed position against
 * the world.
 */
export function updateSurvivor(s, inp, dt, collide) {
  if (s.sprintBurst > 0) s.sprintBurst -= dt;

  let dx = inp.moveX;
  let dy = inp.moveY;

  s.moving = dx !== 0 || dy !== 0;

  const downed = s.health === HEALTH.DOWNED;
  if (downed) {
    s.bleedOut -= dt;
    s.stance = STANCE.CROUCH;
  } else if (inp.crouch) {
    s.stance = STANCE.CROUCH;
  } else if (inp.run && s.moving) {
    s.stance = STANCE.RUN;
  } else {
    s.stance = STANCE.WALK;
  }

  if (!s.moving) {
    s.vx = 0;
    s.vy = 0;
    return;
  }

  // Normalize diagonals
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;

  let speed;
  if (downed) {
    speed = CRAWL_SPEED;
  } else {
    speed =
      s.stance === STANCE.RUN ? SURVIVOR.RUN_SPEED :
      s.stance === STANCE.CROUCH ? SURVIVOR.CROUCH_SPEED :
      SURVIVOR.WALK_SPEED;
    if (s.sprintBurst > 0) speed *= SPRINT_BURST_MULT;
  }

  s.vx = dx * speed;
  s.vy = dy * speed;
  s.facing = Math.atan2(dy, dx);

  const next = collide(s.x + s.vx * dt, s.y + s.vy * dt, s.radius);
  s.x = next.x;
  s.y = next.y;
}
