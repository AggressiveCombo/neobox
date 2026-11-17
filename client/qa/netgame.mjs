// Netcode instrument (RUBRIC D22): two clients play one match while a relay on the
// WebSocket path delays, jitters and loses messages. Reports desync, rollback depth and
// whether the match survives impairment.
//
// Run from client/, one engine per process (browsers are heavy and share the host):
//   node qa/netgame.mjs <chromium|firefox|webkit>
// Env: QA_OUT (output dir, see lib-qa.mjs outDir), JN_CONDS (default rtt0,rtt100,impair;
// also jit, loss, lat), JN_DUR (play window ms, default 30000), NEOBOX_DIST (client build).
// Chromium runs webgpu and webgl2; firefox and webkit run webgl2 (no WebGPU there).
//
// Relay is FIFO only. A WebSocket is an ordered TCP stream: one queue per direction,
// released strictly in order, so a lost message stalls every later one (head-of-line),
// as TCP does. A relay that let a later message overtake an earlier one would model a
// transport that does not exist for this game, so there is no reorder mode.
//
// Metrics (RUBRIC D22):
//   net.desync.count        clients whose Snapshot row showed a desync reason ("gap a-b" or
//                           "hash t") during play. The reason is sticky per session, so each
//                           client counts at most once. Threshold 0.
//   net.rollback.depth.p95  max over the clients and samples of the HUD "Rollback p95" row (ticks).
//                           Threshold <= 8 at 100 ms RTT.
//   net.impair.pass         1 on the impair condition (150 ms RTT, 50 ms jitter, 2% loss) when
//                           the match completes with no resync, no desync, both canvases
//                           still changing and the scoreboards agree. Threshold 1.
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Scenario,
  ensureProbe,
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
const LOG = path.join(OUT, `netgame-${engine}.jsonl`);
const DUR = Number(process.env.JN_DUR ?? 30000);
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

// Latency = rtt/2 each way; jitter = uniform [0, jitter) per message; loss = a per-message
// retransmit stall (rtt + 200 ms) with probability `loss`. Counts client resync requests and
// server checksum frames (0x83) on the way through.
function relay(cond, c) {
  return (ws) => {
    const server = ws.connectToServer();
    const dirs = { up: { items: [], timer: null, last: 0 }, down: { items: [], timer: null, last: 0 } };
    const pump = (dir) => {
      const q = dirs[dir];
      while (q.items.length && q.items[0].at <= Date.now()) q.items.shift().fn();
      if (q.items.length && !q.timer) {
        q.timer = setTimeout(() => {
          q.timer = null;
          pump(dir);
        }, Math.max(0, q.items[0].at - Date.now()));
      }
    };
    const delayFor = () => {
      let d = cond.rtt / 2 + Math.random() * cond.jitter;
      if (Math.random() < cond.loss) d += cond.rtt + 200;
      return d;
    };
    const sched = (dir, fn) => {
      const q = dirs[dir];
      // never earlier than the message ahead of it: the queue stays in send order
      const at = Math.max(Date.now() + delayFor(), q.last);
      q.last = at;
      q.items.push({ at, fn });
      pump(dir);
    };
    ws.onMessage((msg) => {
      if (typeof msg === "string" && msg.includes('"t":"resync"')) c.resync++;
      c.up++;
      sched("up", () => {
        try {
          server.send(msg);
        } catch {}
      });
    });
    server.onMessage((msg) => {
      c.down++;
      if (typeof msg !== "string" && msg.length > 0 && msg[0] === 0x83) c.checksum++;
      sched("down", () => {
        try {
          ws.send(msg);
        } catch {}
      });
    });
  };
}

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

function setupScenario(browser, server, name, renderer, cond) {
  const s = new Scenario(name, { browser, base: server.base, output: server.output });
  const openOrig = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOrig(label, opts);
    if (renderer === "webgl2") {
      await h.context.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      });
    }
    h.c = { resync: 0, checksum: 0, up: 0, down: 0 };
    await h.page.routeWebSocket(/.*/, relay(cond, h.c));
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
  return samples;
}

