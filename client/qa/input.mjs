// Input instrument: keyboard bindings, reserved keys, on-screen touch controls and gamepads.
//
// Ground truth is the engine, not pixels. An init script wraps the wasm exports so every
// nb_local_frame call records the input mask the engine receives, and parses the frame buffer for
// the local player (position, flags, rocket charge) and the sounds the sim emitted. Each input is
// held for one window and two things are checked:
//   mask:   the bit reached the engine (fails when the input is dropped anywhere on the way);
//   effect: the sim responded in the way that action produces (left/right move the player, jump
//           plays sound 1, push plays sounds 4/5, rocket charges, bat sets flag 16 in the window).
//           Down and grab have no state effect in a plain practice state (down only changes a
//           falling body; grab needs a dynamic body in reach), so they are checked by mask alone.
//
// Cases: keys.default (every default binding), keys.reserved (Enter refused as a binding), keys.chord
// (LEFT+UP+PUSH on three keys), keys.rebind (third key, conflict move, persisted, plays), keys.rebind.touch
// (touch actions rebindable), keys.chatLeak (game keys typed in chat do not move the player), input.latency
// (p95 of 30 keydown-to-pixel-change samples at full canvas resolution), drag.noAlternative (sliders and the map editor by keyboard),
// touch.buttons and touch.stick (phone layout), touch.chord (stick left and
// jump on two fingers), gamepad.buttons (standard mapping: d-pad, A, X, B, Y, RB, LB), gamepad.stick
// (injected pad), input.switch (keyboard, then touch, then gamepad in one match).
// Touch uses real CDP touch on chromium, mouse on webkit, and synthetic touch pointers on firefox
// (Playwright's firefox mouse in a touch context emits only mousedown, so no pointer event reaches the
// HUD). Two-finger chords use CDP multi-touch on chromium and synthetic pointers on firefox and webkit
// (Playwright's webkit mouse has a single pointer).
//
// Self-test: QA_SELF_TEST=drop-input swallows keyboard events and touch-layer pointer events before
// the game sees them, and reports no gamepads; every input case must then fail on the mask. The D09 faults
// are drop-prefs (keys.rebind), chat-leak (keys.chatLeak), delay-input (input.latency) and
// block-range-keys (drag.noAlternative).
//
// Run: cd client && bun qa/input.mjs          (QA_ENGINES=chromium to limit engines)
// Output: <QA_OUT>/input-<engine>.{json,md}, evidence under <QA_OUT>/evidence/input-<engine>/.

import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  Results,
  button,
  cdpOf,
  dismissPhoneSplash,
  launchEngine,
  menuName,
  muteAudio,
  navTo,
  outDir,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startPractice,
  startServer,
  uniqueName,
  writeIndex,
} from "./lib-qa.mjs";
import { createRoom, ensureRoomMap, signedIn, waitForPixels } from "../e2e/lib.mjs";

// Mirrors DEFAULT_KEYS in client/src/prefs.ts (the qa directory cannot import the TS source).
const DEFAULT_KEYS = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  up: ["ArrowUp", "KeyW", "Space"],
  down: ["ArrowDown", "KeyS"],
  push: ["KeyX"],
  rocket: ["KeyZ"],
  bat: ["KeyC"],
  grab: ["KeyV"],
};
// Mask bits (client/src/input.ts BIT).
const BIT = { left: 1, right: 2, up: 4, down: 8, push: 16, rocket: 32, bat: 64, grab: 128 };
// Phone HUD touch buttons, by action (client/src/ui/screens/hud.ts TOUCH_BUTTONS): .hud-touch[data-action].
const TOUCH_AREAS = [
  ["jump", "up"],
  ["push", "push"],
  ["rocket", "rocket"],
  ["bat", "bat"],
  ["grab", "grab"],
];
// Standard gamepad mapping (client/src/input.ts PAD_BUTTONS): d-pad up and A jump, d-pad down, left and
// right, X pushes, B bats, Y or RB rocket, LB grabs. [name, standard button index, action]
const PAD_BUTTONS = [
  ["A", 0, "up"],
  ["DPadUp", 12, "up"],
  ["DPadDown", 13, "down"],
  ["DPadLeft", 14, "left"],
  ["DPadRight", 15, "right"],
  ["X", 2, "push"],
  ["B", 1, "bat"],
  ["Y", 3, "rocket"],
  ["RB", 5, "rocket"],
  ["LB", 4, "grab"],
];

const WINDOW_MS = 1500;
const LEVEL_SETTLE_MS = 3000;
const MOVE_MIN = 0.5; // world units of travel that count as movement
const WALK_MS = 1500; // setup walk toward the opposite wall
const READY_TIMEOUT_MS = 30000; // longest wait for the local player to be in frame with full stamina
const POLL_MS = 100; // readiness poll interval (Node-side, not rAF: firefox headless can stall rAF)
const IDLE_TIMEOUT_MS = 8000; // longest wait for a bat swing from earlier input to end before a window opens
const STILL_MS = 500; // the local player must not move this long: a jump needs the previous landing done
const LANDSCAPE = { width: 844, height: 390 }; // phone viewport for the touch cases

// Walk toward the wall on the opposite side first, so the pressed direction has room to show.
const SETUP = {
  left: { walk: "ArrowRight" },
  right: { walk: "ArrowLeft" },
};

