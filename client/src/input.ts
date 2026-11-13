// Input mask (docs/CLIENT-API.md): 1 left, 2 right, 4 up/jump, 8 down,
// 16 force push (X), 32 rocket (Z), 64 bat (C), 128 grab/parachute (V).
// Keyboard by physical key (e.code), touch via on-screen buttons.

export const BIT = {
  LEFT: 1,
  RIGHT: 2,
  UP: 4,
  DOWN: 8,
  PUSH: 16,
  ROCKET: 32,
  BAT: 64,
  GRAB: 128,
} as const;

const KEYS: Record<string, number> = {
  KeyA: BIT.LEFT,
  ArrowLeft: BIT.LEFT,
  KeyD: BIT.RIGHT,
  ArrowRight: BIT.RIGHT,
  KeyW: BIT.UP,
  ArrowUp: BIT.UP,
  Space: BIT.UP,
  KeyS: BIT.DOWN,
  ArrowDown: BIT.DOWN,
  KeyX: BIT.PUSH,
  KeyZ: BIT.ROCKET,
  KeyC: BIT.BAT,
  KeyV: BIT.GRAB,
};

function typingInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

export class Input {
  private keys = 0;
  private touch = 0;
  /** Called for keys that are not movement (e.g. Tab, F3). */
  onKey: ((code: string, down: boolean) => void) | null = null;

  constructor() {
    window.addEventListener("keydown", (e) => this.handle(e, true));
    window.addEventListener("keyup", (e) => this.handle(e, false));
    window.addEventListener("blur", () => {
      this.keys = 0;
    });
    // A key released while a text field has focus never reaches keyup here, so drop held bits.
    window.addEventListener("focusin", () => {
      if (typingInField()) this.keys = 0;
    });
  }

  private handle(e: KeyboardEvent, down: boolean): void {
    if (typingInField()) return;
    const bit = KEYS[e.code];
    if (bit !== undefined) {
      e.preventDefault();
      this.keys = down ? this.keys | bit : this.keys & ~bit;
      return;
    }
    this.onKey?.(e.code, down);
  }

  /** Touch buttons call this with their bit. */
  setTouch(bit: number, on: boolean): void {
    this.touch = on ? this.touch | bit : this.touch & ~bit;
  }

  clearTouch(): void {
    this.touch = 0;
  }

  mask(): number {
    return this.keys | this.touch | readPad();
  }
}

// Standard gamepad mapping: d-pad and left stick move, A jumps, X pushes, B bats,
// Y or RB rocket, LB grabs.
const PAD_BUTTONS: [number, number][] = [
  [0, BIT.UP],
  [12, BIT.UP],
  [13, BIT.DOWN],
  [14, BIT.LEFT],
  [15, BIT.RIGHT],
  [2, BIT.PUSH],
  [1, BIT.BAT],
  [3, BIT.ROCKET],
  [5, BIT.ROCKET],
  [4, BIT.GRAB],
];
const STICK_DEAD = 0.5;

function readPad(): number {
  // The Gamepad API is absent in insecure contexts (plain http) and some WebKit builds.
  if (typeof navigator.getGamepads !== "function") return 0;
  let m = 0;
  for (const pad of navigator.getGamepads()) {
    if (!pad) continue;
    for (const [button, bit] of PAD_BUTTONS) if (pad.buttons[button]?.pressed === true) m |= bit;
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    if (x < -STICK_DEAD) m |= BIT.LEFT;
    if (x > STICK_DEAD) m |= BIT.RIGHT;
    if (y < -STICK_DEAD) m |= BIT.UP;
    if (y > STICK_DEAD) m |= BIT.DOWN;
  }
  return m;
}
