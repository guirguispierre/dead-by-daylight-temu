import { GAME, COLORS } from './config.js';
import { input } from './input.js';
import { createSurvivor, updateSurvivor, STANCE } from './survivor.js';
import { generateMap, collideWithMap } from './map.js';
import { drawMap } from './render.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- World state ---
const map = generateMap((Math.random() * 2 ** 32) >>> 0);
const survivor = createSurvivor(map.survivorSpawn.x, map.survivorSpawn.y);

const world = {
  map,
  survivor,
  camera: { x: survivor.x, y: survivor.y },
  collide: (x, y, radius) => collideWithMap(map, survivor.x, survivor.y, x, y, radius),
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

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(Math.round(w / 2 - cam.x), Math.round(h / 2 - cam.y));

  drawMap(ctx, world.map, cam.x - w / 2, cam.y - h / 2, w, h);
  drawSurvivor(world.survivor);

  ctx.restore();
}

function drawSurvivor(s) {
  const r = s.stance === STANCE.CROUCH ? s.radius * 0.75 : s.radius;

  ctx.fillStyle = COLORS.SURVIVOR;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x + Math.cos(s.facing) * r * 1.4, s.y + Math.sin(s.facing) * r * 1.4);
  ctx.stroke();
}

requestAnimationFrame(frame);
