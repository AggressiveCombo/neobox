// Player preferences: controls, audio, graphics, accessibility. Stored in
// localStorage; signed-in players also sync them to their account (the
// server stores the JSON as-is). Every module reads `prefs.value` and
// subscribes for changes; only the settings screen writes.

import { PREFS_KEY } from "./storage-keys";
import { local } from "./storage";

export type Action = "left" | "right" | "up" | "down" | "push" | "rocket" | "bat" | "grab";

export const ACTIONS: { action: Action; label: string; bit: number }[] = [
  { action: "left", label: "Left", bit: 1 },
  { action: "right", label: "Right", bit: 2 },
  { action: "up", label: "Jump", bit: 4 },
  { action: "down", label: "Down", bit: 8 },
  { action: "push", label: "Force push", bit: 16 },
  { action: "rocket", label: "Rocket", bit: 32 },
  { action: "bat", label: "Bat", bit: 64 },
  { action: "grab", label: "Grab", bit: 128 },
];

/** Keys per action, by `KeyboardEvent.code` (up to 3 each). */
export type KeyBindings = Record<Action, string[]>;

export const DEFAULT_KEYS: KeyBindings = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  up: ["ArrowUp", "KeyW", "Space"],
  down: ["ArrowDown", "KeyS"],
  push: ["KeyX"],
  rocket: ["KeyZ"],
  bat: ["KeyC"],
  grab: ["KeyV"],
};

/** The actions the on-screen touch buttons carry (each exactly once). */
export const TOUCH_ACTIONS = ["up", "push", "rocket", "bat", "grab"] as const satisfies readonly Action[];
export type TouchAction = (typeof TOUCH_ACTIONS)[number];

/** Where a touch button sits on screen; `jump` is the tall block on the right. */
export type TouchSlot = "rocket" | "push" | "jump" | "bat" | "grab";
export const TOUCH_SLOTS: readonly TouchSlot[] = ["rocket", "push", "jump", "bat", "grab"];

/** The action each touch slot performs. A permutation of TOUCH_ACTIONS: every action sits in exactly one slot. */
export type TouchLayout = Record<TouchSlot, TouchAction>;

export const DEFAULT_TOUCH_LAYOUT: TouchLayout = { rocket: "rocket", push: "push", jump: "up", bat: "bat", grab: "grab" };

/**
 * Put `action` in `slot`. The action that was in `slot` moves to where `action` was,
 * so the layout stays a permutation (choosing an action in use swaps the two buttons).
 */
export function assignTouchAction(layout: TouchLayout, slot: TouchSlot, action: TouchAction): TouchLayout {
  const next: TouchLayout = { ...layout };
  const from = TOUCH_SLOTS.find((s) => layout[s] === action);
  if (from !== undefined) next[from] = layout[slot];
  next[slot] = action;
  return next;
}

/** Team/player colour sets: "default", or palettes that stay distinct for colour-blind players. */
export type Palette = "default" | "deuteranopia" | "protanopia" | "tritanopia";

export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** Motion: "system" follows the device's reduce-motion setting; "reduce" or "full" overrides it. */
export type Motion = "system" | "reduce" | "full";
export const MOTIONS: readonly Motion[] = ["system", "reduce", "full"];

export interface Prefs {
  keys: KeyBindings;
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** Rendering resolution relative to the screen (0.5..1); lower is faster on weak devices. */
  renderScale: number;
  /** Multisample anti-aliasing. */
  antialias: boolean;
  palette: Palette;
  /** Size multiplier of the on-screen touch controls (0.7..1.5). */
  touchScale: number;
  /** Swap the touch stick to the right and buttons to the left. */
  touchLeftHanded: boolean;
  /** Which action each on-screen touch button performs. */
  touchLayout: TouchLayout;
  /** Show ping/FPS/rollback numbers (same as F3). */
  showStats: boolean;
  /** Appearance colour (0xRRGGBB); null until the player picks one (the server assigns one meanwhile). */
  color: number | null;
  /** Main-menu music off. */
  musicMuted: boolean;
  /** Match music off (the in-game playlist). */
  matchMusicMuted: boolean;
  /** Music level (0..1), on top of the master volume. */
  musicVolume: number;
  /** Game effects level (0..1), on top of the master volume. */
  sfxVolume: number;
  /** Button, toggle, tab, modal and toast sounds. */
  uiSounds: boolean;
  /** Mask rude words in other players' chat. */
  filterProfanity: boolean;
  /** Jukebox volume (0..1), on top of the master volume. */
  jukeboxVolume: number;
  /** Colour theme of the menus: follow the system, or always light or dark. */
  theme: Theme;
  /** Motion: follow the system, or always reduce (no decorative motion) or always keep it. */
  motion: Motion;
  /** Menu text size, 1..1.5 (scales every rem-sized step). */
  textScale: number;
  /** Dyslexia-friendly typeface and wider spacing in the menus. */
  readableFont: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  keys: DEFAULT_KEYS,
  volume: 0.6,
  muted: false,
  renderScale: 1,
  antialias: true,
  palette: "default",
  touchScale: 1,
  touchLeftHanded: false,
  touchLayout: DEFAULT_TOUCH_LAYOUT,
  showStats: false,
  color: null,
  musicMuted: false,
  matchMusicMuted: false,
  musicVolume: 0.6,
  sfxVolume: 0.8,
  uiSounds: true,
  filterProfanity: true,
  jukeboxVolume: 0.5,
  theme: "system",
  motion: "system",
  textScale: 1,
  readableFont: false,
};

