// Run: bun test client/src/net.test.ts
import { beforeEach, expect, test } from "bun:test";
import { Net, type NetStatus } from "./net";

/** A socket the test opens and reads by hand. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly url: string) {}
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
}

/** The fake clock (performance.now) and the liveness interval, which the test fires itself. */
let clock = 0;
let fire: (() => void) | null = null;
let socket: FakeSocket | null = null;

beforeEach(() => {
  clock = 0;
  fire = null;
  socket = null;
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true });
  Object.assign(globalThis, {
    WebSocket: class extends FakeSocket {
      constructor(url: string) {
        super(url);
        socket = this;
      }
    },
    window: {
      addEventListener() {},
      setInterval: (fn: () => void) => {
        fire = fn;
        return 1;
      },
      clearInterval() {
        fire = null;
      },
    },
  });
});

/** A connected socket, opened at t=0. `at(t)` runs the liveness tick at time t. */
function link() {
  const statuses: NetStatus[] = [];
  const net = new Net({
    onMessage() {},
    onBinary() {},
    onStatus: (status) => statuses.push(status),
  });
  net.connect("ws://test/ws");
  const ws = socket as FakeSocket;
  ws.readyState = FakeSocket.OPEN;
  ws.onopen?.();
  return {
    statuses,
    at(t: number) {
      clock = t;
      fire?.();
    },
  };
}

test("a page stall shorter than the silence limit does not drop a healthy socket", () => {
  // the tab's ticks run every 250 ms, then the page stalls for 1.49 s: the server's pong is queued behind the stall,
  // so the socket looks silent for 2.74 s on the first tick after it
  const l = link();
  for (let t = 250; t <= 1250; t += 250) l.at(t);
  l.at(2740);
  expect(l.statuses).not.toContain("closed");
  // a real silence after the stall still drops the socket: 2.5 s from the last frame the page could have seen
  for (let t = 2990; t <= 3740; t += 250) l.at(t);
  expect(l.statuses.at(-1)).toBe("closed");
});

test("a socket silent for the full limit is dropped", () => {
  const l = link();
  for (let t = 250; t <= 2500; t += 250) l.at(t);
  expect(l.statuses.at(-1)).toBe("closed");
});

test("a background tab throttled to one tick a minute is not dropped when it runs again", () => {
  const l = link();
  l.at(60_000);
  expect(l.statuses).not.toContain("closed");
});
