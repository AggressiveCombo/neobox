// Shared helpers for the browser e2e suite: server and browser lifecycle, the
// canvas probe, and UI actions. Everything runs against the real server build.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = path.resolve(E2E_DIR, "..");
export const SHOTS_DIR = path.join(E2E_DIR, "shots");
/**
 * The server build every run uses: --dist or NEOBOX_DIST, with no default (a stale default measured the wrong build).
 * Prints the build and its BUILT_FROM stamp (the commit it was built from) so the run's log names it.
 */
function resolveDist() {
  const i = process.argv.indexOf("--dist");
  if (i >= 0 && process.argv[i + 1]) process.env.NEOBOX_DIST = process.argv[i + 1];
  const dir = process.env.NEOBOX_DIST;
  if (!dir) {
    console.error("no build: pass --dist <build dir> or set NEOBOX_DIST");
    process.exit(2);
  }
  const abs = path.resolve(dir);
  const stamp = path.join(abs, "BUILT_FROM");
  console.error(`build: ${abs} (BUILT_FROM ${existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "none"})`);
  return abs;
}
export const DIST_DIR = resolveDist();
export const ADMIN_PASSWORD = "e2e-admin";
export const PASSWORD = "e2e-password";
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const DESKTOP = { viewport: { width: 1280, height: 800 } };
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
/**
 * Phone context options for `browser`. Firefox drops pointer events from synthetic mouse input in an isMobile
 * context (only mousedown arrives, so the touch stick's pointer handlers never run), so there it is emulated
 * as hasTouch without isMobile.
 */
export function phoneOptions(browser) {
  return browser.browserType().name() === "firefox" ? { ...PHONE, isMobile: false } : PHONE;
}
const STEP_TIMEOUT = 15_000;
/** Firefox logs a web font still downloading when the page navigates away as a console error (NS_BINDING_ABORTED, status 2152398850). */
const FONT_ABORT_RE = /downloadable font: download failed .*status=2152398850\b/;
/** YouTube's jukebox embed logs rejected third-party cookies; only that message from a YouTube-origin file is noise. */
const YOUTUBE_COOKIE_RE = /Cookie .* has been rejected/;
/** Firefox's report of a WebSocket closed by a page load that had not finished (a reload right after a match joins). */
const RELOAD_SOCKET_RE = /^The connection to wss?:\/\/\S+ was interrupted while the page was loading\.$/;
const YOUTUBE_ORIGIN_RE = /^https:\/\/(www\.)?youtube\.com\//;
/** A stand-in for YouTube's IFrame API: `YT.Player` reports ready on the next tick and has no-op controls. */
const YOUTUBE_API_STUB = `window.YT = { Player: function (el, opts) {
  setTimeout(() => opts.events.onReady(), 0);
  const noop = () => {};
  return { cueVideoById: noop, loadVideoById: noop, playVideo: noop, pauseVideo: noop, seekTo: noop,
    getCurrentTime: () => 0, setVolume: noop, mute: noop, unMute: noop };
} };
window.onYouTubeIframeAPIReady();`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the locator's box is the same on two reads in a row (a transition has ended); returns that box. */
export async function waitStable(locator, timeoutMs = STEP_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const box = await locator.boundingBox();
    if (box && last && box.x === last.x && box.y === last.y && box.width === last.width && box.height === last.height) return box;
    if (Date.now() > deadline) throw new Error("element box still moving");
    last = box;
    await sleep(50);
  }
}

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

/**
 * Silences a context's pages on every engine (the tests run on the user's machine): Web Audio
 * output goes through a zero gain and media elements start muted. Chromium also gets
 * --mute-audio and Firefox media.volume_scale 0 from launchEngine; WebKit has no switch, so this
 * script is what keeps it quiet.
 */
