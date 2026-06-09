// WebAudio: terror radius heartbeat and one-shot stingers.
// The AudioContext can only start after a user gesture, so we lazily
// resume it on the first keydown.

let ctx = null;
let heartbeatTimer = 0;

function ensureContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

window.addEventListener('keydown', () => { ensureContext(); }, { once: false });

function thump(freq, when, gain, duration) {
  if (!ctx || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, when);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.55, when + duration);
  g.gain.setValueAtTime(gain, when);
  g.gain.exponentialRampToValueAtTime(0.001, when + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + duration);
}

/**
 * Call every tick with terror intensity 0..1. Schedules lub-dub beats whose
 * rate and volume scale with how close the killer is.
 */
export function updateHeartbeat(intensity, dt) {
  if (!ctx || ctx.state !== 'running') return;
  if (intensity <= 0) {
    heartbeatTimer = 0;
    return;
  }
  heartbeatTimer -= dt;
  if (heartbeatTimer <= 0) {
    const now = ctx.currentTime;
    const gain = 0.12 + intensity * 0.25;
    thump(58, now, gain, 0.16);             // lub
    thump(48, now + 0.18, gain * 0.8, 0.2); // dub
    // 1.4s between beats far away, 0.45s when the killer is on you
    heartbeatTimer = 1.4 - intensity * 0.95;
  }
}

export function playStinger(kind) {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  switch (kind) {
    case 'gen-explode':
      thump(90, now, 0.35, 0.4);
      thump(45, now + 0.05, 0.4, 0.6);
      break;
    case 'gen-done': {
      // Rising two-note chime
      tone(440, now, 0.12, 0.25);
      tone(660, now + 0.18, 0.12, 0.35);
      break;
    }
    case 'skillcheck-warn':
      tone(880, now, 0.1, 0.09);
      break;
    case 'skillcheck-great':
      tone(990, now, 0.08, 0.12);
      break;
    case 'chase-start':
      thump(140, now, 0.3, 0.5);
      break;
    case 'survivor-hit':
      tone(220, now, 0.3, 0.15);
      thump(70, now + 0.02, 0.35, 0.3);
      break;
    case 'survivor-downed':
      thump(60, now, 0.4, 0.7);
      thump(40, now + 0.2, 0.35, 0.8);
      break;
    case 'picked-up':
      tone(180, now, 0.2, 0.2);
      break;
    case 'hooked':
      // Harsh descending scrape
      tone(520, now, 0.25, 0.12);
      tone(330, now + 0.1, 0.25, 0.2);
      thump(55, now + 0.2, 0.4, 0.8);
      break;
    case 'hook-stage-2':
      thump(50, now, 0.4, 1.0);
      break;
    case 'sacrificed':
      thump(45, now, 0.45, 1.6);
      tone(140, now + 0.3, 0.2, 1.0);
      break;
    case 'pallet-drop':
      thump(85, now, 0.3, 0.25);
      break;
    case 'pallet-stun':
      tone(300, now, 0.3, 0.1);
      thump(110, now + 0.03, 0.35, 0.4);
      break;
    case 'pallet-break':
      thump(75, now, 0.3, 0.2);
      thump(95, now + 0.12, 0.25, 0.2);
      break;
    case 'vault':
      tone(260, now, 0.08, 0.12);
      break;
    case 'endurance-hit':
      tone(440, now, 0.2, 0.12);
      tone(440, now + 0.1, 0.15, 0.2);
      break;
    case 'self-unhook':
    case 'unhooked':
    case 'wiggle-free':
    case 'healed':
      tone(550, now, 0.15, 0.2);
      tone(740, now + 0.15, 0.15, 0.3);
      break;
    case 'gates-powered':
      tone(392, now, 0.18, 0.3);
      tone(523, now + 0.2, 0.18, 0.3);
      tone(659, now + 0.4, 0.18, 0.5);
      break;
    case 'gate-open':
      thump(80, now, 0.3, 0.6);
      tone(330, now + 0.3, 0.15, 0.4);
      break;
    case 'hatch-open':
      tone(196, now, 0.15, 0.8);
      break;
    case 'escaped':
      tone(523, now, 0.2, 0.25);
      tone(659, now + 0.18, 0.2, 0.25);
      tone(784, now + 0.36, 0.2, 0.5);
      break;
  }
}

function tone(freq, when, gain, duration) {
  if (!ctx || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, when);
  g.gain.setValueAtTime(gain, when);
  g.gain.exponentialRampToValueAtTime(0.001, when + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + duration);
}
