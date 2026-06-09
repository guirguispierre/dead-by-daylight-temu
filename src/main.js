import { GAME, COLORS } from './config.js';
import { input } from './input.js';
import {
  createSurvivor, updateSurvivor, updateHooked, unhookSurvivor,
  STANCE, HEALTH, SELF_HEAL_SECONDS,
} from './survivor.js';
import { createBot, updateBot } from './bot.js';
import { generateMap, collideWithMap, vaultLanding } from './map.js';
import { drawMap } from './render.js';
import { createRng } from './rng.js';
import {
  startRepair, updateRepair, cancelAction, generatorsDone, updateRegression,
  spawnSkillCheck, advanceSkillCheck,
} from './generators.js';
import { REGRESS_PER_SEC } from './killer.js';
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

// Three AI teammates spawn near the player (push-out resolves overlaps)
const bots = [0, 1, 2].map(i => {
  const raw = createBot(map.survivorSpawn.x + (i + 1) * 22, map.survivorSpawn.y + (i % 2 ? 22 : -22), i);
  const safe = collideWithMap(map, raw.x, raw.y, raw.x, raw.y, raw.radius);
  raw.x = safe.x;
  raw.y = safe.y;
  return raw;
});

const world = {
  map,
  rng,
  survivor,
  bots,
  survivors: [survivor, ...bots],
  killer,
  started: false,
  camera: { x: survivor.x, y: survivor.y },
  prompt: null,
  events: [],   // transient per-tick events (gen explosions, etc.)
  gatesPowered: false,
  collapseTimer: null,  // endgame collapse countdown, starts when a gate opens
  escaped: false,
  scratches: [],        // {x, y, age} marks left by running survivors
  collide: (x, y, radius) => collideWithMap(map, survivor.x, survivor.y, x, y, radius),
};

const GATE_OPEN_SECONDS = 20; // matches DBD
const COLLAPSE_SECONDS = 120;
const UNHOOK_SECONDS = 1;
const HEAL_OTHER_SECONDS = 16; // altruistic heal

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

const WIGGLE_FILL_SECONDS = 16; // matches DBD wiggle
const FAST_VAULT_SECONDS = 0.5;  // sprinting vault
const MED_VAULT_SECONDS = 0.9;   // standing vault
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

const NO_INPUT = { interactPressed: false };
const GLOBAL_STINGERS = new Set([
  'gen-done', 'gen-explode', 'gen-kick', 'gates-powered', 'gate-open', 'hatch-open', 'pallet-break',
]);