export async function muteAudio(context) {
  await context.addInitScript(() => {
    const AN = window.AudioNode;
    if (AN) {
      const connect = AN.prototype.connect;
      const silent = new WeakMap();
      AN.prototype.connect = function (dest, ...rest) {
        if (typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode) {
          let g = silent.get(dest);
          if (!g) {
            g = this.context.createGain();
            g.gain.value = 0;
            connect.call(g, dest);
            silent.set(dest, g);
          }
          return connect.call(this, g, ...rest);
        }
        return connect.call(this, dest, ...rest);
      };
    }
    // Media elements (menu/match music, the YouTube jukebox inside its iframe) stay muted
    // whatever the page sets: every write to muted/volume stores muted=true and volume=0 through
    // the native setters, and play() forces both first.
    const proto = HTMLMediaElement.prototype;
    const nativeMuted = Object.getOwnPropertyDescriptor(proto, "muted");
    const nativeVolume = Object.getOwnPropertyDescriptor(proto, "volume");
    const silence = (el) => {
      nativeMuted.set.call(el, true);
      nativeVolume.set.call(el, 0);
    };
    Object.defineProperty(proto, "muted", { configurable: true, get() { return nativeMuted.get.call(this); }, set() { silence(this); } });
    Object.defineProperty(proto, "volume", { configurable: true, get() { return nativeVolume.get.call(this); }, set() { silence(this); } });
    const play = proto.play;
    proto.play = function (...a) {
      silence(this);
      return play.apply(this, a);
    };
  });
}

/**
 * Any engine ("chromium" | "firefox" | "webkit"), headless and muted; closed at exit. Every
 * context it creates (newContext, newPage) is passed through muteAudio automatically.
 */
export async function launchEngine(name) {
  const pw = await import("playwright-core");
  let browser;
  if (name === "chromium") browser = await launchBrowser();
  else if (name === "firefox") {
    // media.cubeb.force_null_context: audio renders into a null device, so nothing reaches the speakers.
    const firefoxUserPrefs = { "media.volume_scale": "0.0", "media.cubeb.force_null_context": true };
    browser = await pw.firefox.launch({ headless: true, firefoxUserPrefs });
  }
  else if (name === "webkit") browser = await pw.webkit.launch({ headless: true });
  else throw new Error(`unknown engine ${name}`);
  if (name !== "chromium") onCleanup(() => browser.close());
  // Clipboard permissions exist on Chromium only; the clipboard scenarios fall back to the invite link without them.
  browser.clipboard = await probeClipboard(browser);
  // Playwright's WebKit build has no RTCPeerConnection or Web Audio: those features are skipped or asserted absent there.
  Object.assign(browser, await probeFeatures(browser));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (opts) => {
    const ctx = await newContext(opts);
    await muteAudio(ctx);
    return ctx;
  };
  browser.newPage = async (opts) => (await browser.newContext(opts)).newPage();
  return browser;
}

/** Whether the engine grants clipboard permissions. Firefox refuses the grant ("Unknown permission"); WebKit accepts it but refuses the page once granted. Both must work. */
async function probeClipboard(browser) {
  const ctx = await browser.newContext();
  try {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1" });
    await (await ctx.newPage()).close();
    return true;
  } catch {
    return false;
  } finally {
    await ctx.close();
  }
}

