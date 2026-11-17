// Netcode instrument (RUBRIC D22): two clients play one match through a delay proxy that sits
// outside the page. The browser connects to the proxy as to any server (HTTP and WebSocket), so
// the injected delay is the only delay on the path: no page-side routing and no CDP leg.
//
// Run from client/, one engine per process (browsers are heavy and share the host):
//   node qa/netgame.mjs <chromium|firefox|webkit>
// Env: QA_OUT (output dir, see lib-qa.mjs outDir), JN_CONDS (default rtt0,rtt100,impair;
// also jit, loss, lat), JN_DUR (play window ms, default 30000), JN_PROBE (optional page probe
// script (sets window.__jnProbe.summary()/reset(); the summary lands in res.probe), NEOBOX_DIST (client build).
// Chromium runs webgpu and webgl2; firefox and webkit run webgl2 (no WebGPU there).
//
// Proxy: HTTP passes through untouched. A WebSocket upgrade is then split into whole frames, and
// each direction is one FIFO released strictly in order, so a lost frame stalls every later one
// (head-of-line), as TCP does. A relay that let a later frame overtake an earlier one would model
// a transport that does not exist for this game, so there is no reorder mode.
// Delay per direction = rtt/2 + uniform(0, jitter); loss = a retransmit stall of rtt + 200 ms on
// that frame. Frames are released on a spin over performance.now(): a timer wakes SPIN_MS early and
// the rest is a setImmediate spin, so Node's coarse timers do not add to the delay.
//
// Metrics (RUBRIC D22):
//   net.desync.count        clients whose Snapshot row showed a desync reason ("gap a-b" or
//                           "hash t") during play. The reason is sticky per session, so each
//                           client counts at most once. Threshold 0.
//   net.rollback.depth.p95  last HUD "Rollback p95" sample (ticks), worst of the two clients.
//                           Threshold <= 8 at 100 ms RTT. Starved runs are flagged (res.starved).
//   net.impair.pass         1 on the impair condition (150 ms RTT, 50 ms jitter, 2% loss) when
//                           the match runs the full play window with no resync, no desync, both
//                           canvases still changing and the scoreboards agree. The match is set
//                           to NET_OBJECTIVE_LIMIT so it cannot end early. Threshold 1.
// Instrument (res.instrument, jitter- and loss-free cells): the game's own RTT (HUD "RTT", worst
// of the two clients' medians) must read the injected RTT, +0..8 ms. res.relay is the proxy's
// release lateness and one-way time, res.load the proxy's CPU and the machine's busy share over
// the play window.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  Scenario,
  ensureProbe,
  freePort,
  launchEngine,
  matchWithGuest,
  probeChanges,
  runCleanups,
  sleep,
  startServer,
  waitForPixels,
} from "../e2e/lib.mjs";
import { outDir } from "./lib-qa.mjs";

const ENGINES = ["chromium", "firefox", "webkit"];
const engine = process.argv[2];
if (!ENGINES.includes(engine)) {
  console.error(`usage: node qa/netgame.mjs <${ENGINES.join("|")}>`);
  process.exit(2);
}

const OUT = outDir();
const EVID = path.join(OUT, "evidence");
mkdirSync(EVID, { recursive: true });
const LOG = path.join(OUT, `netgame-${engine}.jsonl`);
const DUR = Number(process.env.JN_DUR ?? 30000);
const PROBE_JS = process.env.JN_PROBE ? path.resolve(process.env.JN_PROBE) : null;

// The page probe is optional (JN_PROBE): its summary() and reset() are read through window.__jnProbe.
const probeSummary = (page) => page.evaluate(() => window.__jnProbe?.summary?.() ?? null);
const STARVED_FPS = 20;
const STARVED_RTT_MS = 100;
const NET_OBJECTIVE_LIMIT = 99; // long enough that the match outlasts the play window
writeFileSync(LOG, "");
const rec = (r) => {
  appendFileSync(LOG, `${JSON.stringify(r)}\n`);
  console.log(JSON.stringify(r));
};

const CONDS = {
  rtt0: { id: "rtt0", rtt: 0, jitter: 0, loss: 0 },
  rtt100: { id: "rtt100", rtt: 100, jitter: 0, loss: 0 },
  impair: { id: "impair", rtt: 150, jitter: 50, loss: 0.02 },
  jit: { id: "jit", rtt: 150, jitter: 50, loss: 0 },
  loss: { id: "loss", rtt: 150, jitter: 0, loss: 0.02 },
  lat: { id: "lat", rtt: 150, jitter: 0, loss: 0 },
};