async function netRun(browser, renderer, cond) {
  const tag = `${engine}-${renderer}-${cond.id}`;
  const server = await startServer();
  const s = setupScenario(browser, server, `net-${tag}`, renderer, cond);
  const res = { mode: "net", engine, renderer, cond: cond.id, rtt: cond.rtt, jitter: cond.jitter, loss: cond.loss };
  try {
    const { host, guest, code } = await matchWithGuest(s, { clipboard: false });
    res.code = code;
    await ensureProbe(host.page);
    await ensureProbe(guest.page);
    await waitForPixels(host, "host canvas");
    await waitForPixels(guest, "guest canvas");
    await sleep(4000);
    await host.page.keyboard.press("F3");
    await guest.page.keyboard.press("F3");
    await sleep(500);
    const c0 = { host: { ...host.c }, guest: { ...guest.c } };
    const p0 = { host: await probeChanges(host.page), guest: await probeChanges(guest.page) };
    const samples = await play(host, guest, DUR);
    const p1 = { host: await probeChanges(host.page), guest: await probeChanges(guest.page) };
    await sleep(2000);
    const hb = await board(host.page);
    const gb = await board(guest.page);
    const logLines = server.output().split("\n").filter((l) => l.includes(`room=${code}`));

    const desyncReasons = {
      host: [...new Set(samples.host.map((x) => x.Snapshot).filter(isDesync))],
      guest: [...new Set(samples.guest.map((x) => x.Snapshot).filter(isDesync))],
    };
    // The HUD row is a rolling p95 in ticks. A sample after the match ends has no rows, so
    // take the maximum over the samples that have it: the worst the session showed.
    const p95Series = (rows) => rows.map((x) => statNum(x, "Rollback p95")).filter((x) => x !== null);
    const rollbackP95 = {
      host: pct(p95Series(samples.host), 100),
      guest: pct(p95Series(samples.guest), 100),
      hostMedian: pct(p95Series(samples.host), 50),
      guestMedian: pct(p95Series(samples.guest), 50),
      statSamples: { host: samples.host.filter((x) => "Rollback p95" in x).length, total: samples.host.length },
    };
    const pred = samples.host.map((x) => statNum(x, "Prediction")).filter((x) => x !== null);
    const rb = samples.host.map((x) => statNum(x, "Rollbacks")).filter((x) => x !== null);
    const rtt = samples.guest.map((x) => statNum(x, "RTT")).filter((x) => x !== null);
    const hostRtt = samples.host.map((x) => statNum(x, "RTT")).filter((x) => x !== null);

    res.resyncs = { host: host.c.resync - c0.host.resync, guest: guest.c.resync - c0.guest.resync };
    res.checksumFrames = { host: host.c.checksum - c0.host.checksum, guest: guest.c.checksum - c0.guest.checksum };
    res.serverLogResyncLines = logLines.filter((l) => /resync requested|too far behind/.test(l)).length;
    res.canvasChanges = { host: p1.host - p0.host, guest: p1.guest - p0.guest };
    res.boardHost = hb;
    res.boardGuest = gb;
    res.boardAgree = JSON.stringify(hb) === JSON.stringify(gb);
    res.rttMs = { guestMedian: pct(rtt, 50), hostMedian: pct(hostRtt, 50), n: rtt.length };
    res.predDepthTicks = { hostP95: pct(pred, 95), hostMax: pct(pred, 100) };
    res.rollbacksPerSec = { hostP95: pct(rb, 95), hostMax: pct(rb, 100) };
    res.desyncReasons = desyncReasons;
    res.rollbackP95 = rollbackP95;
    res.lastStats = { host: samples.host.at(-1), guest: samples.guest.at(-1) };

    const shot = (h, f) => h.page.screenshot({ path: path.join(EVID, `netgame-${tag}-${f}.png`) }).catch(() => {});
    await shot(host, "host");
    await shot(guest, "guest");

    const desyncCount = Number(desyncReasons.host.length > 0) + Number(desyncReasons.guest.length > 0);
    res.pass =
      res.resyncs.host === 0 &&
      res.resyncs.guest === 0 &&
      res.serverLogResyncLines === 0 &&
      desyncCount === 0 &&
      res.boardAgree &&
      res.canvasChanges.host > 20 &&
      res.canvasChanges.guest > 20;
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