/** Which web APIs the engine ships: RTCPeerConnection (the UDP data channel) and Web Audio (sound effects). */
async function probeFeatures(browser) {
  const ctx = await browser.newContext();
  try {
    return await (await ctx.newPage()).evaluate(() => ({
      webrtc: typeof RTCPeerConnection === "function",
      webAudio: typeof AudioContext === "function" || typeof webkitAudioContext === "function",
    }));
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- server

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Windows Firewall asks the desktop user (an elevation prompt) the first time an executable at a new path listens on a
 * non-loopback address. Every build lives in its own dist directory, so a server that binds WebRTC to the LAN runs from
 * this one fixed path instead: at most one prompt, ever, on this machine. Loopback-only servers run from the dist.
 */
const LAN_EXE = path.join(os.homedir(), ".neobox-qa", process.platform === "win32" ? "neobox-server.exe" : "neobox-server");

function lanExe(exe) {
  const want = readFileSync(exe);
  if (existsSync(LAN_EXE) && readFileSync(LAN_EXE).equals(want)) return LAN_EXE;
  mkdirSync(path.dirname(LAN_EXE), { recursive: true });
  try {
    copyFileSync(exe, LAN_EXE);
  } catch (err) {
    throw new Error(`${LAN_EXE} is in use by another build's server (${err.code}): run LAN (WebRTC) scenarios one build at a time`);
  }
  return LAN_EXE;
}

const isLoopbackBind = (v) => v === undefined || v === "off" || /^(127\.|\[?::1\]?:|localhost:)/.test(v);

/** Starts the built server (on `port`, or a free one) with a fresh database and `extraEnv` on top; stopped and cleaned at exit. */
export async function startServer({ port: wantPort, extraEnv = {} } = {}) {
  const distExe = path.join(DIST_DIR, process.platform === "win32" ? "neobox-server.exe" : "neobox-server");
  if (!existsSync(distExe) || !existsSync(path.join(DIST_DIR, "client", "index.html"))) {
    throw new Error(`no server build in ${DIST_DIR}: run \`bash deploy/build.sh\` first (or set NEOBOX_DIST)`);
  }
  const exe = isLoopbackBind(extraEnv.NEOBOX_RTC_BIND) && isLoopbackBind(extraEnv.NEOBOX_BIND) ? distExe : lanExe(distExe);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "neobox-e2e-"));
  const port = wantPort ?? (await freePort());
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
    ...extraEnv,
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
  return { base, port, output: () => output, stop };
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

/** POSTs an admin API action with the admin session. Returns the status and body text. */
export async function adminPost(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await adminCookie(base) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
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
   * (localStorage "neobox.name", only when unset). Native dialogs (alert, confirm, prompt) fail the scenario;
   * the app's own confirms are DOM dialogs and are driven like any other control.
   * Service workers are blocked: once the app's worker controls a page, Firefox and WebKit send even the requests it
   * passes through from the worker, where page and context routes cannot see them, so a scenario's route would hold
   * or miss by timing. The worker itself is covered by the QA instruments (qa/robust.mjs, qa/states.mjs).
   */
  async open(label, { phone = false, viewport, name, clipboard = false, ip: forcedIp } = {}) {
    // `ip` is the client address the browser sends as X-Forwarded-For (picks its GeoIP location).
    const ip = forcedIp ?? nextClientIp();
    const context = await this.env.browser.newContext({
      ...(phone ? phoneOptions(this.env.browser) : DESKTOP),
      ...(viewport && { viewport }),
      acceptDownloads: true,
      extraHTTPHeaders: { "X-Forwarded-For": ip },
      serviceWorkers: "block",
    });
    // The test-only X-Forwarded-For must not reach third-party origins: their CORS preflight rejects it, and the
    // embedded YouTube player then fails with an unhandled NetworkError (a pageerror). The server origin keeps it.
    await context.route("**/*", (route) => {
      const req = route.request();
      if (new URL(req.url()).origin === new URL(this.base).origin) return route.fallback();
      const h = { ...req.headers() };
      delete h["x-forwarded-for"];
      return route.continue({ headers: h });
    });
    // The jukebox loads YouTube's IFrame API. Its widget code posts messages from our page to a frame that is not
    // YouTube's, which the browser logs as console errors; only the API's UI-facing behavior matters to the suite,
    // so the API is served locally: a player that reports ready and ignores every call.
    await context.route("https://www.youtube.com/iframe_api", (route) =>
      route.fulfill({ contentType: "application/javascript", body: YOUTUBE_API_STUB }),
    );
    if (clipboard) {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: this.base });
      // A system share sheet would take the invite instead of the clipboard; the suite reads the clipboard.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
      });
    }
    if (name) {
      await context.addInitScript((value) => {
        // about:blank has an opaque origin: reading localStorage there throws; there is nothing to prefill.
        try {
          if (localStorage.getItem("neobox.name") === null) localStorage.setItem("neobox.name", value);
        } catch {
          // storage unavailable in this document
        }
      }, name);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT);
    const handle = { label, context, page, ip, problems: [], allowedDialogs: new Set(), reloading: false };
    page.on("pageerror", (err) => handle.problems.push(`${label}: page error: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // The font abort is the browser's own, not the page's: only that exact status is ignored.
      if (FONT_ABORT_RE.test(msg.text())) return;
      // A reload the scenario asked for closes the open socket mid-load; Firefox reports that close as a console error.
      if (handle.reloading && RELOAD_SOCKET_RE.test(msg.text())) return;
      const url = msg.location().url ?? "";
      if (YOUTUBE_COOKIE_RE.test(msg.text()) && YOUTUBE_ORIGIN_RE.test(url)) return;
      handle.problems.push(`${label}: console error: ${msg.text()}${url ? ` (${url})` : ""}`);
    });
    page.on("dialog", (dialog) => {
      if (!handle.allowedDialogs.has(dialog.type())) {
        handle.problems.push(`${label}: unexpected ${dialog.type()} dialog: ${dialog.message()}`);
      }
      void dialog.dismiss();
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
 * attempts per IP (5 a minute); startServer turns NEOBOX_TRUST_PROXY on, so the loopback peer's X-Forwarded-For is read.
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
export async function signedIn(s, label, name = uniqueName(label), opts = {}) {
  const h = await s.open(label, opts);
  await signUp(h, s.base, name);
  await h.page.goto(s.base);
  await menuName(h.page).waitFor();
  // the handle itself, not a copy: callers and listeners share it
  h.userName = name;
  return h;
}

let ipCounter = 0;
/** A fresh client address in `prefix` (see GEOIP_FIXTURE for the locations of 192.0.2, 198.51.100 and 203.0.113). */
export function ipIn(prefix) {
  ipCounter++;
  return `${prefix}.${ipCounter}`;
}

const CLUSTER_SECRET = "e2e-cluster-secret";
/** GeoIP fixture: 192.0.2.x is London, 198.51.100.x Frankfurt, 203.0.113.x New York. */
const GEOIP_FIXTURE = path.resolve(CLIENT_DIR, "..", "crates", "server", "tests", "data", "geo-test.mmdb");

function regionEnv(base, region, location) {
  return {
    NEOBOX_CLUSTER_SECRET: CLUSTER_SECRET,
    NEOBOX_REGION: region,
    NEOBOX_LOCATION: location,
    NEOBOX_PUBLIC_URL: base,
    NEOBOX_GEOIP: GEOIP_FIXTURE,
  };
}

/** A main server in Frankfurt with no game node: room locations come from the GeoIP fixture. */
export async function geoServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const main = await startServer({ port, extraEnv: regionEnv(base, "Frankfurt", "50.1109,8.6821") });
  return { base, nodeBase: null, output: main.output, stop: main.stop };
}

/** The main server in Frankfurt plus a game node in New York registered with it. */
export async function regionServers() {
  const mainPort = await freePort();
  const base = `http://127.0.0.1:${mainPort}`;
  const main = await startServer({ port: mainPort, extraEnv: regionEnv(base, "Frankfurt", "50.1109,8.6821") });
  const nodePort = await freePort();
  const nodeBase = `http://127.0.0.1:${nodePort}`;
  const node = await startServer({
    port: nodePort,
    extraEnv: { ...regionEnv(nodeBase, "New York", "40.7128,-74.0060"), NEOBOX_MAIN: base },
  });
  // The node registers through heartbeats (every 2 s); there is no public node list to poll.
  await sleep(2500);
  return {
    base,
    nodeBase,
    output: () => `main:\n${main.output()}\nnode:\n${node.output()}`,
    stop: async () => {
      await node.stop();
      await main.stop();
    },
  };
}

/**
 * The machine's LAN IPv4 address (127.0.0.1 without one). Firefox never pairs a loopback candidate: its host
 * candidates are mDNS names, and loopback peers are dropped even with media.peerconnection.ice.loopback.
 */
function lanAddress() {
  for (const infos of Object.values(os.networkInterfaces())) {
    const v4 = infos?.find((info) => info.family === "IPv4" && !info.internal);
    if (v4) return v4.address;
  }
  return "127.0.0.1";
}

/**
 * A UDP port on `host` that the OS lets the server bind. Windows reserves port ranges (`netsh int udp show excludedportrange`)
 * that a free-port probe over TCP never sees; the server then logs "WebRTC disabled" (os error 10013) and every match
 * stays on the WebSocket. So each candidate is bound here, the way the server will bind it, before it is handed out.
 */
async function freeUdpPort(host) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (await udpBindable(host, port)) return port;
  }
  throw new Error(`no bindable UDP port on ${host}`);
}

