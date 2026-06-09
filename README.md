# Dead by Daylight: Temu Edition 🪝

A loving, budget recreation of the asymmetric horror game *Dead by Daylight*,
built from scratch with zero dependencies — plain HTML5 canvas + JavaScript.

You are a **Survivor**, with three AI teammates (Dwight, Meg and Claudette,
naturally). An AI-controlled **Killer** stalks the map. Repair generators,
dodge the killer, drop pallets on its head, rescue your friends, and escape
through the exit gates — or the hatch, if you're the last one standing.

## Play

Open `index.html` in a browser. That's it. No build step, no install.

```
open index.html
```

## The trial

- 🔧 Repair **5 generators** (hold to repair, hit **skill checks** — miss and
  the gen explodes, telling the killer exactly where you are)
- 💓 Listen for the **terror radius** heartbeat — the killer is near
- 🪵 Drop **pallets** to stun the killer mid-chase; vault **windows** and
  dropped pallets; the killer has to smash its way through
- 🩸 Health states: Healthy → Injured → Downed → Carried → **Hooked**
- 🪝 Two hook stages, three 4% self-unhook attempts, third hook = sacrifice
- 🤝 Unhook and heal your AI teammates; they'll repair gens, take chases,
  rescue you and heal you back
- 🚪 Power the gates, open one (hold 15s) and walk out — opening a gate
  starts the 120s **Endgame Collapse**
- 🕳️ All teammates dead? The **hatch** opens somewhere on the map

## Controls

| Key | Action |
|-----|--------|
| WASD / arrows | Move (mash A/D to wiggle when carried) |
| Shift | Run (the killer hears you) |
| Ctrl | Sneak (crouch — much harder to spot) |
| Space | Interact: repair / skill check / vault / drop pallet / unhook / heal / open gate / hook escape attempt |
| Enter | Start |
| R | Restart after the trial ends |

## Fidelity

Mechanics are tuned to publicly documented values from the real game:

- Speeds: survivor 4.0 m/s run / 2.26 walk / 1.13 crouch / 0.7 crawl; killer 4.6 m/s, 3.68 carrying
- Generators: 90s solo, −15% per extra repairer co-op penalty; killer kick = 1.8s, −5%, then −0.25 c/s regression until +5% repaired back
- Skill checks: 8%/s repairing, 15%/s healing; great +1% (repair) / +3% (heal); miss = −10%, explosion noise, 3s stall
- Chases: bloodlust +0.2/0.4/0.6 m/s at 15/25/35s; lunge 6.9 m/s for 0.3s; hit = 2.7s weapon wipe, whiff = 1.5s recovery
- Hooks: two 70s stages; 4% self-unhook ×3 (−20s per fail); struggle-phase skill checks at −20s per miss; 3rd hook = sacrifice; basekit 10s endurance after an unhook
- Tracking: scratch marks linger 10s, injured grunts audible ~5m, running heard ~8m through walls, red stain shows the killer's gaze
- Misc: 16s heals (Self-Care 45.7s), 20s exit gates, 16s wiggle, fast/medium vaults (0.5s/0.9s), hatch for the last survivor standing

## How it's built

- `src/map.js` — seeded procedural maps from prefab loop tiles (killer shack
  included), circle-vs-AABB push-out collision, line of sight
- `src/killer.js` — A* pathfinding with clearance-aware smoothing; states:
  patrol → chase → search, plus pickup / carry / break / stunned
- `src/bot.js` — teammate AI: repair, flee to pallets, slam them on the
  killer, rescue, heal, leave through the gates
- `src/generators.js`, `src/survivor.js`, `src/interact.js`, `src/hud.js`,
  `src/audio.js` (WebAudio heartbeat + stingers), `src/render.js`

Everything was sim-tested headlessly in Node (chases, hooks, sacrifices,
full bot matches) before shipping.

## Development

All work happens on feature branches and lands on `main` via pull request —
`main` is protected by a ruleset and cannot be pushed to directly.
