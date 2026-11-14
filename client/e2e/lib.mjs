// Shared helpers for the browser e2e suite: server and browser lifecycle, the
// canvas probe, and UI actions. Everything runs against the real server build.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = path.resolve(E2E_DIR, "..");
export const SHOTS_DIR = path.join(E2E_DIR, "shots");
export const DIST_DIR = path.resolve(process.env.NEOBOX_DIST || path.join(CLIENT_DIR, "..", "dist-server"));
export const ADMIN_PASSWORD = "e2e-admin";
export const PASSWORD = "e2e-password";
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const DESKTOP = { viewport: { width: 1280, height: 800 } };
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const STEP_TIMEOUT = 15_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cleanup callbacks (server, browser, temp dirs); run on exit, in reverse order. */
const cleanups = [];
export function onCleanup(fn) {
  cleanups.push(fn);
}
export async function runCleanups() {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      await fn();
    } catch (err) {
      console.error(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------- browser

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

/** CHROME_PATH, then Playwright's own Chromium, then common Chrome/Edge installs. */
export async function resolveChromium() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    return process.env.CHROME_PATH;
  }
  const { chromium } = await import("playwright-core");
  let bundled = null;
  try {
    bundled = chromium.executablePath();
  } catch {
    bundled = null;
  }
  for (const candidate of [bundled, ...CHROME_PATHS]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "no Chromium found. Set CHROME_PATH to a Chrome, Edge or Chromium binary, or run `bunx playwright-core install chromium`.",
  );
}

/** Headless browser with audio muted; closed at exit. */
export async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  const executablePath = await resolveChromium();
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--mute-audio"] });
  onCleanup(() => browser.close());
  return browser;
}

// ---------------------------------------------------------------- server

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts the built server on a free port with a fresh database; stopped and cleaned at exit. */
export async function startServer() {
  const exe = path.join(DIST_DIR, process.platform === "win32" ? "neobox-server.exe" : "neobox-server");
  if (!existsSync(exe) || !existsSync(path.join(DIST_DIR, "client", "index.html"))) {
    throw new Error(`no server build in ${DIST_DIR}: run \`bash deploy/build.sh\` first (or set NEOBOX_DIST)`);
  }
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "neobox-e2e-"));
  const port = await freePort();
  const env = {
    ...process.env,
    NEOBOX_BIND: `127.0.0.1:${port}`,
    NEOBOX_RTC_BIND: "off",
    NEOBOX_DATA: path.join(dataDir, "neobox.db"),
    NEOBOX_STATIC: path.join(DIST_DIR, "client"),
    NEOBOX_MAPS: path.join(DIST_DIR, "maps"),
    NEOBOX_ADMIN_PASSWORD: ADMIN_PASSWORD,
    NEOBOX_MAX_CONNS_PER_IP: "64",
    NEOBOX_TRUST_PROXY: "true", // per-context X-Forwarded-For (see nextClientIp); loopback only
  };
  const proc = spawn(exe, [], { env, cwd: dataDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  const keep = (chunk) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
      await exited;
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  onCleanup(stop);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode}:\n${output}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not answer /healthz:\n${output}`);
    await sleep(100);
  }
  return { base, output: () => output };
}

/** Built-in maps from the server: [{ name, code }]. */
export async function builtinMaps(base) {
  const res = await fetch(`${base}/api/maps`);
  if (!res.ok) throw new Error(`GET /api/maps: HTTP ${res.status}`);
  const maps = await res.json();
  if (!Array.isArray(maps) || maps.length === 0) throw new Error("server lists no built-in maps");
  return maps;
}

/** Admin session cookie per server (admin logins are rate limited). */
const adminCookies = new Map();

async function adminCookie(base) {
  if (adminCookies.has(base)) return adminCookies.get(base);
  const login = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`admin login: HTTP ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  adminCookies.set(base, cookie);
  return cookie;
}