// Injected before any page script: wraps the wasm exports so the test sees the mask and frame state.
const HOOK = () => {
  const acc = {};
  const reset = () => {
    Object.assign(acc, {
      mask: 0,
      found: 0,
      first: null,
      flagsStart: null,
      staminaStart: null,
      maskStart: null,
      calls: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      flags: 0,
      rocketMax: -2,
      sounds: {},
      stateT: null,
      watch: false,
      ref: null,
    });
  };
  reset();
  window.__qa = acc;
  window.__qaReset = reset;
  // Trusted ArrowRight keydown: the latency reference. Registered first, so it runs before any self-test fault.
  window.__qaKeyT = null;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isTrusted && e.code === "ArrowRight" && !e.repeat && window.__qaKeyT === null) window.__qaKeyT = performance.now();
    },
    true,
  );
  const parse = (ex) => {
    const len = ex.nb_frame_len();
    if (len < 64) return;
    const buf = ex.memory.buffer;
    const ptr = ex.nb_frame_ptr();
    const u = new Uint32Array(buf, ptr, len >>> 2);
    const f = new Float32Array(buf, ptr, len >>> 2);
    const localId = new Int32Array(buf, ptr, len >>> 2)[15];
    const pc = u[3];
    const po = u[4];
    let present = false;
    for (let k = 0; k < pc; k++) {
      const b = po + k * 14;
      if (u[b] !== localId) continue;
      present = true;
      const x = f[b + 1];
      const y = f[b + 2];
      acc.x = x;
      acc.y = y;
      // stateMs: first frame in which the local player's engine state differs from the rest state (acc.ref).
      if (acc.watch && acc.stateT === null && window.__qaKeyT !== null && acc.ref) {
        const now = performance.now();
        if (now >= window.__qaKeyT && (Math.abs(x - acc.ref.x) > 1e-4 || Math.abs(y - acc.ref.y) > 1e-4)) acc.stateT = now;
      }
      const flags = u[b + 6];
      acc.health = f[b + 9];
      acc.stamina = f[b + 5];
      if (acc.first === null) {
        acc.first = { x, y };
        acc.flagsStart = flags;
        acc.staminaStart = f[b + 5];
        acc.minX = acc.maxX = x;
        acc.minY = y;
      }
      acc.minX = Math.min(acc.minX, x);
      acc.maxX = Math.max(acc.maxX, x);
      acc.minY = Math.min(acc.minY, y);
      acc.flags |= flags;
      acc.rocketMax = Math.max(acc.rocketMax, f[b + 10]);
      acc.found++;
    }
    // local score row: lives and alive (diagnostics for a sample whose player cannot move)
    for (let i = 0, rc = u[7], ro = u[8]; i < rc; i++) {
      const o = ro + i * 15;
      if (u[o] !== localId) continue;
      acc.lives = f[o + 4];
      acc.alive = u[o + 5] !== 0;
    }
    // ready: the local player is in the frame with full stamina (header word 25 = max stamina);
    // a rocket or push starts only with stamina to pay for it
    acc.ready = present && f[25] > 0 && acc.stamina >= f[25] - 0.01;
    const sc = u[5];
    const so = u[6];
    for (let j = 0; j < sc; j++) {
      const kind = u[so + j * 5];
      acc.sounds[kind] = (acc.sounds[kind] ?? 0) + 1;
    }
  };
  const wrap = (result) => {
    const ex = result.instance.exports;
    const api = { ...ex };
    const localFrame = ex.nb_local_frame;
    api.nb_local_frame = (dt, mask) => {
      acc.mask |= mask;
      acc.cur = mask;
      if (acc.maskStart === null) acc.maskStart = mask;
      acc.calls++;
      const rc = localFrame(dt, mask);
      parse(ex);
      return rc;
    };
    // nb_frame: the room match steps through this export, not nb_local_frame.
    const frame = ex.nb_frame;
    api.nb_frame = (nowMs, mask) => {
      acc.mask |= mask;
      acc.cur = mask;
      acc.calls++;
      const rc = frame(nowMs, mask);
      parse(ex);
      return rc;
    };
    return { module: result.module, instance: { exports: api } };
  };
  const origStreaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async (...a) => wrap(await origStreaming.apply(WebAssembly, a));
  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...a) => {
    const r = await origInstantiate.apply(WebAssembly, a);
    return r.instance ? wrap(r) : r;
  };
};

// Self-test: drop keyboard events, touch-layer pointer events and gamepads before the game sees them.
const DROP = () => {
  window.__qaDrop = true;
  for (const type of ["keydown", "keyup"]) window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "mousedown"]) {
    window.addEventListener(
      type,
      (e) => {
        if (e.target instanceof Element && e.target.closest(".hud-touch-layer")) e.stopImmediatePropagation();
      },
      true,
    );
  }
};

// Self-test: prefs never reach localStorage, so a rebind is lost on reload.
const DROP_PREFS = () => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === "neobox.prefs") return;
    return setItem.call(this, key, value);
  };
};

// Self-test: game keys pass the typing guard in input.ts while a text field has focus, so keys typed into
// chat move the player. The guard reads document.activeElement, which reports no field during the event.
const CHAT_LEAK = () => {
  const real = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement").get;
  let leaking = false;
  Object.defineProperty(Document.prototype, "activeElement", {
    configurable: true,
    get() {
      return leaking ? document.body : real.call(this);
    },
  });
  const game = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "KeyA", "KeyD", "KeyW", "KeyS", "KeyX", "KeyZ", "KeyC", "KeyV"]);
  const mark = (e) => {
    if (!e.isTrusted || !game.has(e.code) || !(e.target instanceof HTMLInputElement)) return;
    leaking = true;
    setTimeout(() => {
      leaking = false;
    });
  };
  window.addEventListener("keydown", mark, true);
  window.addEventListener("keyup", mark, true);
};

// Self-test: the engine receives ArrowRight 300 ms late. The trusted keydown is stopped before the game's
// listener and replayed as a repeat: the probe ignores repeats, so the trusted keydown stays the reference.
const DELAY_INPUT = () => {
  let held = false;
  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.code !== "ArrowRight" || e.repeat) return;
    e.stopImmediatePropagation();
    held = true;
    setTimeout(() => {
      if (held) window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", key: "ArrowRight", repeat: true, bubbles: true }));
    }, 300);
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === "ArrowRight") held = false;
  });
};

// Self-test: range inputs swallow the arrow keys, so a slider moves by pointer only.
const BLOCK_RANGE = () => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "range") e.preventDefault();
    },
    true,
  );
};

const FAULTS = { "drop-prefs": DROP_PREFS, "chat-leak": CHAT_LEAK, "delay-input": DELAY_INPUT, "block-range-keys": BLOCK_RANGE };

// Firefox: no active pointer exists for a synthetic touch id, so pointer capture is stubbed.
const NO_CAPTURE = () => {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
};

// Injected before any page script: one standard-mapping gamepad driven through window.__qaPad.
// The game polls navigator.getGamepads each frame (client/src/input.ts readPad).
const PAD_INIT = () => {
  const pad = {
    id: "qa-pad (STANDARD GAMEPAD)",
    index: 0,
    connected: true,
    mapping: "standard",
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
  window.__qaPad = pad;
  Object.defineProperty(navigator, "getGamepads", { value: () => (window.__qaDrop ? [] : [pad]), configurable: true });
};

const readAcc = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__qa)));
const resetAcc = (page) => page.evaluate(() => window.__qaReset());

async function holdKey(page, code, ms) {
  await page.keyboard.down(code);
  await sleep(ms);
  await page.keyboard.up(code);
}

/** Flag 16 (bat swing in progress) stays set for the whole swing, so a window that starts inside one misses its transition. */
const batIdle = (acc) => acc.flagsStart !== null && (acc.flagsStart & 16) === 0;

/**
 * Presses for one window and returns the engine's view of it. `before` runs first, then a settle. `idle`, when given,
 * must hold for the probe taken just before the press; the probe is retried until it does or IDLE_TIMEOUT_MS passes.
 */
async function window1({ page, press, release, before, settle = 300, idle }) {
  await before?.();
  await sleep(settle);
  const ready = await waitReady(page);
  let idleWaitMs = 0;
  let pre;
  for (;;) {
    await resetAcc(page);
    await sleep(150);
    pre = await readAcc(page);
    if (!idle || idle(pre) || idleWaitMs >= IDLE_TIMEOUT_MS) break;
    await sleep(POLL_MS);
    idleWaitMs += POLL_MS + 150;
  }
  await press();
  await sleep(WINDOW_MS);
  const acc = { ...(await readAcc(page)), ready, preMask: pre.mask, idleWaitMs, idleOk: idle ? idle(pre) : true };
  await release();
  return acc;
}