// A frame is released this many ms early by a timer, then spun on setImmediate up to its due time.
const SPIN_MS = 20;
const HEAD_MAX = 16384;

/** Length of the first complete WebSocket frame in `b`, or 0 while it is incomplete. */
function frameLength(b) {
  if (b.length < 2) return 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return 0;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return 0;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  if (b[1] & 0x80) off += 4;
  return b.length >= off + len ? off + len : 0;
}

/** Splits a byte stream into whole WebSocket frames. Headers and masks stay as sent. */
function frameSplitter() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    for (let n = frameLength(buf); n > 0; n = frameLength(buf)) {
      out.push(buf.subarray(0, n));
      buf = buf.subarray(n);
    }
    return out;
  };
}

/** Payload of one whole frame, unmasked (a copy when masked). */
function payloadOf(f) {
  let len = f[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    len = f.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    len = Number(f.readBigUInt64BE(2));
    off = 10;
  }
  if (!(f[1] & 0x80)) return f.subarray(off, off + len);
  const key = f.subarray(off, off + 4);
  off += 4;
  const out = Buffer.from(f.subarray(off, off + len));
  for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
  return out;
}

/**
 * One direction of one connection: frames leave in order, each at its due time (never before
 * the frame ahead of it). `hops` collects [lateness, one-way] per released frame.
 */
function lane(sink, hops) {
  const q = [];
  let timer = null;
  let last = 0;
  let stopped = false;
  const pump = () => {
    timer = null;
    if (stopped) return;
    while (q.length && q[0].at <= performance.now()) {
      const it = q.shift();
      const now = performance.now();
      hops.push([now - it.at, now - it.enq]);
      it.fn();
    }
    if (!q.length) return;
    const wait = q[0].at - performance.now();
    timer = wait > SPIN_MS ? setTimeout(pump, wait - SPIN_MS) : setImmediate(pump);
  };
  return {
    send(fn, delay) {
      if (stopped) return;
      const now = performance.now();
      const at = Math.max(now + delay, last);
      last = at;
      q.push({ at, fn, enq: now });
      if (!timer) pump();
    },
    stop() {
      stopped = true;
      q.length = 0;
    },
    sink,
  };
}

/**
 * The delay proxy (RUBRIC D22). Listens on its own port and forwards to the server. Each accepted
 * connection is an HTTP exchange until a WebSocket upgrade: from then on every frame is delayed per
 * direction by `cond`. Returns { base, counts, hops, stop }. `counts` totals resync requests (text
 * frames carrying "t":"resync") and checksum frames (binary 0x83) over all clients.
 */
async function startDelayProxy(cond, serverPort) {
  const port = await freePort();
  const counts = { resync: 0, checksum: 0 };
  const hops = { up: [], down: [] };
  const sockets = new Set();
  const delayFor = () => {
    let d = cond.rtt / 2 + Math.random() * cond.jitter;
    if (Math.random() < cond.loss) d += cond.rtt + 200;
    return d;
  };
  const srv = net.createServer({ allowHalfOpen: true }, (client) => {
    const up = net.connect({ host: "127.0.0.1", port: serverPort, allowHalfOpen: true });
    client.setNoDelay(true);
    up.setNoDelay(true);
    sockets.add(client);
    sockets.add(up);
    const upLane = lane((b) => !up.destroyed && up.write(b), hops.up);
    const downLane = lane((b) => !client.destroyed && client.write(b), hops.down);
    const kill = () => {
      upLane.stop();
      downLane.stop();
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };

    let upState = "head"; // head -> frames | pipe
    let upHead = Buffer.alloc(0);
    const upSplit = frameSplitter();
    const onUp = (chunk) => {
      if (upState === "head") {
        upHead = Buffer.concat([upHead, chunk]);
        const end = upHead.indexOf("\r\n\r\n");
        if (end < 0) {
          if (upHead.length > HEAD_MAX) kill();
          return;
        }
        const head = upHead.subarray(0, end + 4);
        const rest = upHead.subarray(end + 4);
        upHead = null;
        upState = /^upgrade:\s*websocket\b/im.test(head.toString("latin1")) ? "frames" : "pipe";
        up.write(head);
        if (rest.length) onUp(rest);
        return;
      }
      if (upState === "pipe") {
        up.write(chunk);
        return;
      }
      for (const f of upSplit(chunk)) {
        if ((f[0] & 0x0f) === 1 && payloadOf(f).toString("utf8").includes('"t":"resync"')) counts.resync++;
        upLane.send(() => up.write(f), delayFor());
      }
    };

    let downState = "head"; // head -> frames | pipe
    let downHead = Buffer.alloc(0);
    const downSplit = frameSplitter();
    const onDown = (chunk) => {
      if (downState === "head") {
        downHead = Buffer.concat([downHead, chunk]);
        const end = downHead.indexOf("\r\n\r\n");
        if (end < 0) {
          if (downHead.length > HEAD_MAX) kill();
          return;
        }
        const head = downHead.subarray(0, end + 4);
        const rest = downHead.subarray(end + 4);
        downHead = null;
        downState = /^HTTP\/1\.1 101/.test(head.toString("latin1", 0, 12)) ? "frames" : "pipe";
        client.write(head);
        if (rest.length) onDown(rest);
        return;
      }
      if (downState === "pipe") {
        client.write(chunk);
        return;
      }
      for (const f of downSplit(chunk)) {
        if ((f[0] & 0x0f) === 2 && payloadOf(f)[0] === 0x83) counts.checksum++;
        downLane.send(() => client.write(f), delayFor());
      }
    };

    client.on("data", onUp);
    up.on("data", onDown);
    // A FIN follows the frames still queued ahead of it.
    client.on("end", () => upLane.send(() => up.end(), 0));
    up.on("end", () => downLane.send(() => client.end(), 0));
    client.on("error", kill);
    up.on("error", kill);
    client.on("close", kill);
    up.on("close", kill);
  });
  srv.listen(port, "127.0.0.1");
  await once(srv, "listening");
  return {
    base: `http://127.0.0.1:${port}`,
    counts,
    hops,
    stop: async () => {
      srv.close();
      for (const s of sockets) s.destroy();
    },
  };
}