function tick(dt) {
  const s = world.survivor;
  world.events.length = 0;
  world.prompt = null;

  if (!world.started) {
    if (input.wasPressed('Enter') || input.interactPressed) world.started = true;
    input.endFrame();
    return;
  }

  if (world.escaped) {
    if (input.wasPressed('KeyR')) location.reload();
    input.endFrame();
    return;
  }

  // Powering milestones
  if (!world.gatesPowered && generatorsDone(world.map) >= GAME.GENERATORS_REQUIRED) {
    world.gatesPowered = true;
    world.events.push({ type: 'gates-powered' });
  }
  // Hatch opens when the player is the last survivor standing (real rule)
  if (!world.map.hatch.open && world.bots.every(b => b.health === HEALTH.DEAD)) {
    world.map.hatch.open = true;
    world.events.push({ type: 'hatch-open' });
  }

  // Count repairers per generator (for the co-op efficiency penalty)
  for (const g of world.map.generators) g.crew = 0;
  if (s.action && s.action.type === 'repair') s.action.gen.crew++;
  for (const b of world.bots) {
    if ((b.health === HEALTH.HEALTHY || b.health === HEALTH.INJURED) &&
        b.goal && b.goal.kind === 'repair' && !b.goal.target.done &&
        Math.hypot(b.goal.target.x - b.x, b.goal.target.y - b.y) <= 2.2 * 16) {
      b.goal.target.crew++;
    }
  }

  // Kicked/exploded generators bleed progress until tapped back +5%
  updateRegression(world.map, dt, REGRESS_PER_SEC);

  // Endgame collapse
  if (world.collapseTimer !== null && s.health !== HEALTH.DEAD) {
    world.collapseTimer -= dt;
    if (world.collapseTimer <= 0) {
      s.health = HEALTH.DEAD;
      world.deathCause = 'collapse';
      world.events.push({ type: 'sacrificed' });
    }
  }

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
        } else if (s.action.type === 'heal' || s.action.type === 'heal-other') {
          updateHealAction(s, dt);
        } else if (s.action.type === 'unhook') {
          const t = s.action.target;
          if (t.health !== HEALTH.HOOKED) { s.action = null; }
          else {
            s.action.timer -= dt;
            if (s.action.timer <= 0) {
              unhookSurvivor(t);
              world.events.push({ type: 'unhooked', who: t });
              s.action = null;
            }
          }
        } else if (s.action.type === 'open-gate') {
          const gate = s.action.gate;
          gate.progress += dt / GATE_OPEN_SECONDS;
          if (gate.progress >= 1) {
            gate.progress = 1;
            gate.open = true;
            s.action = null;
            world.events.push({ type: 'gate-open' });
            if (world.collapseTimer === null) world.collapseTimer = COLLAPSE_SECONDS;
          }
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
          } else if (interaction.type === 'open-gate') {
            s.action = { type: 'open-gate', gate: interaction.target };
          } else if (interaction.type === 'unhook') {
            s.action = { type: 'unhook', target: interaction.target, timer: UNHOOK_SECONDS };
          } else if (interaction.type === 'heal-other') {
            s.action = { type: 'heal-other', target: interaction.target, skillCheck: null };
          } else if (interaction.type === 'drop-pallet') {
            dropPallet(interaction.target);
          } else if (interaction.type === 'vault') {
            const landing = vaultLanding(world.map, interaction.target, s.x, s.y);
            if (landing) {
              // Fast vault when sprinting into it, medium otherwise
              const duration = s.stance === STANCE.RUN ? FAST_VAULT_SECONDS : MED_VAULT_SECONDS;
              s.action = { type: 'vault', timer: duration, landing };
              world.events.push({ type: 'vault' });
            }
          }
          world.prompt = null;
        }
      }
    }
  }

  // Running survivors leave scratch marks the killer can track
  for (const sv of world.survivors) {
    if ((sv.health === HEALTH.HEALTHY || sv.health === HEALTH.INJURED) &&
        sv.moving && sv.stance === STANCE.RUN) {
      sv.scratchTimer = (sv.scratchTimer || 0) - dt;
      if (sv.scratchTimer <= 0) {
        world.scratches.push({ x: sv.x, y: sv.y, age: 0 });
        sv.scratchTimer = 0.25;
      }
    }
  }
  for (const m of world.scratches) m.age += dt;
  if (world.scratches.length && world.scratches[0].age > SCRATCH_LIFETIME) {
    world.scratches = world.scratches.filter(m => m.age <= SCRATCH_LIFETIME);
  }

  checkEscape(s);

  // Teammates
  for (const b of world.bots) {
    if (b.health === HEALTH.HOOKED) {
      const ev = updateHooked(b, NO_INPUT, dt, world.rng);
      if (ev) world.events.push({ type: ev, who: b });
    } else {
      updateBot(b, world, dt);
    }
  }

  updateKiller(world.killer, world, dt);

  // Terror radius heartbeat + event stingers (skip bot-personal events)
  updateHeartbeat(terrorIntensity(world.killer, s), dt);
  for (const e of world.events) {
    if (!e.who || e.who === s || GLOBAL_STINGERS.has(e.type)) playStinger(e.type);
  }

  // Camera follows survivor with slight smoothing
  const cam = world.camera;
  cam.x += (s.x - cam.x) * 0.12;
  cam.y += (s.y - cam.y) * 0.12;

  input.endFrame();
}

const SCRATCH_LIFETIME = 10;           // seconds scratch marks linger

const HEAL_SKILLCHECK_CHANCE = 0.15;   // per second while healing
const HEAL_GREAT_BONUS = 0.03;         // great healing skill check
const HEAL_MISS_PENALTY = 0.10;        // plus a loud noise the killer hears

// Player-driven healing (self via Self-Care speed, or a teammate).
// Progress lives on the patient so partial heals persist.
function updateHealAction(s, dt) {
  const isOther = s.action.type === 'heal-other';
  const t = isOther ? s.action.target : s;

  const healable = isOther
    ? (t.health === HEALTH.INJURED || t.health === HEALTH.DOWNED)
    : t.health === HEALTH.INJURED;
  if (!healable) { s.action = null; return; }

  const sc = s.action.skillCheck;
  if (sc) {
    const result = advanceSkillCheck(sc, input, dt);
    if (!result) return;
    s.action.skillCheck = null;
    if (result === 'great') {
      t.healProgress = Math.min(1, (t.healProgress || 0) + HEAL_GREAT_BONUS);
      world.events.push({ type: 'skillcheck-great' });
    } else if (result === 'good') {
      world.events.push({ type: 'skillcheck-good' });
    } else {
      t.healProgress = Math.max(0, (t.healProgress || 0) - HEAL_MISS_PENALTY);
      // Botched needlework is loud — the killer hears it
      world.events.push({ type: 'heal-fail', x: s.x, y: s.y });
    }
    return;
  }

  const duration = isOther ? HEAL_OTHER_SECONDS : SELF_HEAL_SECONDS;
  t.healProgress = (t.healProgress || 0) + dt / duration;

  if (world.rng.chance(HEAL_SKILLCHECK_CHANCE * dt)) {
    s.action.skillCheck = spawnSkillCheck(world.rng);
    world.events.push({ type: 'skillcheck-warn' });
  }

  if (t.healProgress >= 1) {
    t.healProgress = 0;
    t.health = t.health === HEALTH.DOWNED ? HEALTH.INJURED : HEALTH.HEALTHY;
    s.action = null;
    world.events.push({ type: 'healed', who: isOther ? t : undefined });
  }
}