function udpBindable(host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", () => {
      sock.close();
      resolve(false);
    });
    sock.bind(port, host, () => sock.close(() => resolve(true)));
  });
}

/** A server with WebRTC on the LAN address (every other scenario runs on the WebSocket alone). */
export async function rtcServer() {
  const host = lanAddress();
  const rtc = `${host}:${await freeUdpPort(host)}`;
  const main = await startServer({ extraEnv: { NEOBOX_RTC_BIND: rtc, NEOBOX_RTC_PUBLIC: rtc } });
  return { base: main.base, nodeBase: null, output: main.output, stop: main.stop };
}

// ---------------------------------------------------------------- UI helpers

export const menuName = (page) => page.getByPlaceholder("name", { exact: true });

/**
 * Touch-only devices show the phone welcome once per device (client/src/ui/phone-splash.ts).
 * Dismisses it with Play when it appears; passes straight through when it does not (desktop,
 * or a device that already saw it). Checks it is shown at most once.
 */
export async function dismissPhoneSplash(page) {
  // the same test as phone-splash.ts: only touch-only devices ever show it
  const touchOnly = await page.evaluate(() => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);
  if (!touchOnly) return;
  const welcome = page.getByRole("dialog", { name: "Welcome", exact: true });
  await welcome.waitFor({ timeout: 2000 }).catch(() => undefined);
  const shown = await welcome.count();
  if (shown === 0) return;
  if (shown !== 1) throw new Error(`phone welcome shown ${shown} times on one page load`);
  await welcome.getByRole("button", { name: "Play", exact: true }).click();
  await welcome.waitFor({ state: "detached" });
}

