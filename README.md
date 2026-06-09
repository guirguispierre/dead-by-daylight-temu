# Dead by Daylight: Temu Edition 🪝

A loving, budget recreation of the asymmetric horror game *Dead by Daylight*,
built from scratch with zero dependencies — plain HTML5 canvas + JavaScript.

You are a **Survivor**. An AI-controlled **Killer** stalks the map. Repair
generators, dodge the killer, drop pallets on its head, and escape through
the exit gates — or find the hatch if all else fails.

## Play

Open `index.html` in a browser. That's it. No build step, no install.

```
open index.html
```

## Core loop (just like the real thing, but cheaper)

- 🔧 Repair **5 generators** (hold to repair, hit **skill checks**)
- 💓 Listen for the **terror radius** heartbeat — the killer is near
- 🪵 Vault **windows** and drop **pallets** to stun the killer mid-chase
- 🩸 Health states: Healthy → Injured → Downed → **Hooked**
- 🪝 Get hooked three times and you're sacrificed to the Entity
- 🚪 Power the **exit gates** and escape — or find the **hatch**

## Controls

| Key | Action |
|-----|--------|
| WASD | Move |
| Shift | Run |
| Ctrl | Crouch |
| Space | Interact (repair / vault / drop pallet / open gate) |
| Esc | Pause |

## Development

All work happens on feature branches and lands on `main` via pull request —
`main` is protected by a ruleset and cannot be pushed to directly.
