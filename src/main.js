import { GAME, COLORS } from './config.js';
import { input } from './input.js';
import { createSurvivor, updateSurvivor, STANCE } from './survivor.js';
import { generateMap, collideWithMap } from './map.js';
import { drawMap } from './render.js';
import { createRng } from './rng.js';
import { startRepair, updateRepair, cancelAction } from './generators.js';
import { findInteraction } from './interact.js';
import { drawHud } from './hud.js';
import { createKiller, updateKiller, terrorIntensity } from './killer.js';
import { updateHeartbeat, playStinger } from './audio.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- World state ---
const seed = (Math.random() * 2 ** 32) >>> 0;
const map = generateMap(seed);
const rng = createRng(seed ^ 0x9e3779b9); // separate stream for gameplay rolls
const survivor = createSurvivor(map.survivorSpawn.x, map.survivorSpawn.y);
const killer = createKiller(map.killerSpawn.x, map.killerSpawn.y);

const world = {
  map,
  rng,
  survivor,
  killer,
  camera: { x: survivor.x, y: survivor.y },
  prompt: null,
  events: [],   // transient per-tick events (gen explosions, etc.)
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
  const s = world.survivor;
  world.events.length = 0;

  if (s.action) {
    // Any movement input breaks the interaction
    if (input.moveX !== 0 || input.moveY !== 0) {
      cancelAction(s);
    } else if (s.action.type === 'repair') {
      world.events.push(...updateRepair(s, input, dt, world.rng));
    }
    world.prompt = null;
  } else {
    updateSurvivor(s, input, dt, world.collide);

    const interaction = findInteraction(world);
    world.prompt = interaction ? interaction.label : null;
    if (interaction && input.interactPressed) {
      if (interaction.type === 'repair') {
        startRepair(s, interaction.target, world.rng);
        world.prompt = null;
      }
    }
  }

  updateKiller(world.killer, world, dt);

  // Terror radius heartbeat + event stingers
  updateHeartbeat(terrorIntensity(world.killer, s), dt);
  for (const e of world.events) playStinger(e.type);

  // Camera follows survivor with slight smoothing
  const cam = world.camera;
  cam.x += (s.x - cam.x) * 0.12;
  cam.y += (s.y - cam.y) * 0.12;

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
  drawKiller(world.killer);
  drawSurvivor(world.survivor);

  ctx.restore();

  drawTerrorVignette(w, h);
  drawHud(ctx, world, w, h);
}

function drawKiller(k) {
  ctx.fillStyle = COLORS.KILLER;
  ctx.beginPath();
  ctx.arc(k.x, k.y, k.radius, 0, Math.PI * 2);
  ctx.fill();

  // Glowing eyes in the facing direction
  const ex = Math.cos(k.facing);
  const ey = Math.sin(k.facing);
  const px = -ey, py = ex; // perpendicular
  ctx.fillStyle = '#ffd9a0';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(
      k.x + ex * k.radius * 0.55 + px * side * 3,
      k.y + ey * k.radius * 0.55 + py * side * 3,
      1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTerrorVignette(w, h) {
  const intensity = terrorIntensity(world.killer, world.survivor);
  if (intensity <= 0) return;
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.7);
  grad.addColorStop(0, 'rgba(120, 10, 20, 0)');
  grad.addColorStop(1, `rgba(120, 10, 20, ${0.35 * intensity})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
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
