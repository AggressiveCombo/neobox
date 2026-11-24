// Run: bun test client/src/game.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Present } from "./ctx";
import { type LoopDeps, MatchLoop } from "./game";
import type { Engine } from "./engine";
import type { MatchStart } from "./protocol";

const START = { tick_hz: 60 } as unknown as MatchStart;
const SNAP = { tick: 0, bytes: new Uint8Array(1), held: [] as [number, number][] };
const BATCH = new Uint8Array([1, 2, 3]);

// The loop reads the clock and schedules frames through browser globals; stub both.
let clock = 0;
let nextHandle = 1;
let queued = new Map<number, (now: number) => void>();
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
const realPerf = Object.getOwnPropertyDescriptor(globalThis, "performance");

beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: (now: number) => void) => {
    const h = nextHandle++;
    queued.set(h, cb);
    return h;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((h: number) => {
    queued.delete(h);
  }) as typeof cancelAnimationFrame;
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true, writable: true });
});

afterAll(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
  if (realPerf) Object.defineProperty(globalThis, "performance", realPerf);
});

/** Runs the animation frames queued so far, at the current fake time. */
function flush(): void {
  const cbs = [...queued.values()];
  queued = new Map();
  for (const cb of cbs) cb(clock);
}

function harness() {
  const counts = { frames: 0, sent: 0 };
  const engine = {
    matchStart: () => {},
    matchSnapshot: () => {},
    matchEnd: () => {},
    frame: () => {
      counts.frames++;
      return new Uint8Array([7]);
    },
    serverFrame: () => false,
    ping: () => new Uint8Array([9]),
    rtt: () => 0,
    netStats: () => ({ kind: 0, a: 0, b: 0, rollbackP95: 0 }),
    framebuffer: () => null,
  } as unknown as Engine;
  const net = {
    transport: "ws",
    send: () => {},
    sendBinary: () => {
      counts.sent++;
    },
  };
  const deps: LoopDeps = {
    engine,
    input: { mask: () => 0 } as unknown as LoopDeps["input"],
    net: net as unknown as LoopDeps["net"],
    store: { state: { room: null, myId: null }, set: () => {} } as unknown as LoopDeps["store"],
    present: (() => null) as Present,
    hud: () => null,
    names: () => new Map(),
    onError: (msg) => {
      throw new Error(`unexpected loop error: ${msg}`);
    },
  };
  return { loop: new MatchLoop(deps), counts };
}

test("a resync restarts the session without adding a second frame chain", () => {
  clock = 0;
  queued = new Map();
  const { loop, counts } = harness();
  loop.begin(START, 0, null);
  clock = 100;
  loop.begin(START, 0, SNAP); // a snapshot resync arrives while running
  flush();
  expect(counts.frames).toBe(1);
  clock = 116;
  flush();
  expect(counts.frames).toBe(2);
  loop.stop();
});

test("a page with no animation frames still acknowledges each server batch", () => {
  clock = 0;
  queued = new Map();
  const { loop, counts } = harness();
  loop.begin(START, 0, null);
  clock = 1000;
  flush(); // visible: a frame runs and is sent
  expect(counts.frames).toBe(1);
  clock = 1010;
  loop.onServer(BATCH); // still fresh: the frame chain acknowledges it
  expect(counts.frames).toBe(1);
  clock = 3000; // hidden: no frames for two seconds
  loop.onServer(BATCH);
  expect(counts.frames).toBe(2);
  expect(counts.sent).toBeGreaterThan(1);
  loop.stop();
});
