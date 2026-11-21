// Touch movement stick. The sim reads digital left/right/up/down bits, so the thumb's offset becomes one of
// 8 directions; the knob still follows the thumb freely. Hysteresis keeps a direction from flickering at the
// edges of its dead zone and sectors.
import { BIT } from "./input";

/** Thumb distance, as a fraction of the pad radius, that engages a direction. */
export const STICK_ENGAGE = 0.3;
/** Once engaged, a direction releases only inside this distance (below STICK_ENGAGE). */
export const STICK_RELEASE = 0.22;

const QUARTER = Math.PI / 4;
/** Radians a thumb must travel past its sector's edge before the direction changes. */
const SECTOR_HYSTERESIS = (8 * Math.PI) / 180;

/** Input bits of each octant, starting east and turning clockwise (screen y grows downwards). */
const OCTANT_BITS = [
  BIT.RIGHT,
  BIT.RIGHT | BIT.DOWN,
  BIT.DOWN,
  BIT.LEFT | BIT.DOWN,
  BIT.LEFT,
  BIT.LEFT | BIT.UP,
  BIT.UP,
  BIT.RIGHT | BIT.UP,
];

/**
 * The octant (0-7, as in OCTANT_BITS) the thumb points to, or -1 in the dead zone. `prev` is the octant last
 * returned (-1 when idle): a held direction keeps its octant until the thumb is well past the sector edge.
 */
export function stickOctant(prev: number, dx: number, dy: number, radius: number): number {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius * (prev < 0 ? STICK_ENGAGE : STICK_RELEASE)) return -1;
  const angle = Math.atan2(dy, dx);
  if (prev >= 0) {
    // angular distance from the held octant's centre, wrapped to (-PI, PI]
    const off = Math.atan2(Math.sin(angle - prev * QUARTER), Math.cos(angle - prev * QUARTER));
    if (Math.abs(off) <= QUARTER / 2 + SECTOR_HYSTERESIS) return prev;
  }
  return ((Math.round(angle / QUARTER) % 8) + 8) % 8;
}

/** The input bits a stick octant sets (none in the dead zone). */
export function stickBits(octant: number): number {
  return octant < 0 ? 0 : (OCTANT_BITS[octant] ?? 0);
}