// CPU over a window: this process (the proxy, in ms of CPU) and the whole machine (browsers included).
function cpuSnap() {
  const t = os.cpus().reduce((a, c) => {
    for (const k of Object.keys(c.times)) a[k] = (a[k] ?? 0) + c.times[k];
    return a;
  }, {});
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  const u = process.cpuUsage();
  return { wall: performance.now(), proc: (u.user + u.system) / 1000, idle: t.idle, total };
}

function loadBetween(a, b) {
  const wall = b.wall - a.wall;
  const busy = 1 - (b.idle - a.idle) / (b.total - a.total);
  return {
    proxyCpuPct: +(((b.proc - a.proc) / wall) * 100).toFixed(1),
    systemBusyPct: +(busy * 100).toFixed(1),
  };
}

// The page probe is a diagnostic only: its own timing is recorded, not used for the verdict.
const STAT_JS = () =>
  Object.fromEntries(
    [...document.querySelectorAll(".hud-stat-row")].map((r) => [
      r.querySelector(".hud-stat-label")?.textContent ?? "",
      r.querySelector(".hud-stat-value")?.textContent ?? "",
    ]),
  );

const BOARD_JS = () =>
  [...document.querySelectorAll(".hud-scores tbody tr")]
    .map((r) => [r.cells[0], r.cells[2], r.cells[3], r.cells[4]].map((c) => c.textContent.trim()).join("|"))
    .sort();

async function board(page) {
  await page.keyboard.down("Tab");
  try {
    return await page.evaluate(BOARD_JS);
  } finally {
    await page.keyboard.up("Tab");
  }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function statNum(rows, label) {
  const v = rows?.[label];
  if (v === undefined) return null;
  const m = /-?\d+(\.\d+)?/.exec(v);
  return m ? Number(m[0]) : null;
}

// Snapshot row: "none" when in sync, else "gap a-b" or "hash t" (game.ts desync reason).
const isDesync = (v) => typeof v === "string" && /^(gap|hash)\b/.test(v);

function setupScenario(browser, env, name, renderer) {
  const s = new Scenario(name, { browser, base: env.base, output: env.output });
  const openOrig = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOrig(label, opts);
    if (PROBE_JS) await h.context.addInitScript({ path: PROBE_JS });
    if (renderer === "webgl2") {
      await h.context.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      });
    }
    return h;
  };
  return s;
}

