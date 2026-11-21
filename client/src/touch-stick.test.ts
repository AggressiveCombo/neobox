// Run: bun test client/src/touch-stick.test.ts
import { expect, test } from "bun:test";

// input.ts loads pad-axis.ts, which listens on `window` at import time. Static imports are hoisted above this
// stub, so the modules load dynamically after it.
Object.assign(globalThis, { window: { addEventListener() {} } });
const { BIT } = await import("./input");
const { stickBits, stickOctant } = await import("./touch-stick");

const R = 100;
const EAST = 0;
const SE = 1;
const SOUTH = 2;
const NORTH = 6;

test("dead zone and engage/release thresholds", () => {
  expect(stickOctant(-1, 0, 0, R)).toBe(-1);
  expect(stickOctant(-1, 29, 0, R)).toBe(-1);
  expect(stickOctant(-1, 31, 0, R)).toBe(EAST);
  // once engaged, a thumb inside the engage radius but outside the release radius keeps the direction
  expect(stickOctant(EAST, 25, 0, R)).toBe(EAST);
  expect(stickOctant(EAST, 21, 0, R)).toBe(-1);
});

test("eight directions map to the right bits, screen y down", () => {
  expect(stickOctant(-1, 100, 0, R)).toBe(EAST);
  expect(stickBits(EAST)).toBe(BIT.RIGHT);
  expect(stickOctant(-1, 70, 70, R)).toBe(SE);
  expect(stickBits(SE)).toBe(BIT.RIGHT | BIT.DOWN);
  expect(stickBits(SOUTH)).toBe(BIT.DOWN);
  expect(stickBits(NORTH)).toBe(BIT.UP);
  expect(stickOctant(-1, 0, -100, R)).toBe(NORTH);
  expect(stickOctant(-1, -100, 0, R)).toBe(4);
  expect(stickBits(4)).toBe(BIT.LEFT);
  expect(stickOctant(-1, 70, -70, R)).toBe(7);
  expect(stickBits(7)).toBe(BIT.RIGHT | BIT.UP);
  expect(stickBits(-1)).toBe(0);
});

test("a held direction does not flicker at the sector edge", () => {
  // east sector edge is at 22.5deg; a thumb at ~24deg stays east while the held direction persists
  const x = Math.cos(24 * Math.PI / 180) * 100;
  const y = Math.sin(24 * Math.PI / 180) * 100;
  expect(stickOctant(-1, x, y, R)).toBe(SE);
  expect(stickOctant(EAST, x, y, R)).toBe(EAST);
  // well past the edge it switches
  expect(stickOctant(EAST, 70, 70, R)).toBe(SE);
});