export function button(scope, name) {
  return scope.getByRole("button", { name, exact: true });
}

/** Clicks a menu link (Library, Friends, Practice, Replay, Map editor, Settings, About). */
export async function navTo(page, label) {
  await button(page.getByRole("navigation", { name: "more", exact: true }), label).click();
}

/** Plays from the menu: fills the guest name when needed, then Quick play or Browse rooms. */
export async function playFromMenu(page, name, { quick = false } = {}) {
  const input = menuName(page);
  if (name && !(await input.getAttribute("readonly"))) await input.fill(name);
  await button(page, quick ? "Quick play" : "Browse rooms").click();
}

/** Creates a room from the menu. Returns its code. */
export async function createRoom(h, base, roomName, { isPublic } = {}) {
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await playFromMenu(page, null);
  await button(page, "New room").click();
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
  await page.getByRole("button", { name: "Change map", exact: true }).click();
  await page.locator(".room-map-list button").first().click();
  await mapName.filter({ hasText: /\S/ }).waitFor();
}

/**
 * Host starts the match; waits until every listed page shows the HUD. On a portrait phone the rotate gate hides the
 * HUD (hud.css `:has(> .hud-rotate:not([hidden]))`) until it is dismissed; `keepRotateGate` leaves the gate up, for
 * a state that is the gate itself.
 */