type PrefsListener = (next: Prefs, prev: Prefs) => void;

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

/** A layout is kept only when every slot names an action and no action repeats; otherwise the default. */
function sanitizeTouchLayout(raw: unknown): TouchLayout {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const layout = { ...DEFAULT_TOUCH_LAYOUT };
  const used = new Set<unknown>();
  for (const slot of TOUCH_SLOTS) {
    const action = o[slot];
    if (!(TOUCH_ACTIONS as readonly unknown[]).includes(action) || used.has(action)) return { ...DEFAULT_TOUCH_LAYOUT };
    used.add(action);
    layout[slot] = action as TouchAction;
  }
  return layout;
}

/** Accept anything (old versions, hand-edited storage, server copies) and return valid prefs. */
export function sanitizePrefs(raw: unknown): Prefs {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const keysIn = typeof o.keys === "object" && o.keys !== null ? (o.keys as Record<string, unknown>) : {};
  const keys = { ...DEFAULT_KEYS };
  for (const { action } of ACTIONS) {
    const v = keysIn[action];
    if (Array.isArray(v)) keys[action] = v.filter((k): k is string => typeof k === "string" && k.length <= 32).slice(0, 3);
  }
  const palettes: Palette[] = ["default", "deuteranopia", "protanopia", "tritanopia"];
  return {
    keys,
    volume: clamp(o.volume, 0, 1, DEFAULT_PREFS.volume),
    muted: typeof o.muted === "boolean" ? o.muted : DEFAULT_PREFS.muted,
    renderScale: clamp(o.renderScale, 0.5, 1, DEFAULT_PREFS.renderScale),
    antialias: typeof o.antialias === "boolean" ? o.antialias : DEFAULT_PREFS.antialias,
    palette: palettes.includes(o.palette as Palette) ? (o.palette as Palette) : DEFAULT_PREFS.palette,
    touchScale: clamp(o.touchScale, 0.7, 1.5, DEFAULT_PREFS.touchScale),
    touchLeftHanded: typeof o.touchLeftHanded === "boolean" ? o.touchLeftHanded : DEFAULT_PREFS.touchLeftHanded,
    touchLayout: sanitizeTouchLayout(o.touchLayout),
    showStats: typeof o.showStats === "boolean" ? o.showStats : DEFAULT_PREFS.showStats,
    color:
      typeof o.color === "number" && Number.isInteger(o.color) && o.color >= 0 && o.color <= 0xffffff ? o.color : DEFAULT_PREFS.color,
    musicMuted: typeof o.musicMuted === "boolean" ? o.musicMuted : DEFAULT_PREFS.musicMuted,
    matchMusicMuted: typeof o.matchMusicMuted === "boolean" ? o.matchMusicMuted : DEFAULT_PREFS.matchMusicMuted,
    musicVolume: clamp(o.musicVolume, 0, 1, DEFAULT_PREFS.musicVolume),
    sfxVolume: clamp(o.sfxVolume, 0, 1, DEFAULT_PREFS.sfxVolume),
    uiSounds: typeof o.uiSounds === "boolean" ? o.uiSounds : DEFAULT_PREFS.uiSounds,
    filterProfanity: typeof o.filterProfanity === "boolean" ? o.filterProfanity : DEFAULT_PREFS.filterProfanity,
    jukeboxVolume: clamp(o.jukeboxVolume, 0, 1, DEFAULT_PREFS.jukeboxVolume),
    theme: THEMES.includes(o.theme as Theme) ? (o.theme as Theme) : DEFAULT_PREFS.theme,
    motion: MOTIONS.includes(o.motion as Motion) ? (o.motion as Motion) : DEFAULT_PREFS.motion,
    textScale: clamp(o.textScale, 1, 1.5, DEFAULT_PREFS.textScale),
    readableFont: typeof o.readableFont === "boolean" ? o.readableFont : DEFAULT_PREFS.readableFont,
  };
}

class PrefsStore {
  value: Prefs;
  private listeners = new Set<PrefsListener>();

  constructor() {
    let stored: unknown = null;
    try {
      stored = JSON.parse(local.getItem(PREFS_KEY) ?? "null");
    } catch {
      stored = null;
    }
    this.value = sanitizePrefs(stored);
  }

  /** Replace some preferences, persist, notify. */
  set(patch: Partial<Prefs>): void {
    const prev = this.value;
    this.value = sanitizePrefs({ ...prev, ...patch });
    try {
      local.setItem(PREFS_KEY, JSON.stringify(this.value));
    } catch {
      // storage full or blocked (private mode): keep the session copy
    }
    for (const fn of this.listeners) fn(this.value, prev);
  }

  subscribe(fn: PrefsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const prefs = new PrefsStore();
