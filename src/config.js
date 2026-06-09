// Central tuning constants. Numbers loosely modeled on real DBD values
// (survivor 4.0 m/s, killer 4.6 m/s) scaled to pixels: 1 meter = 16 px.

export const METER = 16;

export const SURVIVOR = {
  RADIUS: 0.4 * METER,
  WALK_SPEED: 2.26 * METER,   // m/s -> px/s
  RUN_SPEED: 4.0 * METER,
  CROUCH_SPEED: 1.13 * METER,
  INJURED_MULT: 1.0,          // injured survivors run same speed in DBD
};

export const KILLER = {
  RADIUS: 0.5 * METER,
  SPEED: 4.6 * METER,
  TERROR_RADIUS: 32 * METER,
  LUNGE_RANGE: 1.8 * METER,
};

export const GAME = {
  GENERATORS_TOTAL: 7,        // on the map
  GENERATORS_REQUIRED: 5,     // to power gates
  GEN_REPAIR_SECONDS: 80,     // solo repair time (real DBD: 90)
  TICK: 1 / 60,               // fixed timestep seconds
};

export const COLORS = {
  FLOOR: '#14141c',
  FLOOR_ALT: '#16161f',
  WALL: '#2e2a3a',
  WALL_EDGE: '#473f5c',
  SURVIVOR: '#d8b878',
  KILLER: '#a32330',
  GENERATOR: '#caa84e',
  GENERATOR_DONE: '#e8e07a',
  PALLET: '#8a6b43',
  WINDOW: '#6e87a8',
  HOOK: '#7a4a4a',
  GATE: '#4e6e4e',
};