function checkEscape(s) {
  if (s.health !== HEALTH.HEALTHY && s.health !== HEALTH.INJURED &&
      s.health !== HEALTH.DOWNED) return;

  // Through an open exit gate
  const cx = Math.floor(s.x / 16);
  const cy = Math.floor(s.y / 16);
  for (const gate of world.map.gates) {
    if (gate.open && gate.cells.some(c => c.cx === cx && c.cy === cy)) {
      escape();
      return;
    }
  }

  // Into the hatch
  const hatch = world.map.hatch;
  if (hatch.open && Math.hypot(hatch.x - s.x, hatch.y - s.y) < 14) {
    escape();
  }
}

function escape() {
  world.escaped = true;
  world.events.push({ type: 'escaped' });
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
  drawScratches();
  drawKiller(world.killer);
  for (const b of world.bots) {
    drawSurvivor(b, b.color);
    if (b.health !== HEALTH.DEAD) {
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232, 227, 208, 0.8)';
      ctx.fillText(b.name, b.x, b.y - 12);
    }
  }
  drawSurvivor(world.survivor, COLORS.SURVIVOR);

  ctx.restore();

  drawTerrorVignette(w, h);
  drawHud(ctx, world, w, h);
  if (!world.started) drawMenuOverlay(w, h);
  else if (world.escaped) drawEscapeOverlay(w, h);
  else if (world.survivor.health === HEALTH.DEAD) drawDeathOverlay(w, h);
}

function drawMenuOverlay(w, h) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#a32330';
  ctx.font = '800 54px system-ui, sans-serif';
  ctx.fillText('DEAD BY DAYLIGHT', w / 2, h / 2 - 70);
  ctx.fillStyle = '#caa84e';
  ctx.font = '700 30px system-ui, sans-serif';
  ctx.fillText('✦ TEMU EDITION ✦', w / 2, h / 2 - 28);
  ctx.fillStyle = '#e8e3d0';
  ctx.font = '400 17px system-ui, sans-serif';
  const lines = [
    'Repair 5 generators with your team, then escape through an exit gate.',
    'WASD move · Shift run · Ctrl sneak · Space interact / skill checks',
    'The Killer hears you run. Drop pallets on its head. Good luck.',
    '',
    'Press Enter to enter the fog',
  ];
  lines.forEach((line, i) => ctx.fillText(line, w / 2, h / 2 + 14 + i * 26));
}

function drawEscapeOverlay(w, h) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9bc995';
  ctx.font = '700 52px system-ui, sans-serif';
  ctx.fillText('ESCAPED', w / 2, h / 2 - 20);
  ctx.fillStyle = '#e8e3d0';
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText('You live to be camped another day. Press R to play again.', w / 2, h / 2 + 28);
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

function drawScratches() {
  for (const m of world.scratches) {
    const alpha = 0.45 * (1 - m.age / SCRATCH_LIFETIME);
    if (alpha <= 0) continue;
    ctx.fillStyle = `rgba(190, 30, 35, ${alpha.toFixed(3)})`;
    ctx.fillRect(m.x - 1.5, m.y - 1.5, 3, 3);
  }
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

function drawSurvivor(s, baseColor) {
  if (s.health === HEALTH.DEAD) return;

  const r = s.stance === STANCE.CROUCH ? s.radius * 0.75 : s.radius;

  if (s.health === HEALTH.DOWNED) {
    // Crawling in a pool of blood
    ctx.fillStyle = 'rgba(140, 20, 25, 0.5)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 1.8, r * 1.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 1.3, r * 0.7, s.facing, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.fillStyle = s.health === HEALTH.INJURED ? '#c08458' : baseColor;
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