// Both players hold opposite directions (flipping every 4 s), the guest bats, the host
// rockets, jumps and grabs. Samples the HUD stat rows every 500 ms.
async function play(host, guest, dur) {
  const samples = { host: [], guest: [] };
  const dirs = { host: "ArrowRight", guest: "ArrowLeft" };
  await host.page.keyboard.down(dirs.host);
  await guest.page.keyboard.down(dirs.guest);
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < dur) {
    await sleep(500);
    i++;
    if (i % 8 === 0) {
      for (const k of ["host", "guest"]) {
        const page = k === "host" ? host.page : guest.page;
        const cur = dirs[k];
        const next = cur === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
        await page.keyboard.up(cur);
        await page.keyboard.down(next);
        dirs[k] = next;
      }
    }
    if (i % 2 === 0) await guest.page.keyboard.press("KeyC");
    if (i % 3 === 0) await host.page.keyboard.press("Space");
    if (i % 5 === 0) await host.page.keyboard.press("KeyZ");
    if (i % 7 === 0) await guest.page.keyboard.press("KeyV");
    for (const k of ["host", "guest"]) {
      const page = k === "host" ? host.page : guest.page;
      const st = await page.evaluate(STAT_JS).catch(() => ({}));
      samples[k].push({ t: Date.now() - start, ...st });
    }
  }
  await host.page.keyboard.up(dirs.host);
  await guest.page.keyboard.up(dirs.guest);
  samples.elapsedMs = Date.now() - start;
  return samples;
}

