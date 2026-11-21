// Input mask (docs/CLIENT-API.md): 1 left, 2 right, 4 up/jump, 8 down,
// 16 force push (X), 32 rocket (Z), 64 bat (C), 128 grab/parachute (V).
// Keyboard bindings come from prefs (by physical key, e.code); touch uses the
// on-screen buttons and gamepads use the standard mapping below.

import { ACTIONS, prefs, type Action, type KeyBindings } from "./prefs";
import { armedAxis } from "./pad-axis";

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

/** The input the player last used; Training's lesson chips name the controls of that one. */
export type InputProfile = "keyboard" | "touch" | "pad";

/** Touch-only device: a coarse pointer and no fine one (the same test as phone-splash.ts). */
const touchOnly = (): boolean => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

// Set on first use (not at import), so the module loads without a DOM.
let profile: InputProfile | null = null;
const profileListeners = new Set<() => void>();

function currentProfile(): InputProfile {
  profile ??= touchOnly() ? "touch" : "keyboard";
  return profile;
}

function setProfile(next: InputProfile): void {
  if (next === currentProfile()) return;
  profile = next;
  for (const fn of profileListeners) fn();
}

export function inputProfile(): InputProfile {
  return currentProfile();
}

/** Calls `fn` whenever the profile changes; returns the unsubscribe. */
export function onInputProfile(fn: () => void): () => void {
  profileListeners.add(fn);
  return () => {
    profileListeners.delete(fn);
  };
}

// Connected pads, counted from the connect events once first asked (one scan seeds pads already exposed),
// so frames without a pad skip navigator.getGamepads(), which costs ~3% of a match frame in Chromium.
let padCount = -1;

function padsPresent(): boolean {
  if (padCount < 0) {
    // The Gamepad API is absent in insecure contexts (plain http) and some WebKit builds.
    if (typeof navigator.getGamepads !== "function") return false;
    padCount = navigator.getGamepads().filter((pad) => pad !== null).length;
    window.addEventListener("gamepadconnected", () => padCount++);
    window.addEventListener("gamepaddisconnected", () => (padCount = Math.max(0, padCount - 1)));
  }
  return padCount > 0;
}

function readPad(): number {
  if (!padsPresent()) return 0;
  let m = 0;
  for (const pad of navigator.getGamepads()) {
    if (!pad) continue;
    for (const [button, bit] of PAD_BUTTONS) if (pad.buttons[button]?.pressed === true) m |= bit;
    const x = armedAxis(pad, 0);
    const y = armedAxis(pad, 1);
    if (x < -STICK_DEAD) m |= BIT.LEFT;
    if (x > STICK_DEAD) m |= BIT.RIGHT;
    if (y < -STICK_DEAD) m |= BIT.UP;
    if (y > STICK_DEAD) m |= BIT.DOWN;
  }
  if (m !== 0) setProfile("pad");
  return m;
}

/** Whether `index` (standard mapping) is held on any connected pad; holding it marks the pad profile. */
export function padButton(index: number): boolean {
  if (!padsPresent()) return false;
  let held = false;
  for (const pad of navigator.getGamepads()) if (pad?.buttons[index]?.pressed === true) held = true;
  if (held) setProfile("pad");
  return held;
}

export class Input {
  private keys = 0;
  /** Stick and buttons have their own bits: Jump (UP) and the stick's up share a bit, so one must not clear the other. */
  private stick = new TouchMask();
  private buttons = new TouchMask();
  /** Air jump ready as of the last sim tick, and that tick's local screen y (NaN before the first). */
  private airReady = false;
  private lastTick = -1;
  private lastY = NaN;
  /** The local player's screen y was shrinking (rising) at the last tick. */
  private rising = false;
  /** A touch re-press is wanted (see `setLocalFrame`); consumed by `mask`. */
  private repressDue = false;
  /** This readiness already re-pressed; reset when the air jump is spent. */
  private repressed = false;
  /** Sim tick through which touch Jump stays lifted for a re-press (see `mask`). */
  private repressUntil = -1;
  /** Physical keys currently down (bound or not), so bits stay right after a rebind. */
  private held = new Set<string>();
  private codeBits = buildCodeBits(prefs.value.keys);
  private pending: ((code: string | null) => void) | null = null;
  /** Called for keys that are not movement (e.g. Tab, F3). */
  onKey: ((code: string, down: boolean) => void) | null = null;

  constructor() {
    window.addEventListener("keydown", (e) => this.handle(e, true));
    window.addEventListener("keyup", (e) => this.handle(e, false));
    window.addEventListener("keydown", () => setProfile("keyboard"));
    window.addEventListener("pointerdown", (e) => setProfile(touchOnly() || e.pointerType !== "mouse" ? "touch" : "keyboard"), { capture: true });
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
    const due = this.repressDue;
    this.repressDue = false;
    const touch = this.stick.get() | this.buttons.get();
    if ((touch & BIT.UP) === 0) this.repressUntil = -1;
    else if (due && !this.repressed) {
      this.repressed = true;
      this.repressUntil = this.lastTick + REPRESS_TICKS;
    }
    // Only the touch Jump lifts: a held keyboard or gamepad Jump keeps its own press.
    const lifting = this.lastTick < this.repressUntil;
    return this.keys | readPad() | (lifting ? touch & ~BIT.UP : touch);
  }

  /**
   * The local player at sim tick `tick`: air jump ready (the yellow emblem) and screen y. A rise to ready, or the apex
   * of a jump made while ready, queues a touch re-press: the thumb lifts Jump and presses it again (see `mask`).
   * Once per readiness: spending the air jump ends it.
   */
  setLocalFrame(ready: boolean, y: number, tick: number): void {
    if (!ready) this.repressed = false;
    else if (!this.airReady) this.repressDue = true;
    this.airReady = ready;
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const dy = y - this.lastY;
    this.lastY = y;
    if (dy < 0) this.rising = true;
    else {
      if (ready && this.rising) this.repressDue = true;
      this.rising = false;
    }
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
/** Sim ticks touch Jump stays lifted for a re-press. Two, so the sim sees at least one tick with Jump up at any frame rate. */
const REPRESS_TICKS = 2;