export async function startMatch(host, others = [], { keepRotateGate = false } = {}) {
  await ensureRoomMap(host.page);
  await button(host.page, "Start").click();
  for (const h of [host, ...others]) {
    const leave = h.page.locator(".hud-leave");
    await leave.waitFor({ state: "attached" });
    if (keepRotateGate) continue;
    await dismissRotateGate(h.page);
    await leave.waitFor({ state: "visible" });
  }
}

/** Portrait phone: dismisses the rotate gate with its own "Play in portrait anyway" control. No-op when no gate is up. */
export async function dismissRotateGate(page) {
  const gate = page.locator(".hud-rotate:not([hidden])");
  if ((await gate.count()) === 0) return;
  await gate.getByRole("button", { name: "Play in portrait anyway", exact: true }).click();
  await gate.waitFor({ state: "hidden" });
}

/**
 * A room with a host and a guest (via the host's invite link, read from the clipboard), in a running match.
 * `objectiveLimit` (optional) sets the host's `/set objectiveLimit` before Start, so a long match can outlast the default.
 */
export async function matchWithGuest(s, { clipboard: wantClipboard = true, keepRotateGate = false, objectiveLimit = null } = {}) {
  // Engines without clipboard permissions (Firefox, WebKit) take the invite link by navigating to it instead.
  const clipboard = wantClipboard && s.env.browser.clipboard;
  const hostName = uniqueName("host");
  const guestName = uniqueName("guest");
  const roomName = uniqueName("room");
  const host = await s.open("host", { name: hostName, clipboard });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  // on a phone the welcome sheet covers Start
  await dismissPhoneSplash(host.page);
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
  await dismissPhoneSplash(guest.page);
  await host.page.locator("li.room-player").filter({ hasText: guestName }).waitFor();
  if (objectiveLimit !== null) {
    const chat = host.page.getByLabel("Chat message", { exact: true });
    await chat.fill(`/set objectiveLimit ${objectiveLimit}`);
    await chat.press("Enter");
    await host.page.locator("div.room-chat-log").getByText(`objectiveLimit: ${objectiveLimit}`).waitFor();
  }
  await startMatch(host, [guest], { keepRotateGate });
  return { host, guest, code, roomName, hostName, guestName };
}

// ---------------------------------------------------------------- canvas probe

/**
 * Installs (once per page) a sampler of the match canvas (#gl-host canvas): it copies the
 * canvas into a small 2D canvas, hashes it and records the time of each change. Also records
 * the time of the last ArrowRight keydown.
 *
 * Sampling follows the draws, not requestAnimationFrame. Firefox clears a WebGL drawing buffer
 * once the frame is composited (preserveDrawingBuffer is off), so a copy taken in a rAF callback
 * that runs before the app's draw reads a blank canvas. Which of the two runs first depends on
 * the order in which the callbacks registered, and that changes from screen to screen. A
 * microtask queued by a draw runs as soon as the drawing callback returns, before compositing,
 * whatever that order is.
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
  const sample = () => {
    const src = document.querySelector("#gl-host canvas");
    if (!(src instanceof HTMLCanvasElement) || src.width === 0 || src.height === 0) return;
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
      const now = performance.now();
      probe.hash = hash;
      probe.changes.push(now);
      if (probe.changes.length > 5000) probe.changes.shift();
      probe.lastChange = now;
    }
  };
  let queued = false;
  const sampleAfterDraw = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sample();
    });
  };
  // Both renderers draw synchronously inside the frame callback: WebGL2 through drawArrays, WebGPU through queue.submit.
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
