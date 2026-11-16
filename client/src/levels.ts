// Experience levels (the original's formula) and the guest's local experience.
// Accounts keep their experience on the server; guests keep theirs in this
// browser, capped below level 2 ("create an account to level up").

import { GUEST_XP_KEY } from "./storage-keys";

/** Level of an experience total: floor(sqrt(xp) / 10) + 1. */
export function levelOf(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp)) / 10) + 1;
}

/** Experience at which `level` starts: (10 · (level − 1))². */
export function xpForLevel(level: number): number {
  const l = Math.max(0, level - 1) * 10;
  return l * l;
}

/** Most experience a guest can hold (the last point of level 1). */
export const GUEST_XP_CAP = xpForLevel(2) - 1;

/** The guest's experience in this browser. */
export function guestXp(): number {
  try {
    const n = Number(window.localStorage.getItem(GUEST_XP_KEY));
    return Number.isFinite(n) ? Math.min(GUEST_XP_CAP, Math.max(0, Math.floor(n))) : 0;
  } catch {
    return 0;
  }
}

/** Add `n` to the guest's experience (capped); returns the new total. */
export function addGuestXp(n: number): number {
  const total = Math.min(GUEST_XP_CAP, guestXp() + Math.max(0, Math.floor(n)));
  try {
    window.localStorage.setItem(GUEST_XP_KEY, String(total));
  } catch {
    // storage blocked: the total still shows for this game
  }
  return total;
}