/** Waits up to READY_TIMEOUT_MS for the local player to be in frame, full stamina and still for STILL_MS. */
async function waitReady(page) {
  const t0 = Date.now();
  let last = null;
  let stillFor = 0;
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    const s = await page.evaluate(() => ({ ready: window.__qa.ready === true, x: window.__qa.x, y: window.__qa.y }));
    const same = last && Math.abs(s.x - last.x) < 0.01 && Math.abs(s.y - last.y) < 0.01;
    stillFor = s.ready && same ? stillFor + POLL_MS : 0;
    if (stillFor >= STILL_MS) return true;
    last = s;
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * The effect a held action must produce in its window; null where the state shows none
 * by design (down, grab).
 */
function effectOf(action, acc) {
  const first = acc.first ?? { x: 0, y: 0 };
  switch (action) {
    case "left":
      return acc.minX < first.x - MOVE_MIN;
    case "right":
      return acc.maxX > first.x + MOVE_MIN;
    case "up":
      return (acc.sounds[1] ?? 0) > 0 || acc.minY < first.y - MOVE_MIN;
    case "push":
      return (acc.sounds[4] ?? 0) + (acc.sounds[5] ?? 0) > 0;
    case "rocket":
      return acc.rocketMax >= 0 || (acc.sounds[15] ?? 0) > 0;
    case "bat":
      // Flag 16 is latched between swings, so only a transition inside the window counts.
      return acc.flagsStart !== null && (acc.flagsStart & 16) === 0 && (acc.flags & 16) !== 0;
    default:
      return null;
  }
}

/** A held input passes when the mask reached the engine and the state shows its effect (where one is defined). */
function judge(name, action, acc, extra = {}) {
  const mask = (acc.mask & BIT[action]) !== 0;
  const effect = effectOf(action, acc);
  const found = acc.found > 0;
  const first = acc.first ?? { x: 0, y: 0 };
  const travel = `x ${first.x.toFixed(2)}, range ${acc.minX.toFixed(2)}..${acc.maxX.toFixed(2)}`;
  const reason =
    acc.ready !== true
      ? "local player not ready: missing from frame or stamina not full"
      : !found
        ? "no local player in frame"
        : !mask
          ? "mask bit never reached the engine"
          : effect === false
            ? `mask reached the engine but the sim showed no effect (${travel}, held before press: ${Object.keys(BIT).filter((n) => (acc.preMask & BIT[n]) !== 0).join("+") || "none"}, engine calls ${acc.calls}${action === "bat" ? `, bat flag16 at window start ${(acc.flagsStart & 16) !== 0}, set during window ${(acc.flags & 16) !== 0}, stamina at start ${acc.staminaStart}` : ""})`
            : extra.exact === true && acc.mask !== BIT[action]
              ? `mask ${acc.mask} is not exactly ${BIT[action]}: extra bits set`
              : undefined;
  const ok =
    acc.ready === true && found && mask && effect !== false && (extra.hit ?? true) && (extra.exact !== true || acc.mask === BIT[action]);
  return {
    name,
    ok,
    mask: mask ? 1 : 0,
    effect: effect === null ? null : effect ? 1 : 0,
    reason: reason ?? (extra.hit === false ? "touch point misses the button" : undefined),
  };
}

function summarise(rows) {
  const silent = rows.filter((r) => !r.ok);
  const metrics = {};
  for (const r of rows) {
    metrics[`input.${r.name}.mask`] = r.mask;
    if (r.effect !== null) metrics[`input.${r.name}.effect`] = r.effect;
  }
  return {
    pass: silent.length === 0,
    metrics,
    detail: silent.length ? `no response: ${silent.map((r) => `${r.name} (${r.reason})`).join(", ")}` : undefined,
  };
}

/** Wraps Scenario.open so every context is muted, has the HOOK, and gets the self-test drop when asked. */
function prepare(s, extra = [], viewport) {
  const openOriginal = s.open.bind(s);
  s.open = async (label, opts) => {
    // A viewport given to newContext: firefox headless hangs on a live setViewportSize.
    const browser = s.env.browser;
    const newContext = browser.newContext;
    if (viewport) browser.newContext = (o) => newContext({ ...o, viewport });
    let h;
    try {
      h = await openOriginal(label, opts);
    } finally {
      browser.newContext = newContext;
    }
    await muteAudio(h.context);
    await h.context.addInitScript(HOOK); // first: the latency reference must see the trusted keydown before a fault stops it
    if (selfTestMode() === "drop-input") await h.context.addInitScript(DROP);
    const fault = FAULTS[selfTestMode()];
    if (fault) await h.context.addInitScript(fault);
    for (const fn of extra) await h.context.addInitScript(fn);
    return h;
  };
}

async function practiceDesktop(s, base, extra) {
  prepare(s, extra);
  const h = await s.open("practice");
  await startPractice(h, base, null);
  await sleep(LEVEL_SETTLE_MS);
  await h.page.evaluate(() => document.activeElement?.blur());
  return h;
}

/** A started multiplayer match, the e2e 'input latency' setup: chat opens here, practice has none. */
async function roomDesktop(s, base) {
  prepare(s);
  const h = await s.open("room", { name: uniqueName("in") });
  await createRoom(h, base, uniqueName("ir"), { isPublic: false });
  await ensureRoomMap(h.page);
  await button(h.page, "Start").click();
  await h.page.locator(".hud-leave").waitFor({ state: "visible" });
  await waitForPixels(h, "match canvas");
  await sleep(4000); // frames freeze during the start countdown
  await h.page.evaluate(() => document.activeElement?.blur());
  return h;
}

async function keysCase(s, base) {
  const h = await practiceDesktop(s, base);
  const rows = [];
  for (const [action, codes] of Object.entries(DEFAULT_KEYS)) {
    for (const code of codes) {
      const walk = SETUP[action]?.walk;
      const acc = await window1({
        page: h.page,
        press: () => h.page.keyboard.down(code),
        release: () => h.page.keyboard.up(code),
        before: walk ? () => holdKey(h.page, walk, WALK_MS) : undefined,
        settle: walk ? 400 : 300,
      });
      rows.push(judge(`keys.${action}.${code}`, action, acc));
    }
  }
  return summarise(rows);
}

/** Enter is reserved by the app, so the settings screen must refuse it as a binding. */
async function reservedCase(s, base) {
  prepare(s);
  const h = await s.open("settings");
  await h.page.goto(base);
  await menuName(h.page).waitFor();
  await navTo(h.page, "Settings");
  await h.page.getByRole("button", { name: /^Left key 1:/ }).click();
  await h.page.keyboard.press("Enter");
  const refused = await h.page
    .getByText("is used by the game or browser", { exact: false })
    .waitFor({ timeout: 5000 })
    .then(() => true, () => false);
  await h.page.keyboard.press("Escape");
  return {
    pass: refused,
    metrics: { "input.keys.reserved.enterRefused": refused ? 1 : 0 },
    detail: refused ? undefined : "Enter was accepted as a binding",
  };
}

/** Phone layout, landscape, practice running. */
async function practicePhone(s, base, extra) {
  prepare(s, extra, LANDSCAPE);
  const h = await s.open("phone", { phone: true, name: uniqueName("in") });
  await startPhonePractice(h.page, base);
  return h;
}

/** From the menu of a phone page into a started practice match. */
async function startPhonePractice(page, base) {
  await page.goto(base);
  await dismissPhoneSplash(page);
  await menuName(page).waitFor();
  await navTo(page, "Practice");
  await page.locator(".offline-list .offline-choice").first().click();
  await button(page, "Start").click();
  await page.locator(".offline.playing").waitFor();
  await sleep(LEVEL_SETTLE_MS);
}

/**
 * Touch driver for one engine. Each returns { down(selector, x, y), move(selector, x, y), up(selector) }.
 * chromium: real CDP touch. webkit: mouse (pointer events with pointerType mouse, hit-tested).
 * firefox: synthetic touch pointers dispatched on the target (see NO_CAPTURE).
 */
async function touchDriver(page, engine) {
  if (engine === "chromium") {
    const cdp = await cdpOf(page);
    const send = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
    return {
      down: (_sel, x, y) => send("touchStart", [{ x, y }]),
      move: (_sel, x, y) => send("touchMove", [{ x, y }]),
      up: () => send("touchEnd", []),
    };
  }
  if (engine === "webkit") {
    return {
      down: async (_sel, x, y) => {
        await page.mouse.move(x, y);
        await page.mouse.down();
      },
      move: (_sel, x, y) => page.mouse.move(x, y, { steps: 6 }),
      up: () => page.mouse.up(),
    };
  }
  const dispatch = (sel, type, x, y) =>
    page.evaluate(
      ({ sel, type, x, y }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`${sel} not found`);
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
      },
      { sel, type, x, y },
    );
  return {
    down: (sel, x, y) => dispatch(sel, "pointerdown", x, y),
    move: (sel, x, y) => dispatch(sel, "pointermove", x, y),
    up: (sel) => dispatch(sel, "pointerup", 0, 0),
  };
}

