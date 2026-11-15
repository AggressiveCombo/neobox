// Input mask (docs/CLIENT-API.md): 1 left, 2 right, 4 up/jump, 8 down,
// 16 force push (X), 32 rocket (Z), 64 bat (C), 128 grab/parachute (V).
// Keyboard bindings come from prefs (by physical key, e.code); touch uses the
// on-screen buttons and gamepads use the standard mapping below.

import { ACTIONS, prefs, type Action, type KeyBindings } from "./prefs";

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

/** Keys the app itself uses (scoreboard, stats, chat, cancel); never bound to a game action. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["F3", "Tab", "Enter", "Escape"]);

function buildCodeBits(keys: KeyBindings): Map<string, number> {
  const map = new Map<string, number>();
  for (const { action, bit } of ACTIONS) {
    for (const code of keys[action]) {
      if (RESERVED_KEYS.has(code)) continue;
      map.set(code, (map.get(code) ?? 0) | bit);
    }
  }
  return map;
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  ArrowUp: "Up arrow",
  ArrowDown: "Down arrow",
  ArrowLeft: "Left arrow",
  ArrowRight: "Right arrow",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  MetaLeft: "Left Win",
  MetaRight: "Right Win",
  Backspace: "Backspace",
  CapsLock: "Caps Lock",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  NumpadEnter: "Numpad Enter",
};

/** Short human name for a `KeyboardEvent.code`, for the settings screen. */
export function keyLabel(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? code;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] ?? code;
  const pad = /^Numpad([0-9])$/.exec(code);
  if (pad) return `Numpad ${pad[1]}`;
  return KEY_NAMES[code] ?? code;
}

/** Gamepad controls (standard mapping, fixed), shown read-only in the settings. */
export const GAMEPAD_LABELS: Record<Action, string> = {
  left: "D-pad left, left stick",
  right: "D-pad right, left stick",
  up: "A, D-pad up, left stick up",
  down: "D-pad down, left stick down",
  push: "X",
  rocket: "Y or RB",
  bat: "B",
  grab: "LB",
};

function typingInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Touch input bits held by one source (the stick or the buttons). */
class TouchMask {
  private bits = 0;
  set(bit: number, on: boolean): void {
    this.bits = on ? this.bits | bit : this.bits & ~bit;
  }
  clear(): void {
    this.bits = 0;
  }
  get(): number {
    return this.bits;
  }
}

export class Input {
  private keys = 0;
  /** Stick and buttons have their own bits: Jump (UP) and the stick's up share a bit, so one must not clear the other. */
  private stick = new TouchMask();
  private buttons = new TouchMask();
  /** Physical keys currently down (bound or not), so bits stay right after a rebind. */
  private held = new Set<string>();
  private codeBits = buildCodeBits(prefs.value.keys);
  private pending: ((code: string | null) => void) | null = null;
  /** Called for keys that are not movement (e.g. Tab, F3). */
  onKey: ((code: string, down: boolean) => void) | null = null;

  constructor() {
    window.addEventListener("keydown", (e) => this.handle(e, true));
    window.addEventListener("keyup", (e) => this.handle(e, false));
    window.addEventListener("blur", () => {
      this.held.clear();
      this.settle(null);
      this.recompute();
    });
    // A key released while a text field has focus never reaches keyup here, so drop held bits.
    window.addEventListener("focusin", () => {
      if (typingInField()) {
        this.held.clear();
        this.recompute();
      }
    });
    prefs.subscribe((next) => {
      this.codeBits = buildCodeBits(next.keys);
      this.recompute();
    });
  }

  /**
   * Wait for the next key press, for rebinding. Resolves with its `KeyboardEvent.code`,
   * or null on Escape, blur, or when another capture starts. Game input is suppressed meanwhile.
   */
  captureNextKey(): Promise<string | null> {
    this.settle(null);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    this.pending = resolve;
    return promise;
  }

  /** Abort a pending `captureNextKey` (resolves it with null). */
  cancelCapture(): void {
    this.settle(null);
  }

  private settle(code: string | null): void {
    const done = this.pending;
    this.pending = null;
    done?.(code);
  }

  private handle(e: KeyboardEvent, down: boolean): void {
    if (this.pending) {
      if (down) {
        e.preventDefault();
        this.settle(e.code === "Escape" ? null : e.code);
      } else if (this.held.delete(e.code)) {
        this.recompute();
      }
      return;
    }
    if (typingInField()) return;
    const bound = this.codeBits.has(e.code);
    if (bound) e.preventDefault();
    if (down) this.held.add(e.code);
    else this.held.delete(e.code);
    this.recompute();
    if (!bound) this.onKey?.(e.code, down);
  }

  private recompute(): void {
    let m = 0;
    for (const code of this.held) m |= this.codeBits.get(code) ?? 0;
    this.keys = m;
  }

  /** Touch controls call this: `source` is "stick" (movement) or "buttons" (action buttons). */
  setTouch(source: "stick" | "buttons", bit: number, on: boolean): void {
    (source === "stick" ? this.stick : this.buttons).set(bit, on);
  }

  clearTouch(): void {
    this.stick.clear();
    this.buttons.clear();
  }

  mask(): number {
    return this.keys | this.stick.get() | this.buttons.get() | readPad();
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
