import { GAME, COLORS, METER } from './config.js';
import { input } from './input.js';
import { createSurvivor, updateSurvivor, STANCE } from './survivor.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- World state (grows as features land) ---
const world = {
  survivor: createSurvivor(0, 0),
  camera: { x: 0, y: 0 },
  // No map yet: free movement on an open floor
  collide: (x, y) => ({ x, y }),
};

// --- Fixed-timestep loop ---
let last = performance.now();
let acc = 0;

function frame(now) {
  acc += Math.min((now - last) / 1000, 0.25); // clamp to avoid spiral of death
  last = now;

  while (acc >= GAME.TICK) {
    tick(GAME.TICK);
    acc -= GAME.TICK;
  }

  render();
  requestAnimationFrame(frame);
}

function tick(dt) {
  updateSurvivor(world.survivor, input, dt, world.collide);

  // Camera follows survivor with slight smoothing
  const cam = world.camera;
  cam.x += (world.survivor.x - cam.x) * 0.12;
  cam.y += (world.survivor.y - cam.y) * 0.12;

  input.endFrame();
}

// --- Rendering ---
function render() {
  const w = canvas.width;
  const h = canvas.height;
  const cam = world.camera;

  ctx.fillStyle = COLORS.FLOOR;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w / 2 - cam.x, h / 2 - cam.y);

  drawFloorGrid(w, h, cam);
  drawSurvivor(world.survivor);

  ctx.restore();
}

function drawFloorGrid(w, h, cam) {
  // Subtle checkerboard so motion is visible before the map exists
  const tile = 4 * METER;
  const x0 = Math.floor((cam.x - w / 2) / tile) * tile;
  const y0 = Math.floor((cam.y - h / 2) / tile) * tile;
  ctx.fillStyle = COLORS.FLOOR_ALT;
  for (let y = y0; y < cam.y + h / 2 + tile; y += tile) {
    for (let x = x0; x < cam.x + w / 2 + tile; x += tile) {
      if (((x / tile + y / tile) | 0) % 2 === 0) {
        ctx.fillRect(x, y, tile, tile);
      }
    }
  }
}

function drawSurvivor(s) {
  const r = s.stance === STANCE.CROUCH ? s.radius * 0.75 : s.radius;

  // Body
  ctx.fillStyle = COLORS.SURVIVOR;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();

  // Facing indicator
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x + Math.cos(s.facing) * r * 1.4, s.y + Math.sin(s.facing) * r * 1.4);
  ctx.stroke();
}

requestAnimationFrame(frame);
