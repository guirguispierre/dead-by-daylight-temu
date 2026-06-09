import { GAME, COLORS } from './config.js';
import { input } from './input.js';
import {
  createSurvivor, updateSurvivor, updateHooked, updateHeal, STANCE, HEALTH,
} from './survivor.js';
import { generateMap, collideWithMap, vaultLanding } from './map.js';
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

const WIGGLE_FILL_SECONDS = 14;
const VAULT_SECONDS = 0.5;
const PALLET_STUN_RANGE = 1.8 * 16; // pallet smacks the killer within this range

function dropPallet(pallet) {
  pallet.state = 'dropped';
  world.events.push({ type: 'pallet-drop' });
  const k = world.killer;
  if (Math.hypot(k.x - pallet.x, k.y - pallet.y) < PALLET_STUN_RANGE &&
      k.state !== 'carry') {
    k.state = 'stunned';
    k.stunTimer = 2.0;
    k.path = null;
    world.events.push({ type: 'pallet-stun' });
  }
}

function tick(dt) {
  const s = world.survivor;
  world.events.length = 0;
  world.prompt = null;

  switch (s.health) {
    case HEALTH.DEAD: {
      if (input.wasPressed('KeyR')) location.reload();
      break;
    }

    case HEALTH.HOOKED: {
      const ev = updateHooked(s, input, dt, world.rng);
      if (ev) world.events.push({ type: ev });
      if (s.health === HEALTH.DEAD) world.deathCause = 'sacrificed';
      break;
    }

    case HEALTH.CARRIED: {
      // Wiggle fills passively; mashing A/D speeds it up
      s.wiggle += dt / WIGGLE_FILL_SECONDS;
      if (input.wasPressed('KeyA') || input.wasPressed('KeyD') ||
          input.wasPressed('ArrowLeft') || input.wasPressed('ArrowRight')) {
        s.wiggle += 0.02;
      }
      break;
    }

    default: {
      // healthy / injured / downed
      if (s.action) {
        if (s.action.type === 'vault') {
          // Committed: can't be cancelled
          s.action.timer -= dt;
          if (s.action.timer <= 0) {
            s.x = s.action.landing.x;
            s.y = s.action.landing.y;
            s.action = null;
          }
        } else if (input.moveX !== 0 || input.moveY !== 0) {
          // Any movement input breaks other interactions
          cancelAction(s);
        } else if (s.action.type === 'repair') {
          world.events.push(...updateRepair(s, input, dt, world.rng));
        } else if (s.action.type === 'heal') {
          const ev = updateHeal(s, dt);
          if (ev) world.events.push({ type: ev });
        }
      } else {
        updateSurvivor(s, input, dt, world.collide);

        if (s.health === HEALTH.DOWNED) {
          if (s.bleedOut <= 0) {
            s.health = HEALTH.DEAD;
            world.deathCause = 'bled-out';
            world.events.push({ type: 'sacrificed' });
          }
          break;
        }

        const interaction = findInteraction(world);
        world.prompt = interaction ? interaction.label : null;
        if (interaction && input.interactPressed) {
          if (interaction.type === 'repair') {
            startRepair(s, interaction.target, world.rng);
          } else if (interaction.type === 'heal') {
            s.action = { type: 'heal' };
          } else if (interaction.type === 'drop-pallet') {
            dropPallet(interaction.target);
          } else if (interaction.type === 'vault') {
            const landing = vaultLanding(world.map, interaction.target, s.x, s.y);
            if (landing) {
              s.action = { type: 'vault', timer: VAULT_SECONDS, landing };
              world.events.push({ type: 'vault' });
            }
          }
          world.prompt = null;
        }
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
  if (world.survivor.health === HEALTH.DEAD) drawDeathOverlay(w, h);
}

function drawDeathOverlay(w, h) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#a32330';
  ctx.font = '700 52px system-ui, sans-serif';
  ctx.fillText(
    world.deathCause === 'bled-out' ? 'YOU BLED OUT' : 'SACRIFICED',
    w / 2, h / 2 - 20);
  ctx.fillStyle = '#e8e3d0';
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText('The Entity is pleased. Press R to try again.', w / 2, h / 2 + 28);
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
  if (s.health === HEALTH.DEAD) return;

  const r = s.stance === STANCE.CROUCH ? s.radius * 0.75 : s.radius;

  if (s.health === HEALTH.DOWNED) {
    // Crawling in a pool of blood
    ctx.fillStyle = 'rgba(140, 20, 25, 0.5)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 1.8, r * 1.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.SURVIVOR;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 1.3, r * 0.7, s.facing, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.fillStyle = s.health === HEALTH.INJURED ? '#c08458' : COLORS.SURVIVOR;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();

  if (s.health === HEALTH.INJURED) {
    // Blood speckles
    ctx.fillStyle = 'rgba(163, 35, 48, 0.85)';
    ctx.beginPath();
    ctx.arc(s.x + r * 0.3, s.y - r * 0.2, 2, 0, Math.PI * 2);
    ctx.arc(s.x - r * 0.35, s.y + r * 0.3, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (s.health === HEALTH.HOOKED) {
    // Slumped on the hook: arms up line
    ctx.strokeStyle = COLORS.HOOK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - r);
    ctx.lineTo(s.x, s.y - r - 6);
    ctx.stroke();
  }

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x + Math.cos(s.facing) * r * 1.4, s.y + Math.sin(s.facing) * r * 1.4);
  ctx.stroke();
}

requestAnimationFrame(frame);
