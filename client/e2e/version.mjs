// Version skew: a server on one build refuses a client on another (its hello carries the client's build id), and a
// page still on the old build is told so and reloads itself once idle on the menu. A deploy is simulated by a copy of
// the dist client whose build id (build-id.txt and every place the client bakes it in) is changed, then a server
// restarted on the same port from that copy. Raw-socket cases assert the wire; the browser case asserts what the player
// sees and the reload.

import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST_DIR, button, distBuildId, matchWithGuest, menuName, navTo, sleep, startServer, uniqueName } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** The text a refused player reads: the same words the server's refusal carries (client/src/sw-update.ts). */
const NEW_VERSION = "A new version of neobox is out. Reload to play.";
/** The browser's wait for the refusal and the reload: the reconnect, then the client's 30 s loop guard, then its 2.5 s delay. */
const RELOAD_MS = 90_000;

/** Live servers of this run, by base URL: a deploy stops the one on a port and starts the new build on the same port. */
const servers = new Map();

/** Every file under `dir`. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/**
 * A client build as a later deploy would ship it: a copy of the dist client whose build id is changed everywhere it
 * appears (same length, so binary assets keep their layout). With no id in the dist, the copy only gets a build-id.txt.
 */
function deployCopy(current) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "neobox-deploy-"));
  cpSync(path.join(DIST_DIR, "client"), dir, { recursive: true });
  if (current === null) {
    writeFileSync(path.join(dir, "build-id.txt"), "e2e-next-build\n");
    return dir;
  }
  const next = (current[0] === "0" ? "1" : "0") + current.slice(1);
  for (const file of walk(dir)) {
    const bytes = readFileSync(file);
    if (bytes.includes(current)) {
      writeFileSync(file, Buffer.from(bytes.toString("latin1").split(current).join(next), "latin1"));
    }
  }
  return dir;
}

/** The first server of a scenario; `restart` (below) replaces it. */
async function versionTopology() {
  const first = await startServer();
  servers.set(first.base, first);
  return {
    base: first.base,
    nodeBase: null,
    output: () => servers.get(first.base).output(),
    stop: () => servers.get(first.base).stop(),
  };
}

/** Stops the scenario's server and starts `staticDir`'s build on the same port (a deploy). */
async function deploy(s, staticDir) {
  const port = Number(new URL(s.base).port);
  await servers.get(s.base).stop();
  const next = await startServer({ port, staticDir });
  servers.set(s.base, next);
}

/** A raw socket: records every JSON frame and the close. */
function socket(base) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
  const msgs = [];
  let resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  const opening = new Promise((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") msgs.push(JSON.parse(ev.data));
  };
  ws.onclose = (ev) => resolveClosed({ code: ev.code, reason: ev.reason });
  return {
    msgs,
    opening,
    closed,
    send: (obj) => ws.send(JSON.stringify(obj)),
    shut: () => ws.close(),
  };
}

/** Waits for the first frame of type `t` after `from`. */
async function frame(sock, t, from = 0, ms = 6_000) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = sock.msgs.slice(from).find((m) => m.t === t);
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`no "${t}" frame in ${ms} ms; got ${JSON.stringify(sock.msgs.slice(from))}`);
    await sleep(25);
  }
}

/** A client build the server does not run is refused with "outdated" and closed with the same reason; the right build plays. */
async function versionWire(s) {
  const current = distBuildId();
  const name = uniqueName("Ver");
  for (const build of [undefined, "e2e-stale-build"]) {
    const c = socket(s.base);
    check(await c.opening, "could not open the game socket");
    c.send({ t: "hello", version: 1, name, build });
    const e = await frame(c, "error");
    check(e.code === "outdated", `hello build ${build ?? "(none)"}: error code ${e.code} (want outdated)`);
    check(e.message === NEW_VERSION, `hello build ${build ?? "(none)"}: error text "${e.message}"`);
    const close = await Promise.race([c.closed, sleep(6_000).then(() => null)]);
    check(close?.reason === "outdated", `hello build ${build ?? "(none)"}: close ${JSON.stringify(close)} (want reason outdated)`);
    c.shut();
  }
  const ok = socket(s.base);
  check(await ok.opening, "could not open the game socket");
  ok.send({ t: "hello", version: 1, name, build: current });
  const w = await frame(ok, "welcome");
  check(w.t === "welcome", "the server's own build did not get a welcome");
  ok.shut();
  return current === null ? "no build id: hello accepted" : `build ${current}: refused others, welcomed itself`;
}

/**
 * A page on the old build, in the menu, when the server deploys a new build: the reconnect is refused, the prompt
 * shows, and the page reloads itself once idle on the menu, landing on the new client (no prompt after it).
 */
