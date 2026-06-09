// Screen-space HUD: generator counter, interaction prompts, action progress,
// and the skill check dial.

import { skillCheckGeometry, generatorsRemaining } from './generators.js';
import { HEALTH, HOOK_STAGE_SECONDS } from './survivor.js';

export function drawHud(ctx, world, w, h) {
  drawGenCounter(ctx, world, w, h);
  drawHealthState(ctx, world, w, h);
  drawPrompt(ctx, world, w, h);
  drawActionProgress(ctx, world, w, h);
  drawSkillCheck(ctx, world, w, h);
  drawStatusBars(ctx, world, w, h);
}

const HEALTH_LABELS = {
  [HEALTH.HEALTHY]: ['Healthy', '#9bc995'],
  [HEALTH.INJURED]: ['Injured', '#d9a05b'],
  [HEALTH.DOWNED]: ['Dying — crawl away!', '#c0392b'],
  [HEALTH.CARRIED]: ['Carried — mash A/D to wiggle!', '#c0392b'],
  [HEALTH.HOOKED]: ['Hooked', '#a32330'],
  [HEALTH.DEAD]: ['Dead', '#666'],
};

function drawHealthState(ctx, world, w, h) {
  const [label, color] = HEALTH_LABELS[world.survivor.health] ?? ['?', '#fff'];
  ctx.save();
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  ctx.fillText(label, 24, h - 70);
  ctx.restore();
}

function bar(ctx, x, y, w, h, frac, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = '#2a2a33';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
}

function drawStatusBars(ctx, world, w, h) {
  const s = world.survivor;
  ctx.save();
  ctx.font = '500 14px system-ui, sans-serif';
  ctx.textAlign = 'center';

  if (s.health === HEALTH.CARRIED) {
    bar(ctx, w / 2 - 120, h * 0.72, 240, 12, s.wiggle, '#d9a05b');
    ctx.fillStyle = '#e8e3d0';
    ctx.fillText('WIGGLE!', w / 2, h * 0.72 - 10);
  }

  if (s.health === HEALTH.HOOKED && s.hookState) {
    const hs = s.hookState;
    bar(ctx, w / 2 - 120, h * 0.72, 240, 12, hs.timer / HOOK_STAGE_SECONDS, '#a32330');
    ctx.fillStyle = '#e8e3d0';
    const label = hs.stage === 1
      ? `Hook stage 1 — [Space] attempt escape (${hs.attemptsLeft} left, 4%)`
      : 'Hook stage 2 — the Entity closes in...';
    ctx.fillText(label, w / 2, h * 0.72 - 10);
  }

  if (s.action && s.action.type === 'heal') {
    bar(ctx, w / 2 - 120, h * 0.78, 240, 10, s.healProgress || 0, '#9bc995');
  }

  ctx.restore();
}

function drawGenCounter(ctx, world, w, h) {
  const remaining = generatorsRemaining(world.map);
  ctx.save();
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // Little generator icon
  const x = 24;
  const y = h - 40;
  ctx.fillStyle = '#caa84e';
  ctx.fillRect(x, y - 10, 20, 20);
  ctx.fillStyle = '#3a3014';
  ctx.fillRect(x + 4, y - 6, 12, 12);
  ctx.fillStyle = '#e8e3d0';
  ctx.fillText(`${remaining}`, x + 30, y + 1);
  ctx.restore();
}

function drawPrompt(ctx, world, w, h) {
  const prompt = world.prompt;
  if (!prompt) return;
  ctx.save();
  ctx.font = '500 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const text = `[Space] ${prompt}`;
  const tw = ctx.measureText(text).width;
  ctx.fillRect(w / 2 - tw / 2 - 12, h * 0.72 - 16, tw + 24, 32);
  ctx.fillStyle = '#e8e3d0';
  ctx.fillText(text, w / 2, h * 0.72 + 5);
  ctx.restore();
}

function drawActionProgress(ctx, world, w, h) {
  const s = world.survivor;
  if (!s.action || s.action.type !== 'repair') return;
  const progress = s.action.gen.progress;

  ctx.save();
  const bw = 240;
  const bh = 10;
  const x = w / 2 - bw / 2;
  const y = h * 0.78;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 4, y - 4, bw + 8, bh + 8);
  ctx.fillStyle = '#3a3014';
  ctx.fillRect(x, y, bw, bh);
  ctx.fillStyle = '#caa84e';
  ctx.fillRect(x, y, bw * progress, bh);
  ctx.restore();
}

function drawSkillCheck(ctx, world, w, h) {
  const s = world.survivor;
  const sc = s.action && s.action.skillCheck;
  if (!sc) return;

  const { ZONE_SIZE, GREAT_SIZE } = skillCheckGeometry();
  const cx = w / 2;
  const cy = h / 2 - 60;
  const r = 42;

  ctx.save();
  ctx.lineWidth = 5;

  // Dial
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Success zone (offset so angle 0 is at 12 o'clock)
  const base = -Math.PI / 2;
  ctx.strokeStyle = '#e8e3d0';
  ctx.beginPath();
  ctx.arc(cx, cy, r, base + sc.zoneStart, base + sc.zoneStart + ZONE_SIZE);
  ctx.stroke();

  // Great zone
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, r, base + sc.zoneStart, base + sc.zoneStart + GREAT_SIZE);
  ctx.stroke();

  // Needle
  const a = base + sc.angle;
  ctx.strokeStyle = '#d33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * (r + 8), cy + Math.sin(a) * (r + 8));
  ctx.stroke();

  ctx.restore();
}
