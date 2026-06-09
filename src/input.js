// Keyboard state tracker. Polled by the game loop each tick.

const down = new Set();
const pressedThisFrame = new Set();

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  down.add(e.code);
  pressedThisFrame.add(e.code);
  // Don't let space/arrows scroll the page
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  down.delete(e.code);
});

window.addEventListener('blur', () => {
  down.clear();
});

export const input = {
  isDown: (code) => down.has(code),
  /** True only on the tick the key first went down. */
  wasPressed: (code) => pressedThisFrame.has(code),
  /** Call once at the end of every tick. */
  endFrame: () => pressedThisFrame.clear(),

  // Semantic helpers
  get moveX() {
    return (down.has('KeyD') || down.has('ArrowRight') ? 1 : 0) -
           (down.has('KeyA') || down.has('ArrowLeft') ? 1 : 0);
  },
  get moveY() {
    return (down.has('KeyS') || down.has('ArrowDown') ? 1 : 0) -
           (down.has('KeyW') || down.has('ArrowUp') ? 1 : 0);
  },
  get run() {
    return down.has('ShiftLeft') || down.has('ShiftRight');
  },
  get crouch() {
    return down.has('ControlLeft') || down.has('ControlRight');
  },
  get interact() {
    return down.has('Space');
  },
  get interactPressed() {
    return pressedThisFrame.has('Space');
  },
};