async function box(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not visible`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width };
}

/** The Jump button by action (the default layout). */
const JUMP = '.hud-touch[data-action="up"]';

async function touchButtonsCase(s, base, engine) {
  const h = await practicePhone(s, base, engine === "firefox" ? [NO_CAPTURE] : []);
  const touch = await touchDriver(h.page, engine);
  const rows = [];
  for (const [area, action] of TOUCH_AREAS) {
    const sel = `.hud-touch[data-action="${action}"]`;
    const { x, y } = await box(h.page, sel);
    const hit = await h.page.evaluate(([x, y, sel]) => document.elementFromPoint(x, y)?.closest(sel) != null, [x, y, sel]);
    const acc = await window1({
      page: h.page,
      press: () => touch.down(sel, x, y),
      release: () => touch.up(sel),
    });
    rows.push(judge(`touch.${area}`, action, acc, { hit }));
  }
  const out = summarise(rows);
  out.metrics["input.touch.layerVisible"] = (await h.page.locator(".hud-touch-layer").isVisible()) ? 1 : 0;
  return out;
}

async function touchStickCase(s, base, engine) {
  const h = await practicePhone(s, base, engine === "firefox" ? [NO_CAPTURE] : []);
  const touch = await touchDriver(h.page, engine);
  const sel = ".hud-stick";
  const { x, y, width } = await box(h.page, sel);
  const reach = width * 0.4;
  // walk the stick toward the opposite wall first, so the pressed direction has room to show
  const walk = async (dir) => {
    await touch.down(sel, x, y);
    await touch.move(sel, x + dir * reach, y);
    await sleep(WALK_MS);
    await touch.up(sel);
  };
  const left = await window1({
    page: h.page,
    before: () => walk(1),
    press: async () => {
      await touch.down(sel, x, y);
      await touch.move(sel, x - reach, y);
    },
    release: () => touch.up(sel),
  });
  const right = await window1({
    page: h.page,
    before: () => walk(-1),
    press: async () => {
      await touch.down(sel, x, y);
      await touch.move(sel, x + reach, y);
    },
    release: () => touch.up(sel),
  });
  // the stick's vertical sectors: up is the jump effect, down is mask-only by design (like keys.down)
  const up = await window1({
    page: h.page,
    press: async () => {
      await touch.down(sel, x, y);
      await touch.move(sel, x, y - reach);
    },
    release: () => touch.up(sel),
  });
  const down = await window1({
    page: h.page,
    press: async () => {
      await touch.down(sel, x, y);
      await touch.move(sel, x, y + reach);
    },
    release: () => touch.up(sel),
  });
  return summarise([
    judge("touch.stick.left", "left", left),
    judge("touch.stick.right", "right", right),
    judge("touch.stick.up", "up", up),
    judge("touch.stick.down", "down", down),
  ]);
}

async function padPractice(s, base) {
  const h = await practiceDesktop(s, base, [PAD_INIT]);
  const setButton = (index, pressed) =>
    h.page.evaluate(
      ([i, v]) => {
        window.__qaPad.buttons[i].pressed = v;
        window.__qaPad.buttons[i].value = v ? 1 : 0;
      },
      [index, pressed],
    );
  // the left stick: axes 0 (x) and 1 (y), each -1..1
  const setAxis = (x, y = 0) =>
    h.page.evaluate(
      ([ax, ay]) => {
        window.__qaPad.axes[0] = ax;
        window.__qaPad.axes[1] = ay;
      },
      [x, y],
    );
  return { h, setButton, setAxis };
}

async function gamepadButtonsCase(s, base) {
  const { h, setButton } = await padPractice(s, base);
  // hold a d-pad direction to walk toward the opposite wall first, so the pressed direction has room to show
  const walk = async (index) => {
    await setButton(index, true);
    await sleep(WALK_MS);
    await setButton(index, false);
  };
  const rows = [];
  for (const [name, index, action] of PAD_BUTTONS) {
    const moves = action === "left" || action === "right";
    const acc = await window1({
      page: h.page,
      before: action === "left" ? () => walk(15) : action === "right" ? () => walk(14) : undefined,
      settle: moves ? 400 : 300,
      press: () => setButton(index, true),
      release: () => setButton(index, false),
    });
    rows.push(judge(`gamepad.${name}.${action}`, action, acc, { exact: true }));
  }
  return summarise(rows);
}

async function gamepadStickCase(s, base) {
  const { h, setAxis } = await padPractice(s, base);
  // walk the stick toward the opposite wall first, so the pressed direction has room to show
  const walk = async (x) => {
    await setAxis(x, 0);
    await sleep(WALK_MS);
    await setAxis(0, 0);
  };
  const stick = (x, y) => ({ page: h.page, press: () => setAxis(x, y), release: () => setAxis(0, 0) });
  const left = await window1({ ...stick(-1, 0), before: () => walk(1) });
  const right = await window1({ ...stick(1, 0), before: () => walk(-1) });
  const up = await window1({ ...stick(0, -1) });
  const down = await window1({ ...stick(0, 1) });
  return summarise([
    judge("gamepad.stick.left", "left", left, { exact: true }),
    judge("gamepad.stick.right", "right", right, { exact: true }),
    judge("gamepad.stick.up", "up", up, { exact: true }),
    judge("gamepad.stick.down", "down", down, { exact: true }),
  ]);
}

/** Keys: LEFT, UP and PUSH held together must all reach the engine and all take effect in one window. */
async function chordCase(s, base) {
  const h = await practiceDesktop(s, base);
  const acc = await window1({
    page: h.page,
    before: () => holdKey(h.page, SETUP.left.walk, WALK_MS),
    settle: 400,
    press: async () => {
      for (const code of ["ArrowLeft", "ArrowUp", "KeyX"]) await h.page.keyboard.down(code);
    },
    release: async () => {
      for (const code of ["KeyX", "ArrowUp", "ArrowLeft"]) await h.page.keyboard.up(code);
    },
  });
  return summarise([judge("chord.left", "left", acc), judge("chord.up", "up", acc), judge("chord.push", "push", acc)]);
}

/**
 * Several touch points at once. chromium: CDP multi-touch, every active point sent with each event.
 * firefox and webkit: synthetic pointer events, one pointerId per finger (NO_CAPTURE stubs capture).
 */
async function fingers(page, engine) {
  const active = new Map(); // id -> { sel, x, y }
  if (engine === "chromium") {
    const cdp = await cdpOf(page);
    const send = (type) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: [...active].map(([id, p]) => ({ id, x: p.x, y: p.y })),
      });
    return {
      down: (sel, id, x, y) => {
        active.set(id, { sel, x, y });
        return send("touchStart");
      },
      move: (sel, id, x, y) => {
        active.set(id, { sel, x, y });
        return send("touchMove");
      },
      upAll: async () => {
        active.clear();
        await send("touchEnd");
      },
    };
  }
  const dispatch = (sel, type, id, x, y) =>
    page.evaluate(
      ({ sel, type, id, x, y }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`${sel} not found`);
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y }),
        );
      },
      { sel, type, id, x, y },
    );
  return {
    down: (sel, id, x, y) => {
      active.set(id, { sel, x, y });
      return dispatch(sel, "pointerdown", id, x, y);
    },
    move: (sel, id, x, y) => {
      active.set(id, { sel, x, y });
      return dispatch(sel, "pointermove", id, x, y);
    },
    upAll: async () => {
      for (const [id, p] of active) await dispatch(p.sel, "pointerup", id, p.x, p.y);
      active.clear();
    },
  };
}

/** Two fingers (T3-T): the stick steers left while the jump button is held. Judged per action in one window. */
async function touchChordCase(s, base, engine) {
  const h = await practicePhone(s, base, engine === "chromium" ? [] : [NO_CAPTURE]);
  const f = await fingers(h.page, engine);
  const stick = await box(h.page, ".hud-stick");
  const jump = await box(h.page, JUMP);
  const reach = stick.width * 0.4;
  const hit = await h.page.evaluate(([x, y, sel]) => document.elementFromPoint(x, y)?.closest(sel) != null, [jump.x, jump.y, JUMP]);
  const acc = await window1({
    page: h.page,
    // walk toward the opposite wall on the stick first, so the left press has room to show
    before: async () => {
      await f.down(".hud-stick", 1, stick.x, stick.y);
      await f.move(".hud-stick", 1, stick.x + reach, stick.y);
      await sleep(WALK_MS);
      await f.upAll();
    },
    press: async () => {
      await f.down(".hud-stick", 1, stick.x, stick.y);
      await f.down(JUMP, 2, jump.x, jump.y);
      await f.move(".hud-stick", 1, stick.x - reach, stick.y);
    },
    release: () => f.upAll(),
  });
  return summarise([judge("touch.chord.left", "left", acc), judge("touch.chord.up", "up", acc, { hit })]);
}

/**
 * Switching devices mid-match: jump by keyboard, then by touch, then by the gamepad A button.
 * Each must reach the engine and take effect, and the match must still be running at the end.
 */
async function switchCase(s, base, engine) {
  const h = await practicePhone(s, base, engine === "firefox" ? [PAD_INIT, NO_CAPTURE] : [PAD_INIT]);
  const keyboard = await window1({
    page: h.page,
    press: () => h.page.keyboard.down("ArrowUp"),
    release: () => h.page.keyboard.up("ArrowUp"),
  });
  const touch = await touchDriver(h.page, engine);
  const { x, y } = await box(h.page, JUMP);
  const touchAcc = await window1({
    page: h.page,
    press: () => touch.down(JUMP, x, y),
    release: () => touch.up(JUMP),
  });
  const setA = (on) =>
    h.page.evaluate((v) => {
      window.__qaPad.buttons[0].pressed = v;
      window.__qaPad.buttons[0].value = v ? 1 : 0;
    }, on);
  const padAcc = await window1({ page: h.page, press: () => setA(true), release: () => setA(false) });
  const running = await h.page.locator(".offline.playing").isVisible();
  const out = summarise([
    judge("switch.keyboard", "up", keyboard),
    judge("switch.touch", "up", touchAcc),
    judge("switch.gamepad", "up", padAcc),
  ]);
  out.metrics["input.switch.running"] = running ? 1 : 0;
  if (!running) {
    out.pass = false;
    out.detail = [out.detail, "the match left the playing state"].filter(Boolean).join("; ");
  }
  return out;
}

const LATENCY_SAMPLES = Number(process.env.QA_LATENCY_SAMPLES ?? 30);
const LATENCY_P95_MS = 250; // the e2e 'input latency' band (client/e2e/scenarios.mjs); no D09 rubric file on disk
const NAV_SECTIONS = ["Controls", "Touch", "Sound", "Display", "Accessibility", "Chat"];

/** Opens Settings from the menu, on one section when given. */
async function openSettings(page, base, section) {
  await page.goto(base);
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  if (section) await page.locator(".settings-nav-item", { hasText: section }).click();
}

/** The .bind-row of one action label (Left, Right, ...). */
const bindRow = (page, label) =>
  page.locator(".bind-row").filter({ has: page.locator(".bind-label", { hasText: new RegExp(`^${label}$`) }) });

/** The key bindings stored in localStorage (null when nothing is stored). */
const savedKeys = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("neobox.prefs")).keys ?? null;
    } catch {
      return null;
    }
  });

/** Pass when every named check holds; `extra` explains the failure. Metrics are 0/1 per check. */
function verdict(prefix, checks, extra) {
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    pass: failed.length === 0,
    metrics: Object.fromEntries(Object.entries(checks).map(([name, ok]) => [`${prefix}.${name}`, ok ? 1 : 0])),
    detail: [failed.length ? `failed: ${failed.join(", ")}` : undefined, extra].filter(Boolean).join("; ") || undefined,
  };
}

/**
 * keys.rebind: a third key on Left, a conflict moved from Left to Right, both persisted across a reload,
 * and the new key moves the player in practice.
 */
async function rebindCase(s, base) {
  prepare(s);
  const h = await s.open("rebind");
  const { page } = h;
  await openSettings(page, base, "Controls");
  await bindRow(page, "Left").locator(".bind-add").click();
  await bindRow(page, "Left").locator(".is-capturing").waitFor();
  await page.keyboard.press("KeyQ");
  const added = (await savedKeys(page))?.left ?? [];
  const checks = { added: added.length === 3 && added.includes("KeyQ") };

  await bindRow(page, "Right").locator(".bind-add").click();
  await bindRow(page, "Right").locator(".is-capturing").waitFor();
  await page.keyboard.press("ArrowLeft");
  const conflict = bindRow(page, "Right").locator(".bind-conflict");
  checks.prompted = await conflict.waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (checks.prompted) await conflict.getByRole("button", { name: "Move", exact: true }).click();
  const after = await savedKeys(page);
  checks.moved = after?.right?.includes("ArrowLeft") === true && after?.left?.includes("ArrowLeft") === false;

  await openSettings(page, base, "Controls");
  const shownLeft = await bindRow(page, "Left").locator(".bind-slot").count();
  const shownRight = await bindRow(page, "Right").locator(".bind-slot").count();
  checks.reloaded = shownLeft === (after?.left?.length ?? -1) && shownRight === (after?.right?.length ?? -1);

  await startPractice(h, base, null);
  await sleep(LEVEL_SETTLE_MS);
  await page.evaluate(() => document.activeElement?.blur());
  const walk = SETUP.left?.walk;
  const acc = await window1({
    page,
    press: () => page.keyboard.down("KeyQ"),
    release: () => page.keyboard.up("KeyQ"),
    before: walk ? () => holdKey(page, walk, WALK_MS) : undefined,
    settle: walk ? 400 : 300,
  });
  const play = judge("KeyQ", "left", acc);
  checks.play = play.ok;
  return verdict("input.keys.rebind", checks, play.ok ? undefined : play.reason);
}

/** The touch layout saved in localStorage (null when nothing is stored). */
const savedTouchLayout = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("neobox.prefs")).touchLayout ?? null;
    } catch {
      return null;
    }
  });

/** Phone settings on the Touch section. */
async function phoneTouchSettings(page, base) {
  await page.goto(base);
  await dismissPhoneSplash(page);
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  await page.locator(".settings-nav-item", { hasText: "Touch" }).click();
}

/**
 * keys.rebind.touch: every touch action is rebindable. In Touch settings the tall Jump slot is set to Bat, so
 * Jump moves to the Bat slot. The layout survives a reload, and in practice each action's button (found by its
 * action) still reaches the engine.
 */
async function touchRebindCase(s, base, engine) {
  prepare(s, engine === "firefox" ? [NO_CAPTURE] : [], LANDSCAPE);
  const h = await s.open("touch-rebind", { phone: true, name: uniqueName("rb") });
  const { page } = h;
  await phoneTouchSettings(page, base);
  const slot = (name) => page.locator(`.touch-layout select[data-slot="${name}"]`);
  await slot("jump").selectOption("bat");
  const swapped = await savedTouchLayout(page);
  const checks = { swapped: swapped?.jump === "bat" && swapped?.bat === "up" };

  await phoneTouchSettings(page, base);
  checks.reloaded = (await slot("jump").inputValue()) === "bat" && (await slot("bat").inputValue()) === "up";

  await startPhonePractice(page, base);
  checks.slotRemapped = (await page.locator(".hud-touch-jump").getAttribute("data-action")) === "bat";
  const touch = await touchDriver(page, engine);
  const rows = [];
  for (const [area, action] of TOUCH_AREAS) {
    const sel = `.hud-touch[data-action="${action}"]`;
    const { x, y } = await box(page, sel);
    const hit = await page.evaluate(([x, y, sel]) => document.elementFromPoint(x, y)?.closest(sel) != null, [x, y, sel]);
    const acc = await window1({
      page,
      press: () => touch.down(sel, x, y),
      release: () => touch.up(sel),
      idle: action === "bat" ? batIdle : undefined,
    });
    rows.push(judge(`touch.${area}`, action, acc, { hit }));
  }
  for (const r of rows) checks[r.name.replace("touch.", "")] = r.ok;
  return verdict("input.keys.rebind.touch", checks, rows.filter((r) => !r.ok).map((r) => `${r.name} (${r.reason})`).join(", ") || undefined);
}

/** keys.chatLeak: game keys typed into the chat field never reach the engine's input mask; closing chat restores it. */
async function chatLeakCase(s, base) {
  const h = await roomDesktop(s, base);
  const { page } = h;
  const inChat = () => page.evaluate(() => document.activeElement?.classList.contains("hud-chat-input") === true);
  await page.keyboard.press("Enter");
  await page.locator(".hud-chat-input").waitFor({ state: "visible", timeout: 5000 });
  // The engine's own input mask (HOOK, nb_frame) is the exact view: any bit set while chat has focus is a leak.
  const leaks = [];
  for (const [action, codes] of Object.entries(DEFAULT_KEYS)) {
    for (const code of codes) {
      const acc = await window1({
        page,
        press: () => page.keyboard.down(code),
        release: () => page.keyboard.up(code),
      });
      if (!(await inChat())) leaks.push(`${code} (focus left chat)`);
      else if (acc.mask !== 0) leaks.push(`${code} (${action}: mask ${acc.mask})`);
    }
  }
  await page.keyboard.press("Escape");
  const closed = !(await inChat());
  const control = await window1({
    page,
    press: () => page.keyboard.down("ArrowRight"),
    release: () => page.keyboard.up("ArrowRight"),
  });
  const controlOk = (control.mask & BIT.right) !== 0;
  return verdict("input.keys.chatLeak", { noLeak: leaks.length === 0, closed, control: controlOk }, [
    leaks.length ? `game keys reached the engine from chat: ${leaks.join(", ")}` : undefined,
    controlOk ? undefined : `chat closed: ArrowRight did not set the right bit (mask ${control.mask})`,
  ].filter(Boolean).join("; ") || undefined);
}

/**
 * In-page probe for input.latency, installed once after the match starts. It reads back the full game canvas only while
 * a sample needs it: `settle` until the scene has been still for 500 ms, then `watch`, which compares every frame with that
 * rest frame. A change before the trusted keydown is a control flip and returns the probe to `settle`. The first change
 * after the keydown is the presented frame. Readbacks follow the draws (WebGL drawArrays, WebGPU queue.submit) through a
 * microtask, as in e2e/lib.mjs installProbe: a rAF callback can read a drawing buffer the browser has already cleared.
 * rAF only times the frames: every interval is recorded with whether a readback phase was active in it, so the probe's
 * own cost shows in input.rafMs.on against input.rafMs.off.
 */
const PIXEL_PROBE = () => {
  const p = (window.__latProbe = { phase: "off", base: null, prev: null, stillSince: 0, hit: null, control: 0, raf: [], last: 0, ctx: null, w: 0, h: 0 });
  const grab = (src) => {
    if (src.width !== p.w || src.height !== p.h) {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      p.ctx = c.getContext("2d", { willReadFrequently: true });
      p.w = src.width;
      p.h = src.height;
    }
    p.ctx.drawImage(src, 0, 0);
    return new Uint32Array(p.ctx.getImageData(0, 0, p.w, p.h).data.buffer);
  };
  const same = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const sample = () => {
    if (p.phase !== "settle" && p.phase !== "watch") return;
    const src = document.querySelector("#gl-host canvas");
    if (!(src instanceof HTMLCanvasElement) || src.width === 0) return;
    const t = performance.now();
    const cur = grab(src);
    if (p.phase === "settle") {
      if (p.prev && same(p.prev, cur)) {
        if (t - p.stillSince >= 500) {
          p.base = cur;
          p.phase = "watch";
        }
      } else p.stillSince = t;
      p.prev = cur;
    } else if (!same(p.base, cur)) {
      const key = window.__qaKeyT;
      if (key === null || t < key) {
        p.control++;
        p.phase = "settle";
        p.prev = cur;
        p.stillSince = t;
      } else {
        p.hit = t;
        p.phase = "done";
      }
    }
  };
  // One readback per task: draws within a frame callback coalesce, and the microtask runs after the last of them.
  let queued = false;
  const sampleAfterDraw = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sample();
    });
  };
  const glProto = WebGL2RenderingContext.prototype;
  const drawArrays = glProto.drawArrays;
  glProto.drawArrays = function (...args) {
    const result = drawArrays.apply(this, args);
    if (this.canvas.parentElement?.id === "gl-host") sampleAfterDraw();
    return result;
  };
  if (typeof GPUQueue !== "undefined") {
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      const result = submit.apply(this, args);
      sampleAfterDraw();
      return result;
    };
  }
  const step = () => {
    const t = performance.now();
    const on = p.phase === "settle" || p.phase === "watch";
    if (p.last) {
      p.raf.push({ dt: t - p.last, on });
      if (p.raf.length > 20000) p.raf.splice(0, 5000);
    }
    p.last = t;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** Polls the in-page latency probe until it reaches `phase`; true when it did within the timeout. */
async function waitProbePhase(page, phase, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await page.evaluate(() => window.__latProbe.phase)) === phase) return true;
    await sleep(50);
  }
  return false;
}

/** Sorted-rank quantile (nearest rank); null for no values. */
function rank(xs, q) {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.ceil(q * v.length) - 1];
}

/**
 * input.latency: in a started match, LATENCY_SAMPLES valid samples (default 30). Each walks the player to the left wall, waits until the full-res frame
 * has been still for 500 ms (player at rest), then presses ArrowRight. latency = keydown to the first presented frame
 * whose pixels differ from the rest frame at full canvas resolution. stateMs = keydown to the first engine frame in
 * which the local player's state differs from rest. Pass: p95 within the band, no sample without a change, and no
 * change in a frame before the keydown. A sample whose rest precondition fails is retried, not counted.
 */
async function latencyCase(s, base, engine) {
  const h = await roomDesktop(s, base);
  const { page } = h;
  await page.evaluate(PIXEL_PROBE);
  const samples = [];
  let skipped = 0; // rest-precondition misses, retried
  for (let attempts = 0; samples.length < LATENCY_SAMPLES && attempts < LATENCY_SAMPLES * 3; attempts++) {
    const i = samples.length;
    await holdKey(page, "ArrowLeft", 1200); // back to the left wall, so ArrowRight has room to move
    await page.evaluate(() => {
      const p = window.__latProbe;
      p.phase = "settle";
      p.prev = null;
      p.stillSince = performance.now();
    });
    if (!(await waitProbePhase(page, "watch", 5000))) {
      await page.evaluate(() => {
        window.__latProbe.phase = "off";
      });
      skipped++;
      continue;
    }
    const control0 = await page.evaluate(() => {
      const p = window.__latProbe;
      if (p.phase !== "watch") return null;
      window.__qaKeyT = null;
      window.__qa.ref = { x: window.__qa.x, y: window.__qa.y };
      window.__qa.stateT = null;
      window.__qa.watch = true;
      p.hit = null;
      return p.control;
    });
    if (control0 === null) {
      await page.evaluate(() => {
        window.__latProbe.phase = "off";
      });
      skipped++;
      continue;
    }
    await page.keyboard.down("ArrowRight");
    let r = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      r = await page.evaluate(() => ({ keyT: window.__qaKeyT, hit: window.__latProbe.hit, stateT: window.__qa.stateT, control: window.__latProbe.control }));
      if (r.hit !== null && r.stateT !== null) break;
      await sleep(10);
    }
    await page.keyboard.up("ArrowRight");
    await page.evaluate(() => {
      window.__latProbe.phase = "off";
      window.__qa.watch = false;
    });
    const miss = r?.keyT == null || r.hit === null || r.stateT === null
      ? await page.evaluate(() => ({
          keyT: window.__qaKeyT,
          hitPhase: window.__latProbe.phase,
          x: window.__qa.x,
          y: window.__qa.y,
          ref: window.__qa.ref,
          mask: window.__qa.cur,
          ready: window.__qa.ready,
          stamina: window.__qa.stamina,
          focus: document.activeElement?.tagName ?? null,
          health: window.__qa.health,
          lives: window.__qa.lives,
          alive: window.__qa.alive,
          calls: window.__qa.calls,
        }))
      : undefined;
    samples.push({
      i,
      latencyMs: r?.keyT != null && r.hit !== null ? r.hit - r.keyT : null,
      stateMs: r?.keyT != null && r.stateT !== null ? r.stateT - r.keyT : null,
      controlFlips: (r?.control ?? control0) - control0,
      miss,
    });
  }
  const raf = await page.evaluate(() => window.__latProbe.raf.slice());
  const rafOn = raf.filter((r) => r.on).map((r) => r.dt);
  const rafOff = raf.filter((r) => !r.on).map((r) => r.dt);
  const lat = samples.map((x) => x.latencyMs ?? null);
  const st = samples.map((x) => x.stateMs ?? null);
  const misses = lat.filter((x) => x === null).length;
  const flips = samples.reduce((n, x) => n + (x.controlFlips ?? 0), 0);
  const p95 = rank(lat.map((x) => x ?? Infinity), 0.95);
  const p50 = rank(lat.map((x) => x ?? Infinity), 0.5);
  const sp95 = rank(st.map((x) => x ?? Infinity), 0.95);
  const sp50 = rank(st.map((x) => x ?? Infinity), 0.5);
  const off50 = rank(rafOff, 0.5);
  const off95 = rank(rafOff, 0.95);
  const on50 = rank(rafOn, 0.5);
  const on95 = rank(rafOn, 0.95);
  const ms = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const ms1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
  const fmt = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : "no frame");
  const file = `evidence/input-${engine}/latency-samples.json`;
  writeFileSync(path.join(outDir(), file), JSON.stringify({ samples, raf }));
  return {
    pass: Number.isFinite(p95) && p95 <= LATENCY_P95_MS && misses === 0 && flips === 0 && samples.length === LATENCY_SAMPLES,
    metrics: {
      "input.latency.ms": ms(p95),
      "input.latency.p50": ms(p50),
      "input.latency.misses": misses,
      "input.latency.retries": skipped,
      "input.latency.stateMs": ms(sp95),
      "input.latency.stateP50": ms(sp50),
      "input.latency.controlFlips": flips,
      "input.rafMs.off.p50": ms1(off50),
      "input.rafMs.off.p95": ms1(off95),
      "input.rafMs.on.p50": ms1(on50),
      "input.rafMs.on.p95": ms1(on95),
    },
    detail: `p95 ${fmt(p95)} over ${samples.length}/${LATENCY_SAMPLES} samples (band ${LATENCY_P95_MS} ms), p50 ${fmt(p50)}; stateMs p95 ${fmt(sp95)}, p50 ${fmt(sp50)}; rAF p50/p95 ${ms1(off50) ?? "n/a"}/${ms1(off95) ?? "n/a"} ms probe off, ${ms1(on50) ?? "n/a"}/${ms1(on95) ?? "n/a"} ms probe on; ${misses} without a presented change, ${flips} control flips, ${skipped} retried for a missed rest precondition`,
    evidence: [file],
  };
}

/** drag.noAlternative: every settings slider takes a keyboard step, and the map editor can add a shape by key. */
async function dragCase(s, base) {
  prepare(s);
  const h = await s.open("drag");
  const { page } = h;
  await openSettings(page, base, null);
  const sliders = [];
  for (const section of NAV_SECTIONS) {
    await page.locator(".settings-nav-item", { hasText: section }).click();
    const count = await page.locator("input[type=range]:visible").count();
    for (let i = 0; i < count; i++) {
      const slider = page.locator("input[type=range]:visible").nth(i);
      const name = (await slider.getAttribute("aria-label")) ?? `${section} slider ${i + 1}`;
      const before = await slider.inputValue();
      await slider.focus();
      await page.keyboard.press("ArrowRight");
      let moved = (await slider.inputValue()) !== before;
      if (!moved) {
        await page.keyboard.press("ArrowLeft");
        moved = (await slider.inputValue()) !== before;
      }
      sliders.push({ name, moved });
    }
  }

  const editor = await signedIn(s, "mapper");
  const ed = editor.page;
  await navTo(ed, "Map editor");
  const canvas = ed.locator(".editor-canvas");
  await canvas.waitFor();
  const undo = ed.getByRole("button", { name: "Undo", exact: true });
  await ed.evaluate(() => document.activeElement?.blur());
  const undoBefore = await undo.isDisabled();
  await ed.keyboard.press("KeyW"); // rectangle tool
  await ed.keyboard.press("Enter");
  // Named alternatives (WCAG 2.5.7): the inspector fields for the box Enter just placed, read before Delete removes it.
  const fieldNames = await ed.locator(".inspector label.field").evaluateAll((els) => els.map((e) => e.querySelector(".field-label")?.textContent?.trim()));
  const pointNames = await ed.locator(".inspector input[aria-label^='Point ']").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  for (const key of ["Space", "ArrowRight", "ArrowDown", "Delete"]) await ed.keyboard.press(key);
  const keyboardMade = undoBefore && !(await undo.isDisabled());
  const CORNERS = [1, 2, 3, 4].flatMap((k) => [`Point ${k} X`, `Point ${k} Y`]);
  const missing = [...["X", "Y", "Angle (deg)", "Offset X", "Offset Y"].filter((f) => !fieldNames.includes(f)), ...CORNERS.filter((f) => !pointNames.includes(f))];
  // Control: the same tool with a pointer drag does create a shape, so Undo does reflect edits.
  const box = await canvas.boundingBox();
  const x = box.x + box.width * 0.35;
  const y = box.y + box.height * 0.35;
  await ed.mouse.move(x, y);
  await ed.mouse.down();
  await ed.mouse.move(x + 120, y + 80, { steps: 10 });
  await ed.mouse.up();
  const pointerMade = await undo.isEnabled();

  const stuck = sliders.filter((r) => !r.moved).map((r) => r.name);
  return verdict(
    "input.drag",
    { sliders: sliders.length > 0 && stuck.length === 0, editorKeyboard: keyboardMade, editorFields: missing.length === 0 },
    [
      `${sliders.length} sliders checked`,
      stuck.length ? `no keyboard step: ${stuck.join(", ")}` : undefined,
      keyboardMade ? undefined : "map editor: no key adds a shape (rectangle is drag-only)",
      missing.length ? `map editor: inspector lacks ${missing.join(", ")}` : "map editor alternatives: body move and rotate = X, Y, Angle (deg); shape move = Offset X/Y (arrows also nudge); box or polygon resize = Point k X/Y (4 corners); create = Enter or two taps",
      pointerMade ? undefined : "pointer control: drag did not create a shape, editor result inconclusive",
    ]
      .filter(Boolean)
      .join("; "),
  );
}

const server = await startServer();
const base = server.base;

for (const engine of selectedEngines()) {
  const browser = await launchEngine(engine);
  const results = new Results("input", engine);
  const opts = engine === "chromium" ? { browser, base } : { browser, base, ignore: [/Navigated away from page/] };

  const only = process.argv.slice(2);
  const want = (id) => only.length === 0 || only.some((f) => id.includes(f));
  if (want("keys.default")) await results.case("keys.default", (s) => keysCase(s, base), opts);
  if (want("keys.reserved")) await results.case("keys.reserved", (s) => reservedCase(s, base), opts);
  if (want("keys.chord")) await results.case("keys.chord", (s) => chordCase(s, base), opts);
  if (want("touch.buttons")) await results.case("touch.buttons", (s) => touchButtonsCase(s, base, engine), opts);
  if (want("touch.stick")) await results.case("touch.stick", (s) => touchStickCase(s, base, engine), opts);
  if (want("touch.chord")) await results.case("touch.chord", (s) => touchChordCase(s, base, engine), opts);
  if (want("gamepad.buttons")) await results.case("gamepad.buttons", (s) => gamepadButtonsCase(s, base), opts);
  if (want("gamepad.stick")) await results.case("gamepad.stick", (s) => gamepadStickCase(s, base), opts);
  if (want("input.switch")) await results.case("input.switch", (s) => switchCase(s, base, engine), opts);
  if (want("keys.rebind")) await results.case("keys.rebind", (s) => rebindCase(s, base), opts);
  if (want("keys.rebind.touch")) await results.case("keys.rebind.touch", (s) => touchRebindCase(s, base, engine), opts);
  if (want("keys.chatLeak")) await results.case("keys.chatLeak", (s) => chatLeakCase(s, base), opts);
  if (want("input.latency")) await results.case("input.latency", (s) => latencyCase(s, base, engine), opts);
  if (want("drag.noAlternative")) await results.case("drag.noAlternative", (s) => dragCase(s, base), opts);

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
