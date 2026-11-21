// Version skew: a server on one build refuses a client on another (its hello carries the client's build id), and a
// page still on the old build is told so and reloads itself once idle on the menu. A deploy is simulated by a copy of
// the dist client whose build id (build-id.txt and every place the client bakes it in) is changed, then a server
// restarted on the same port from that copy. Raw-socket cases assert the wire; the browser case asserts what the player
// sees and the reload.

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST_DIR, menuName, sleep, startServer, uniqueName } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** The text a refused player reads: the same words the server's refusal carries (client/src/sw-update.ts). */
const NEW_VERSION = "A new version of neobox is out. Reload to play.";
/** The browser's wait for the refusal and the reload: the reconnect, then the client's 30 s loop guard, then its 2.5 s delay. */
const RELOAD_MS = 90_000;

/** Live servers of this run, by base URL: a deploy stops the one on a port and starts the new build on the same port. */
const servers = new Map();

/** The build id of the dist client, or null for a build made before ids (dist-r48). */
function distBuildId() {
  const file = path.join(DIST_DIR, "client", "build-id.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

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
  const { page } = await s.open("desktop");
  await page.goto(s.base);
  await menuName(page).waitFor();
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

export const versionScenarios = [
  { name: "version refused on the wire", run: versionWire },
  { name: "version prompt and reload", run: versionReload, topology: versionTopology },
];