async function netRun(browser, renderer, cond) {
  const tag = `${engine}-${renderer}-${cond.id}`;
  const server = await startServer();
  const proxy = await startDelayProxy(cond, server.port);
  const s = setupScenario(browser, { base: proxy.base, output: server.output }, `net-${tag}`, renderer);
  const res = { mode: "net", engine, renderer, cond: cond.id, rtt: cond.rtt, jitter: cond.jitter, loss: cond.loss };
  try {
    const { host, guest, code } = await matchWithGuest(s, { clipboard: false, objectiveLimit: NET_OBJECTIVE_LIMIT });
    res.code = code;
    await ensureProbe(host.page);
    await ensureProbe(guest.page);
    await waitForPixels(host, "host canvas");
    await waitForPixels(guest, "guest canvas");
    await sleep(4000);
    await host.page.keyboard.press("F3");
    await guest.page.keyboard.press("F3");
    await sleep(500);
    const c0 = { resync: proxy.counts.resync, checksum: proxy.counts.checksum };
    if (PROBE_JS) await Promise.all([host.page, guest.page].map((p) => p.evaluate(() => window.__jnProbe?.reset?.())));
    const p0 = { host: await probeChanges(host.page), guest: await probeChanges(guest.page) };
    for (const k of ["up", "down"]) proxy.hops[k].length = 0;
    const cpu0 = cpuSnap();
    const samples = await play(host, guest, DUR);
    const cpu1 = cpuSnap();
    const p1 = { host: await probeChanges(host.page), guest: await probeChanges(guest.page) };
    res.load = loadBetween(cpu0, cpu1);
    const sum = (xs) => ({
      n: xs.length,
      late50: pct(xs.map((x) => x[0]), 50),
      late95: pct(xs.map((x) => x[0]), 95),
      late99: pct(xs.map((x) => x[0]), 99),
      oneWay50: pct(xs.map((x) => x[1]), 50),
      oneWay95: pct(xs.map((x) => x[1]), 95),
    });
    res.relay = { up: sum(proxy.hops.up), down: sum(proxy.hops.down) };
    if (PROBE_JS) res.probe = { host: await probeSummary(host.page), guest: await probeSummary(guest.page) };
    await sleep(2000);
    const hb = await board(host.page);
    const gb = await board(guest.page);
    const logLines = server.output().split("\n").filter((l) => l.includes(`room=${code}`));

    const desyncReasons = {
      host: [...new Set(samples.host.map((x) => x.Snapshot).filter(isDesync))],
      guest: [...new Set(samples.guest.map((x) => x.Snapshot).filter(isDesync))],
    };
    // The HUD row is a rolling p95 in ticks, so the last sample that has it is the settled
    // value at the end of play. A sample after the match ends has no rows, so filter first.
    // The maximum over the samples is a diagnostic only: a transient spike during clock
    // convergence should not decide the verdict.
    const p95Series = (rows) => rows.map((x) => statNum(x, "Rollback p95")).filter((x) => x !== null);
    const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null);
    const rollbackP95 = {
      host: lastOf(p95Series(samples.host)),
      guest: lastOf(p95Series(samples.guest)),
      hostMax: pct(p95Series(samples.host), 100),
      guestMax: pct(p95Series(samples.guest), 100),
      statSamples: { host: samples.host.filter((x) => "Rollback p95" in x).length, total: samples.host.length },
    };
    const fpsMedian = (rows) => pct(rows.map((x) => statNum(x, "FPS")).filter((x) => x !== null), 50);
    const fps = { host: fpsMedian(samples.host), guest: fpsMedian(samples.guest) };
    const pred = samples.host.map((x) => statNum(x, "Prediction")).filter((x) => x !== null);
    const rb = samples.host.map((x) => statNum(x, "Rollbacks")).filter((x) => x !== null);
    const rtt = samples.guest.map((x) => statNum(x, "RTT")).filter((x) => x !== null);
    const hostRtt = samples.host.map((x) => statNum(x, "RTT")).filter((x) => x !== null);

    res.resyncs = proxy.counts.resync - c0.resync;
    res.checksumFrames = proxy.counts.checksum - c0.checksum;
    res.serverLogResyncLines = logLines.filter((l) => /resync requested|too far behind/.test(l)).length;
    res.canvasChanges = { host: p1.host - p0.host, guest: p1.guest - p0.guest };
    res.boardHost = hb;
    res.boardGuest = gb;
    res.boardAgree = JSON.stringify(hb) === JSON.stringify(gb);
    res.rttMs = { guestMedian: pct(rtt, 50), hostMedian: pct(hostRtt, 50), n: rtt.length };
    // Instrument check: on a loss- and jitter-free cell the game's RTT must read the injected RTT (+0..8 ms).
    const rttMed = Math.max(res.rttMs.hostMedian ?? 0, res.rttMs.guestMedian ?? 0);
    const lossless = cond.jitter === 0 && cond.loss === 0;
    res.instrument = {
      injectedRttMs: cond.rtt,
      measuredRttMs: rttMed,
      ok: lossless ? rttMed >= cond.rtt && rttMed <= cond.rtt + 8 : null,
    };
    res.predDepthTicks = { hostP95: pct(pred, 95), hostMax: pct(pred, 100) };
    res.rollbacksPerSec = { hostP95: pct(rb, 95), hostMax: pct(rb, 100) };
    res.desyncReasons = desyncReasons;
    res.rollbackP95 = rollbackP95;
    res.fps = fps;
    // Starved: the host is too busy to measure (FPS under 20 or no FPS row), or, when the relay
    // adds no jitter or loss, the measured RTT is far above the injected one (the proxy's timers
    // slipped under load). Under jitter or loss the measured RTT follows the relay's own model,
    // so only FPS counts there. Such a run says nothing about the netcode at that RTT.
    const rttSlip = lossless && rttMed > cond.rtt + STARVED_RTT_MS;
    res.starved =
      fps.host === null || fps.guest === null || fps.host < STARVED_FPS || fps.guest < STARVED_FPS || rttSlip;
    res.lastStats = { host: samples.host.at(-1), guest: samples.guest.at(-1) };
    writeFileSync(path.join(EVID, `netgame-${tag}-samples.json`), JSON.stringify(samples));

    const shot = (h, f) => h.page.screenshot({ path: path.join(EVID, `netgame-${tag}-${f}.png`) }).catch(() => {});
    await shot(host, "host");
    await shot(guest, "guest");

    const desyncCount = Number(desyncReasons.host.length > 0) + Number(desyncReasons.guest.length > 0);
    // The match ran the whole play window: the loop ran at least DUR, and each client's last sample
    // still carries HUD rows (the rows are gone once the match ends).
    const fullWindow =
      samples.elapsedMs >= DUR &&
      ["host", "guest"].every((k) => statNum(samples[k].at(-1) ?? {}, "Rollback p95") !== null);
    res.fullWindow = fullWindow;
    res.pass =
      res.resyncs === 0 &&
      res.serverLogResyncLines === 0 &&
      desyncCount === 0 &&
      res.boardAgree &&
      res.canvasChanges.host > 20 &&
      res.canvasChanges.guest > 20 &&
      fullWindow;
    res.metrics = {
      "net.desync.count": desyncCount,
      "net.rollback.depth.p95": Math.max(rollbackP95.host ?? 0, rollbackP95.guest ?? 0),
      "net.impair.pass": cond.id === "impair" ? Number(res.pass) : null,
    };
    res.problems = s.problems();
  } catch (err) {
    res.error = String(err?.message ?? err).slice(0, 800);
    res.problems = s.problems();
    res.pass = false;
  } finally {
    await s.close();
    await proxy.stop();
    await server.stop();
  }
  rec(res);
  return res;
}

const browser = await launchEngine(engine);
try {
  const renderers = engine === "chromium" ? ["webgpu", "webgl2"] : ["webgl2"];
  const conds = (process.env.JN_CONDS ?? "rtt0,rtt100,impair").split(",").map((k) => {
    const c = CONDS[k];
    if (!c) throw new Error(`unknown condition ${k}`);
    return c;
  });
  for (const renderer of renderers) for (const cond of conds) await netRun(browser, renderer, cond);
} finally {
  await runCleanups();
}