async function versionReload(s) {
  const { page } = await s.open("desktop", { serviceWorkers: "allow", route: false });
  await page.goto(s.base);
  await menuName(page).waitFor();
  // An update reaches only a page the worker controls: the first install must have claimed it before the deploy.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
  const reloaded = page.waitForEvent("load", { timeout: RELOAD_MS });
  await deploy(s, deployCopy(distBuildId()));
  const prompt = page.locator("#update-ready");
  await prompt.waitFor({ state: "visible", timeout: RELOAD_MS }).catch(() => {
    throw new Error("the old build was not told a new version is out (no prompt)");
  });
  const text = await prompt.textContent();
  check(text?.includes(NEW_VERSION), `prompt text "${text}" (want "${NEW_VERSION}")`);
  await reloaded.catch(() => {
    throw new Error("the page on the old build did not reload itself on the menu");
  });
  await menuName(page).waitFor();
  await sleep(3_000);
  check((await page.locator("#update-ready").count()) === 0, "the page on the new build shows the prompt again");
  return "prompt shown, page reloaded to the new build on the menu";
}

/**
 * A player in a match when the server deploys a new build: the match ends, the reconnect is refused, and the player
 * lands on the menu under the prompt, where the page reloads itself onto the new build.
 */
async function versionMatch(s) {
  const { host, guest } = await matchWithGuest(s);
  // The server stops mid-match: both sockets close, which Firefox and WebKit report as console errors.
  host.reloading = true;
  guest.reloading = true;
  const { page } = host;
  const reloaded = page.waitForEvent("load", { timeout: RELOAD_MS });
  await deploy(s, deployCopy(distBuildId()));
  const prompt = page.locator("#update-ready");
  await prompt.waitFor({ state: "visible", timeout: RELOAD_MS }).catch(() => {
    throw new Error("the player in the match was not told a new version is out (no prompt)");
  });
  const text = await prompt.textContent();
  check(text?.includes(NEW_VERSION), `prompt text "${text}" (want "${NEW_VERSION}")`);
  await reloaded.catch(() => {
    throw new Error("the match player did not reload onto the new build");
  });
  await menuName(page).waitFor();
  check((await page.locator(".hud-leave").count()) === 0, "the match is still on screen after the server restarted");
  await sleep(3_000);
  check((await page.locator("#update-ready").count()) === 0, "the page on the new build shows the prompt again");
  return "match ended, prompt shown, page reloaded to the new build on the menu";
}

/**
 * A player with unsaved work in the map editor when the server deploys a new build: the prompt shows, but the page
 * stays in the editor, does not reload, and keeps the work. The reload waits for the menu.
 */
async function versionEditor(s) {
  const { page } = await s.open("editor", { serviceWorkers: "allow", route: false });
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Map editor");
  const canvas = page.locator("canvas.editor-canvas");
  await canvas.waitFor({ state: "visible" });
  let box = await canvas.boundingBox();
  for (let settled = 0; settled < 3; ) {
    await sleep(100);
    const next = await canvas.boundingBox();
    settled = next && box && next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height ? settled + 1 : 0;
    box = next;
  }
  check(box && box.width > 100 && box.height > 100, "editor canvas has no size");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await button(page, "Box").click();
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 8 });
  await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
  await page.mouse.up();
  check(await button(page, "Undo").isEnabled(), "box drawn does not enable Undo");
  let reloads = 0;
  page.on("load", () => reloads++);
  await deploy(s, deployCopy(distBuildId()));
  const prompt = page.locator("#update-ready");
  await prompt.waitFor({ state: "visible", timeout: RELOAD_MS }).catch(() => {
    throw new Error("the editor was not told a new version is out (no prompt)");
  });
  const text = await prompt.textContent();
  check(text?.includes(NEW_VERSION), `prompt text "${text}" (want "${NEW_VERSION}")`);
  // Longer than the reload delay the menu would take: an editor that reloads would have done so by now.
  await sleep(6_000);
  check(reloads === 0, `the editor page reloaded ${reloads} time(s) under unsaved work`);
  check(await canvas.isVisible(), "the editor left the screen under unsaved work");
  check(await button(page, "Undo").isEnabled(), "the unsaved box is gone after the prompt");
  return "prompt shown; editor kept its unsaved box and did not reload";
}

export const versionScenarios = [
  { name: "version refused on the wire", run: versionWire },
  { name: "version prompt and reload", run: versionReload, topology: versionTopology },
  { name: "version mid-match restart", run: versionMatch, topology: versionTopology },
  { name: "version editor keeps unsaved work", run: versionEditor, topology: versionTopology },
];
