import { SURVIVOR } from './config.js';

// Movement stances
export const STANCE = { WALK: 'walk', RUN: 'run', CROUCH: 'crouch' };

export function createSurvivor(x, y) {
  return {
    x, y,
    vx: 0, vy: 0,
    radius: SURVIVOR.RADIUS,
    facing: 0,          // radians, for rendering
    stance: STANCE.WALK,
    moving: false,
    action: null,       // current interaction, e.g. {type:'repair', gen}
  };
}

/**
 * Update survivor position from input. `collide` is a function
 * (x, y, radius) => {x, y} that resolves the proposed position against
 * the world (identity until the map lands).
 */
export function updateSurvivor(s, inp, dt, collide) {
  let dx = inp.moveX;
  let dy = inp.moveY;

  s.moving = dx !== 0 || dy !== 0;

  if (inp.crouch) s.stance = STANCE.CROUCH;
  else if (inp.run && s.moving) s.stance = STANCE.RUN;
  else s.stance = STANCE.WALK;

  if (!s.moving) {
    s.vx = 0;
    s.vy = 0;
    return;
  }

  // Normalize diagonals
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;

  const speed =
    s.stance === STANCE.RUN ? SURVIVOR.RUN_SPEED :
    s.stance === STANCE.CROUCH ? SURVIVOR.CROUCH_SPEED :
    SURVIVOR.WALK_SPEED;

  s.vx = dx * speed;
  s.vy = dy * speed;
  s.facing = Math.atan2(dy, dx);

  const next = collide(s.x + s.vx * dt, s.y + s.vy * dt, s.radius);
  s.x = next.x;
  s.y = next.y;
}