/** The server's live view of room `code` from the admin API (players with `connected`). */
export async function adminRoom(base, code) {
  const res = await fetch(`${base}/admin/api/state`, { headers: { cookie: await adminCookie(base) } });
  if (!res.ok) throw new Error(`admin state: HTTP ${res.status}`);
  const room = (await res.json()).rooms.find((r) => r.code === code);
  if (!room) throw new Error(`room ${code} is not on the server`);
  return room;
}

// ---------------------------------------------------------------- scenarios

/** A scenario: its browser contexts/pages, recorded page and console errors, and cleanup. */
export class Scenario {
  constructor(name, env) {
    this.name = name;
    this.env = env;
    this.handles = [];
  }

  get base() {
    return this.env.base;
  }

  /**
   * Opens a fresh headless context and page. `name` pre-fills the guest name
   * (localStorage "neobox.name", only when unset). Dialogs fail the scenario
   * unless `handle.acceptDialogs` is set.
   */
  async open(label, { phone = false, name, clipboard = false } = {}) {
    const ip = nextClientIp();
    const context = await this.env.browser.newContext({
      ...(phone ? PHONE : DESKTOP),
      acceptDownloads: true,
      extraHTTPHeaders: { "X-Forwarded-For": ip },
    });
    if (clipboard) {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: this.base });
      // A system share sheet would take the invite instead of the clipboard; the suite reads the clipboard.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
      });
    }
    if (name) {
      await context.addInitScript((value) => {
        if (localStorage.getItem("neobox.name") === null) localStorage.setItem("neobox.name", value);
      }, name);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT);
    const handle = { label, context, page, ip, problems: [], acceptDialogs: false };
    page.on("pageerror", (err) => handle.problems.push(`${label}: page error: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const url = msg.location().url ?? "";
      handle.problems.push(`${label}: console error: ${msg.text()}${url ? ` (${url})` : ""}`);
    });
    page.on("dialog", (dialog) => {
      if (handle.acceptDialogs) {
        void dialog.accept();
      } else {
        handle.problems.push(`${label}: unexpected dialog: ${dialog.message()}`);
        void dialog.dismiss();
      }
    });
    this.handles.push(handle);
    return handle;
  }

  problems() {
    return this.handles.flatMap((h) => h.problems);
  }

  /** Screenshots of every open page, for a failed scenario. Returns the written paths. */
  async screenshot() {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const written = [];
    for (const h of this.handles) {
      const file = path.join(SHOTS_DIR, `${this.name}-${h.label}.png`);
      try {
        await h.page.screenshot({ path: file, timeout: 5_000 });
        written.push(file);
      } catch {
        // page already closed or crashed
      }
    }
    return written;
  }

  async close() {
    for (const h of this.handles) {
      await h.context.close().catch(() => {});
    }
  }
}

export function uniqueName(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`.slice(0, 15);
}

/**
 * Each browser context gets its own client address: the server limits account
 * attempts per IP (5 a minute) and trusts X-Forwarded-For (NEOBOX_TRUST_PROXY defaults on).
 */
let clientIps = 0;
export function nextClientIp() {
  clientIps++;
  return `10.${Math.floor(clientIps / 250)}.${clientIps % 250}.1`;
}

/** Registers an account through the API; the session cookie lands in the handle's context. */
export async function signUp(handle, base, name) {
  const res = await handle.context.request.post(`${base}/api/account/register`, {
    data: { name, password: PASSWORD },
    headers: { "X-Forwarded-For": handle.ip },
  });
  if (!res.ok()) throw new Error(`register ${name}: HTTP ${res.status()} ${await res.text()}`);
}

/** A page signed in as a new account, on the menu. */
export async function signedIn(s, label, name = uniqueName(label)) {
  const h = await s.open(label);
  await signUp(h, s.base, name);
  await h.page.goto(s.base);
  await menuName(h.page).waitFor();
  return { ...h, userName: name };
}

// ---------------------------------------------------------------- UI helpers

export const menuName = (page) => page.getByPlaceholder("name", { exact: true });

export function button(scope, name) {
  return scope.getByRole("button", { name, exact: true });
}

/** Clicks a menu link (Library, Friends, Practice, Replay, Map editor, Settings, About). */
export async function navTo(page, label) {
  await button(page.getByRole("navigation", { name: "more", exact: true }), label).click();
}

/** Plays from the menu: fills the guest name when needed, then Play (or Quick play). */
export async function playFromMenu(page, name, { quick = false } = {}) {
  const input = menuName(page);
  if (name && !(await input.getAttribute("readonly"))) await input.fill(name);
  await button(page, quick ? "Quick play" : "Play").click();
}

/** Creates a room from the menu. Returns its code. */
export async function createRoom(h, base, roomName, { isPublic } = {}) {
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await playFromMenu(page, null);
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
  await page.getByLabel("room name", { exact: true }).fill(roomName);
  if (isPublic !== undefined) {
    const box = page.getByLabel("Public", { exact: true });
    if ((await box.isChecked()) !== isPublic) await box.setChecked(isPublic);
  }
  await button(page, "Create room").click();
  await roomTitle(page, roomName).waitFor();
  return roomCode(page);
}

export const roomTitle = (page, roomName) => {
  const title = page.locator("h1.room-title");
  return roomName ? title.filter({ hasText: roomName }) : title;
};

export async function roomCode(page) {
  const fact = page.locator("div.room-fact").filter({ has: page.locator("dt", { hasText: /^Code$/ }) });
  const code = ((await fact.locator("dd").textContent()) ?? "").trim();
  if (!ROOM_CODE_RE.test(code)) throw new Error(`room code "${code}" is not a valid room code`);
  return code;
}

/** Opens the room page directly from an invite URL (`origin/CODE`). */
export async function joinByInvite(h, base, code, roomName) {
  await h.page.goto(`${base}/${code}`);
  await roomTitle(h.page, roomName).waitFor();
}

/** Makes the room's map a built-in one when none is selected yet. */
export async function ensureRoomMap(page) {
  const mapName = page.locator(".room-map-name");
  if ((await mapName.textContent())?.trim()) return;
  await page.locator(".room-map-controls .room-btn").first().click();
  await mapName.filter({ hasText: /\S/ }).waitFor();
}

/** Host starts the match; waits until every listed page shows the HUD. */
export async function startMatch(host, others = []) {
  await ensureRoomMap(host.page);
  await button(host.page, "Start").click();
  for (const h of [host, ...others]) {
    await h.page.locator(".hud-leave").waitFor({ state: "visible" });
  }
}

/** A room with a host and a guest (via the host's invite link, read from the clipboard), in a running match. */
export async function matchWithGuest(s, { clipboard = true } = {}) {
  const hostName = uniqueName("host");
  const guestName = uniqueName("guest");
  const roomName = uniqueName("room");
  const host = await s.open("host", { name: hostName, clipboard });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const guest = await s.open("guest", { name: guestName });
  if (clipboard) {
    await button(host.page, "Invite").click();
    // The toast fades quickly, so poll the clipboard, which holds the link.
    let url = "";
    for (let i = 0; i < 50 && url !== `${s.base}/${code}`; i++) {
      url = await host.page.evaluate(() => navigator.clipboard.readText());
      if (url !== `${s.base}/${code}`) await sleep(100);
    }
    if (url !== `${s.base}/${code}`) throw new Error(`invite link is "${url}", expected ${s.base}/${code}`);
    await guest.page.goto(url);
  } else {
    await joinByInvite(guest, s.base, code, roomName);
  }
  await roomTitle(guest.page, roomName).waitFor();
  await host.page.locator("li.room-player").filter({ hasText: guestName }).waitFor();
  await startMatch(host, [guest]);
  return { host, guest, code, roomName, hostName, guestName };
}

// ---------------------------------------------------------------- canvas probe

/**
 * Installs (once per page) a requestAnimationFrame probe. Each frame it copies
 * the match canvas (#gl-host canvas) into a small 2D canvas and hashes it, so
 * pixel readback happens inside the frame the WebGL/WebGPU buffer is valid.
 * Also records the time of the last ArrowRight keydown.
 */
export function installProbe() {
  if (window.__e2eProbe) return;
  const W = 96;
  const H = 54;
  const scratch = document.createElement("canvas");
  scratch.width = W;
  scratch.height = H;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  const probe = {
    distinct: 0,
    frames: 0,
    hash: 0,
    changes: [],
    lastChange: performance.now(),
    keyT: null,
  };
  window.__e2eProbe = probe;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "ArrowRight" && !e.repeat) probe.keyT = performance.now();
    },
    true,
  );
  const step = (now) => {
    const src = document.querySelector("#gl-host canvas");
    if (src instanceof HTMLCanvasElement && src.width > 0 && src.height > 0) {
      sctx.clearRect(0, 0, W, H);
      sctx.drawImage(src, 0, 0, W, H);
      const data = new Uint32Array(sctx.getImageData(0, 0, W, H).data.buffer);
      const seen = new Set();
      let hash = 0x811c9dc5;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        hash = Math.imul(hash ^ v, 16777619);
        if (seen.size < 64) seen.add(v);
      }
      probe.distinct = seen.size;
      probe.frames++;
      if (hash !== probe.hash) {
        probe.hash = hash;
        probe.changes.push(now);
        if (probe.changes.length > 5000) probe.changes.shift();
        probe.lastChange = now;
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export async function ensureProbe(page) {
  await page.evaluate(installProbe);
}

/** Waits until the page's match/practice/replay canvas shows at least `minColours` distinct colours. */
export async function waitForPixels(h, label = "canvas", minColours = 3, timeoutMs = STEP_TIMEOUT) {
  await ensureProbe(h.page);
  const end = Date.now() + timeoutMs;
  let last = 0;
  for (;;) {
    last = await h.page.evaluate(() => window.__e2eProbe?.distinct ?? 0);
    if (last >= minColours) return last;
    if (Date.now() > end) throw new Error(`${h.label}: ${label} is blank (${last} distinct colours)`);
    await sleep(200);
  }
}

export async function probeChanges(page) {
  return page.evaluate(() => window.__e2eProbe?.changes.length ?? 0);
}

/** Waits until the canvas has not changed for `quietMs`. */
export async function waitQuiet(page, quietMs = 800, timeoutMs = 10_000) {
  await ensureProbe(page);
  const end = Date.now() + timeoutMs;
  for (;;) {
    const since = await page.evaluate(() => performance.now() - (window.__e2eProbe?.lastChange ?? 0));
    if (since >= quietMs) return;
    if (Date.now() > end) throw new Error("the scene never settles (it keeps changing)");
    await sleep(100);
  }
}

/** Latest keydown(ArrowRight) time and the first canvas change after it, in ms. */
export async function measureFirstChange(page, timeoutMs = 1500) {
  await page.evaluate(() => {
    window.__e2eProbe.keyT = null;
  });
  await page.keyboard.down("ArrowRight");
  const end = Date.now() + timeoutMs;
  let result = null;
  try {
    while (Date.now() < end) {
      result = await page.evaluate(() => {
        const p = window.__e2eProbe;
        if (p.keyT === null) return null;
        const first = p.changes.find((t) => t > p.keyT);
        return first === undefined ? null : first - p.keyT;
      });
      if (result !== null) break;
      await sleep(10);
    }
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  return result;
}

/** Fails on any horizontal overflow of the page. */
export async function expectNoOverflow(page, label) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    inner: window.innerWidth,
  }));
  if (scroll > inner) throw new Error(`${label}: horizontal overflow (${scroll}px > ${inner}px)`);
}

export function writeTemp(dir, name, bytes) {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}
