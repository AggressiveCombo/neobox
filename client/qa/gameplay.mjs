// Gameplay instrument (RUBRIC D23): hit registration and replay fidelity on the built client.
//
// Both cases play on a QA fixture map (FIXTURE_MAP, pasted as map JSON like e2e's voidMap): one flat platform
// 12 units wide with two spawns 2 units apart on it and nothing else, so the arena below the platform is a pit.
// A bat hit pushes a player off the platform; a player who falls out of the arena dies, and the player who hit
// them last gets the KO (sim player.rs post_step: attacker_timer credit). Nothing here depends on random walking.
//
// Metrics:
// - gameplay.hitbox.agree (per cell, 1 = pass): two clients and the server. The swings are tick-timed: HITBOX_SWINGS
//   rounds, one swing per round, alternating swingers. Round i presses KeyC at engine tick base + i * ROUND_TICKS
//   (read from the swinger's own client) and holds it HOLD_TICKS ticks, so each round lands one hit and the
//   press stagger between clients cannot change the count (crates/net/tests/bat_rounds.rs checks the schedule).
//   Pass: no resync on either client; the hit log (.hud-events li.hud-event-hit) and the KO log (li.hud-event-ko),
//   as data-tick|text, are equal on both clients and equal to the server's own record of the match (NEOBOX_QA_EVENTS,
//   crates/server/src/qa_events.rs); the hit count is HITBOX_SWINGS; the scoreboards agree; at least 5 checksum
//   frames arrived. Hits are often one-way (sim rule, crates/net/tests/bat_hits.rs); the direction is reported.
// - replay.fidelity (per match, 1 = pass): the match is recorded with objectiveLimit 2 (kills mode: it ends at
//   the second KO), both players keep swinging until "Back to room" (or PLAY_MS, then End match). The replay is
//   played to the end without seeking. Pass: its KO order (.hud-events li " KO ") equals the server's KO order,
//   its scoreboard kills equal the server's final kills per player, the replay board equals the live board, the
//   live host and guest agree, and at least one KO happened. Per cell, `replay.<renderer>.summary` reports
//   replay.fidelity = 1 only when every match passed.
// - replay.log.match (per match, reported): the full ordered event log (kills and hits) equals live.
//
// Cells (RUBRIC D23): chromium webgpu and webgl2, firefox webgl2, webkit webgl2. QA_ENGINES and
// QA_RENDERERS (comma lists) narrow them. QA_REPLAY_MATCHES (default 3), QA_REPLAY_MS (default 60000).
//
// Run: cd client && NEOBOX_DIST=<build dir> QA_OUT=<dir> bun qa/gameplay.mjs
// Self-tests (QA_SELF_TEST; only that case runs and it must FAIL):
// - hitbox: the bat key is pressed for 0 ms, so the bat never fires.
// - replay: one fake KO line is added to the replay's scoreboard log before it is read.
// Output: <QA_OUT>/gameplay-<engine>.{json,md}; evidence under <QA_OUT>/evidence/gameplay-<engine>/.

import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import {
  Results,
  button,
  createRoom,
  dismissPhoneSplash,
  ensureProbe,
  joinByInvite,
  launchEngine,
  menuName,
  navTo,
  probeChanges,
  roomTitle,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startMatch,
  startServer,
  uniqueName,
  waitForPixels,
  writeIndex,
} from "./lib-qa.mjs";

const SELF = selfTestMode();
const HITBOX_SWINGS = 10; // hitbox: rounds, one swing each; every round lands one hit
const ROUND_TICKS = 120; // hitbox: engine ticks from one round's press to the next (bat_rounds.rs: 100..=150 pass)
const FIRST_SWING_TICKS = 60; // hitbox: the first press, engine ticks after the read (spawn grace is past by then)
const HOLD_TICKS = 18; // hitbox: KeyC held this many engine ticks; the bat fires 13 ticks after the press (sim bat_fire_on)
const SWING_HOLD_MS = 600; // replay: KeyC held this long: the bat fires at tick 13 (sim settings bat_fire_on)
const SWING_GAP_MS = 1500; // replay: after release: the bat cycle resets at tick 35 (settings bat_reset_on)
const KO_LIMIT = 2; // replay: kills mode ends the match at this many KOs
const MATCHES = Number(process.env.QA_REPLAY_MATCHES ?? 3);
const PLAY_MS = Number(process.env.QA_REPLAY_MS ?? 60000);

/**
 * RUBRIC D23 fixture map: a platform (body centre (20, 21), half-height 0.5, so its top is y 20.5, x 14..26) and
 * two spawns at x 19 and 21 on it. Nothing else: the arena is 40 x 25 and the space below the platform is a pit.
 */
const FIXTURE_MAP = JSON.stringify({
  b: [{ 1: 0, 2: 20, 3: 21, s: [{ 7: 3754574, p: [-6, -0.5, 6, -0.5, 6, 0.5, -6, 0.5] }] }],
  j: [],
  s: [
    { 1: 19, 2: 19.5 },
    { 1: 21, 2: 19.5 },
  ],
  p: [],
  tu: [],
  tc: [],
  gp: [],
  c: [],
  set: { 3: 40, 15: 40, 16: 25 },
});

/** RUBRIC D23 cells. */
const CELLS = [
  { engine: "chromium", renderer: "webgpu" },
  { engine: "chromium", renderer: "webgl2" },
  { engine: "firefox", renderer: "webgl2" },
  { engine: "webkit", renderer: "webgl2" },
];
const RENDERERS = process.env.QA_RENDERERS?.split(",").map((s) => s.trim());
const ONLY = process.env.QA_ONLY ?? null; // "hitbox" or "replay": runs one case type

/** Scoreboard rows as text: name|team|kills|wins|lives (status omitted: it counts down). */
const BOARD_JS = (scope) =>
  [...document.querySelectorAll(`${scope} .hud-scores tbody tr`)]
    .map((r) => [0, 1, 2, 3, 4].map((i) => r.cells[i]?.textContent.trim() ?? "").join("|"))
    .sort();
/** The ordered event log as the HUD prints it. */
const EVENTS_JS = (scope) => [...document.querySelectorAll(`${scope} .hud-events li`)].map((li) => li.textContent.trim());
/** Bat hits as tick|text, sorted: the same hit must carry the same tick and text on both clients. */
const HITS_JS = () =>
  [...document.querySelectorAll(".hud-events li.hud-event-hit")]
    .map((li) => `${li.dataset.tick}|${li.textContent.trim()}`)
    .sort();

/** KO log as tick|text, sorted: the server's record of the match is compared to this. */
const KOS_JS = () =>
  [...document.querySelectorAll(".hud-events li.hud-event-ko")]
    .map((li) => `${li.dataset.tick}|${li.textContent.trim()}`)
    .sort();

const RENDERER_JS = () => document.documentElement.dataset.renderer ?? null;

/** Reads a scoreboard with Tab held (the HUD shows the board while Tab is down). */
async function readBoard(page, scope = "body") {
  await page.keyboard.down("Tab");
  try {
    return await page.evaluate(BOARD_JS, scope);
  } finally {
    await page.keyboard.up("Tab");
  }
}

/** The app sets the renderer attribute once it is ready; fails when it is not the cell's renderer. */
async function checkRenderer(page, renderer) {
  await page.waitForFunction(RENDERER_JS, null, { timeout: 30000 });
  const got = await page.evaluate(RENDERER_JS);
  if (got !== renderer) throw new Error(`renderer is ${got}, expected ${renderer}`);
}

/**
 * Wraps s.open for one cell: webgl2 cells hide navigator.gpu before the app boots, and every page
 * counts resync messages sent and checksum frames received (binary frames starting 0x83).
 */
function instrument(s, renderer) {
  const openOrig = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOrig(label, opts);
    if (renderer === "webgl2") {
      await h.context.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      });
    }
    h.n = { resync: 0, checksum: 0 };
    h.page.on("websocket", (ws) => {
      ws.on("framesent", (e) => {
        if (typeof e.payload === "string" && e.payload.includes('"t":"resync"')) h.n.resync++;
      });
      ws.on("framereceived", (e) => {
        if (typeof e.payload !== "string" && e.payload.length > 0 && e.payload[0] === 0x83) h.n.checksum++;
      });
    });
    return h;
  };
}

/** One swing: the bat key held for SWING_HOLD_MS, then released and left to reset. Self-test: held for 0 ms. */
async function swing(page) {
  await page.keyboard.down("KeyC");
  await sleep(SELF === "hitbox" ? 0 : SWING_HOLD_MS);
  await page.keyboard.up("KeyC");
  await sleep(SWING_GAP_MS);
}

/** The engine tick the page presents (client game.ts publishes it as __qaTick). */
const tickOf = (page) => page.evaluate(() => globalThis.__qaTick?.tick ?? -1);

/** Resolves once the page presents engine tick `tick` or later. */
async function waitTick(page, tick) {
  await page.waitForFunction((t) => (globalThis.__qaTick?.tick ?? -1) >= t, tick, { timeout: 120000, polling: 10 });
}

/** A swing timed to engine ticks: KeyC down at tick `tick`, up `hold` ticks later (hold 0: self-test). */
async function swingAt(page, tick, hold) {
  await waitTick(page, tick);
  await page.keyboard.down("KeyC");
  await waitTick(page, tick + hold);
  await page.keyboard.up("KeyC");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The server's own record of a match (NEOBOX_QA_EVENTS, crates/server/src/qa_events.rs), worded as the clients word
 * it: hits and KOs as text with their ticks; `end` is the final record (null if the match did not end).
 */
function readServerLog(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    hits: lines.filter((l) => l.ev === "hit").map((l) => ({ tick: l.tick, text: `${l.by} hit ${l.victim}` })),
    kos: lines.filter((l) => l.ev === "ko").map((l) => ({ tick: l.tick, text: `${l.by} KO ${l.victim}` })),
    end: lines.findLast((l) => l.ev === "end") ?? null,
  };
}

/**
 * Host and guest in a fresh public room on FIXTURE_MAP, kills mode with objectiveLimit `killLimit`, match started.
 * The map is pasted as code (Change map > Map code or JSON > Use code), the way e2e's voidMap is.
 */
async function fixtureMatch(s, killLimit) {
  const hostName = uniqueName("host");
  const guestName = uniqueName("guest");
  const roomName = uniqueName("room");
  const host = await s.open("host", { name: hostName, clipboard: false });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  await dismissPhoneSplash(host.page);
  const guest = await s.open("guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  await roomTitle(guest.page, roomName).waitFor();
  await dismissPhoneSplash(guest.page);
  await host.page.locator("li.room-player").filter({ hasText: guestName }).waitFor();
  await button(host.page, "Change map").click();
  await host.page.getByLabel("Map code or JSON", { exact: true }).fill(FIXTURE_MAP);
  await button(host.page, "Use code").click();
  const chat = host.page.getByLabel("Chat message", { exact: true });
  await chat.fill(`/set objectiveLimit ${killLimit}`);
  await chat.press("Enter");
  await host.page.locator("div.room-chat-log").getByText(`objectiveLimit: ${killLimit}`).waitFor();
  await startMatch(host, [guest]);
  return { host, guest, code, hostName, guestName };
}

/**
 * Hitbox case: two clients on the fixture map, HITBOX_SWINGS rounds with one swing each, the swinger alternating.
 * Presses are keyed to engine ticks read from the swinger's own client (see the header). Pass: no resync, both
 * clients' hit and KO logs are equal and equal the server's own record of the match, the server recorded
 * HITBOX_SWINGS hits, and the scoreboards agree.
 */
async function hitboxCase(s, renderer, out, logFile) {
  const { host, guest, code, hostName, guestName } = await fixtureMatch(s, 99);
  await checkRenderer(host.page, renderer);
  await checkRenderer(guest.page, renderer);
  await ensureProbe(host.page);
  await ensureProbe(guest.page);
  await waitForPixels(host, "host canvas");
  await waitForPixels(guest, "guest canvas");
  await waitTick(host.page, 0);
  await sleep(3000); // spawn grace (sim SPAWN_GRACE) before a bat can hit
  const n0 = { host: { ...host.n }, guest: { ...guest.n } };
  const px0 = { host: await probeChanges(host.page), guest: await probeChanges(guest.page) };
  const boardBefore = await readBoard(host.page);

  const base = (await tickOf(host.page)) + FIRST_SWING_TICKS;
  const hold = SELF === "hitbox" ? 0 : HOLD_TICKS;
  for (let i = 0; i < HITBOX_SWINGS; i++) {
    await swingAt(i % 2 === 0 ? host.page : guest.page, base + i * ROUND_TICKS, hold);
  }
  // one more round, so the last victim's fall (and its KO) is in both logs before they are read
  const end = base + (HITBOX_SWINGS + 1) * ROUND_TICKS;
  await waitTick(host.page, end);
  await waitTick(guest.page, end);

  const hitsHost = await host.page.evaluate(HITS_JS);
  const hitsGuest = await guest.page.evaluate(HITS_JS);
  const kosHost = await host.page.evaluate(KOS_JS);
  const kosGuest = await guest.page.evaluate(KOS_JS);
  const truth = readServerLog(logFile);
  const hitsServer = truth.hits.map((h) => `${h.tick}|${h.text}`).sort();
  const kosServer = truth.kos.map((k) => `${k.tick}|${k.text}`).sort();
  const hitsAgree = hitsHost.length > 0 && same(hitsHost, hitsGuest);
  const kosAgree = same(kosHost, kosGuest);
  const hitsMatchServer = same(hitsHost, hitsServer) && same(hitsGuest, hitsServer);
  const kosMatchServer = same(kosHost, kosServer) && same(kosGuest, kosServer);
  const toGuest = truth.hits.filter((h) => h.text === `${hostName} hit ${guestName}`).length;
  const toHost = truth.hits.filter((h) => h.text === `${guestName} hit ${hostName}`).length;
  const m = {
    "gameplay.hitbox.swings": HITBOX_SWINGS,
    "gameplay.hitbox.resyncs.host": host.n.resync - n0.host.resync,
    "gameplay.hitbox.resyncs.guest": guest.n.resync - n0.guest.resync,
    "gameplay.hitbox.checksumFrames.host": host.n.checksum - n0.host.checksum,
    "gameplay.hitbox.checksumFrames.guest": guest.n.checksum - n0.guest.checksum,
    "gameplay.hitbox.canvasChanges.host": (await probeChanges(host.page)) - px0.host,
    "gameplay.hitbox.canvasChanges.guest": (await probeChanges(guest.page)) - px0.guest,
    "gameplay.hitbox.hits.host": hitsHost.length,
    "gameplay.hitbox.hits.guest": hitsGuest.length,
    "gameplay.hitbox.hits.server": hitsServer.length,
    "gameplay.hitbox.hits.hostToGuest": toGuest,
    "gameplay.hitbox.hits.guestToHost": toHost,
    "gameplay.hitbox.kos.server": kosServer.length,
  };
  const boardHost = await readBoard(host.page);
  const boardGuest = await readBoard(guest.page);
  const boardAgree = same(boardHost, boardGuest);
  const agree =
    m["gameplay.hitbox.resyncs.host"] === 0 &&
    m["gameplay.hitbox.resyncs.guest"] === 0 &&
    boardAgree &&
    hitsAgree &&
    kosAgree &&
    hitsMatchServer &&
    kosMatchServer &&
    hitsServer.length === HITBOX_SWINGS &&
    m["gameplay.hitbox.checksumFrames.host"] >= 5;
  m["gameplay.hitbox.agree"] = agree ? 1 : 0;
  m["gameplay.hitbox.boardChanged"] = same(boardHost, boardBefore) ? 0 : 1;
  m["gameplay.hitbox.boardAgree"] = boardAgree ? 1 : 0;
  m["gameplay.hitbox.hitsAgree"] = hitsAgree ? 1 : 0;
  m["gameplay.hitbox.kosAgree"] = kosAgree ? 1 : 0;
  m["gameplay.hitbox.hitsMatchServer"] = hitsMatchServer ? 1 : 0;
  m["gameplay.hitbox.kosMatchServer"] = kosMatchServer ? 1 : 0;
  const shots = [];
  for (const [who, h] of [
    ["host", host],
    ["guest", guest],
  ]) {
    const file = path.join(out.evidenceDir, `hitbox-${renderer}-${who}.png`);
    await h.page.screenshot({ path: file }).then(() => shots.push(file), () => {});
  }
  return {
    pass: agree,
    metrics: m,
    detail: `code ${code}; server hits ${hitsServer.length} (host ${hitsHost.length}, guest ${hitsGuest.length}, ${hitsMatchServer ? "match" : "differ"}); server KOs ${kosServer.length} (host ${kosHost.length}, guest ${kosGuest.length}, ${kosMatchServer ? "match" : "differ"}); host->guest ${toGuest} guest->host ${toHost}; resyncs ${m["gameplay.hitbox.resyncs.host"]}/${m["gameplay.hitbox.resyncs.guest"]}; board ${boardAgree ? "agrees" : `differs: host ${JSON.stringify(boardHost)} guest ${JSON.stringify(boardGuest)}`}; hits host ${JSON.stringify(hitsHost)} guest ${JSON.stringify(hitsGuest)} server ${JSON.stringify(hitsServer)}`,
    evidence: shots,
  };
}

/** Replay case: one live match to KO_LIMIT kills, its saved replay played to the end, both read from the DOM. */
async function replayCase(s, renderer, n, out, logFile) {
  const { host, guest, code } = await fixtureMatch(s, KO_LIMIT);
  await checkRenderer(host.page, renderer);
  await waitForPixels(host, "host canvas");
  await waitForPixels(guest, "guest canvas");
  await sleep(3000); // spawn grace before a bat can hit
  // Both players swing point-blank until the match is over (Back to room) or PLAY_MS has passed. The HUD is replaced
  // once the match ends, so the live log and board are sampled while it runs; the last sample that still had events
  // is the live reading.
  const backToRoom = button(host.page, "Back to room");
  const deadline = Date.now() + PLAY_MS;
  const over = async () => Date.now() >= deadline || (await backToRoom.isVisible().catch(() => false));
  let live = { board: [], guestBoard: [], events: [], guestEvents: [] };
  const sample = async () => {
    const events = await host.page.evaluate(EVENTS_JS, "body");
    if (events.length === 0 || events.length === live.events.length) return;
    live = {
      board: await readBoard(host.page),
      guestBoard: await readBoard(guest.page),
      events,
      guestEvents: await guest.page.evaluate(EVENTS_JS, "body"),
    };
  };
  const sampler = (async () => {
    while (!(await over())) {
      await sample().catch(() => {});
      await sleep(100);
    }
  })();
  await Promise.all([
    sampler,
    ...[host.page, guest.page].map(async (page) => {
      while (!(await over())) await swing(page);
    }),
  ]);
  if (await backToRoom.isVisible().catch(() => false)) {
    await backToRoom.click();
  } else {
    await host.page.locator(".hud-end").click();
    const endDialog = host.page.getByRole("alertdialog", { name: "End the match?", exact: true });
    await endDialog.waitFor();
    await endDialog.getByRole("button", { name: "End match", exact: true }).click();
    await sleep(1000);
  }
  const save = button(host.page, "Save replay");
  await save.waitFor();
  const [download] = await Promise.all([host.page.waitForEvent("download"), save.click()]);
  const file = path.join(out.evidenceDir, `replay-${renderer}-${n}.nbreplay`);
  await download.saveAs(file);

  await host.page.goto(s.base);
  await menuName(host.page).waitFor();
  await navTo(host.page, "Replay");
  await host.page.locator("input[type=file]").first().setInputFiles(file);
  await host.page.locator(".offline.playing").waitFor();
  await waitForPixels(host, "replay canvas");
  await button(host.page, "Play").click();
  // Play to the end without seeking: the seek bar's value reaches its max as playback advances.
  await host.page.waitForFunction(
    () => {
      const el = document.querySelector('input[aria-label="Seek"]');
      return el !== null && Number(el.max) > 0 && Number(el.value) >= Number(el.max);
    },
    null,
    { timeout: PLAY_MS + 120000 },
  );
  await sleep(1000);
  if (SELF === "replay") {
    // Self-test defect: a KO line the match never had.
    await host.page.evaluate(() => {
      const li = document.createElement("li");
      li.className = "hud-event hud-event-ko";
      li.textContent = "guest KO host";
      document.querySelector(".replay-board .hud-events")?.append(li);
    });
  }
  const replay = {
    board: await readBoard(host.page, ".replay-board"),
    events: await host.page.evaluate(EVENTS_JS, ".replay-board"),
  };
  const shot = path.join(out.evidenceDir, `replay-${renderer}-${n}-end.png`);
  await host.page.screenshot({ path: shot }).catch(() => {});

  const koLive = live.events.filter((t) => t.includes(" KO "));
  const koReplay = replay.events.filter((t) => t.includes(" KO "));
  const truth = readServerLog(logFile);
  const koServer = truth.kos.map((k) => k.text);
  const koMatch = same(koLive, koReplay);
  const koServerMatch = same(koReplay, koServer);
  // kills per player, from the replay's board and from the server's final record
  const killsOf = (rows) => rows.map((r) => r.split("|")).map((c) => `${c[0]}|${c[2]}`).sort();
  const killsServer = (truth.end?.players ?? []).map((p) => `${p.name}|${p.kills}`).sort();
  const scoreMatch = same(killsOf(replay.board), killsServer);
  const boardMatch = same(live.board, replay.board);
  const logMatch = same(live.events, replay.events);
  const liveAgree = same(live.board, live.guestBoard) && same(live.events, live.guestEvents);
  // A match with no KO proves nothing about KO order, so it cannot pass.
  const fidelity = koServer.length > 0 && koServerMatch && scoreMatch && boardMatch && liveAgree && truth.end !== null;
  return {
    pass: fidelity,
    metrics: {
      "replay.fidelity": fidelity ? 1 : 0,
      "replay.log.match": logMatch ? 1 : 0,
      "replay.koMatch": koMatch ? 1 : 0,
      "replay.koServerMatch": koServerMatch ? 1 : 0,
      "replay.scoreMatch": scoreMatch ? 1 : 0,
      "replay.boardMatch": boardMatch ? 1 : 0,
      "replay.liveAgree": liveAgree ? 1 : 0,
      "replay.kos": koServer.length,
      "replay.kosLive": koLive.length,
      "replay.hits": truth.hits.length,
      "replay.logLength": live.events.length,
    },
    detail: `code ${code}; KOs server ${koServer.length} live ${koLive.length} replay ${koReplay.length}; replay order ${koServerMatch ? "matches" : "differs from"} server; kills ${scoreMatch ? "match" : `differ: replay ${JSON.stringify(killsOf(replay.board))} server ${JSON.stringify(killsServer)}`}; board ${boardMatch ? "same" : "differs"}; log ${logMatch ? "same" : "differs"}; live host/guest ${liveAgree ? "agree" : "differ"}`,
    evidence: [shot],
  };
}

async function main() {
  for (const engine of selectedEngines()) {
    const cells = CELLS.filter((c) => c.engine === engine && (!RENDERERS || RENDERERS.includes(c.renderer)));
    if (cells.length === 0) continue;
    const results = new Results("gameplay", engine);
    const browser = await launchEngine(engine);
    // Runs one case on its own server, which records its match to a log the case reads as the server's truth;
    // closes the case's browser contexts once it is recorded.
    const runCase = async (id, body) => {
      const logFile = path.join(results.evidenceDir, `server-${id}.jsonl`);
      rmSync(logFile, { force: true });
      const server = await startServer({ extraEnv: { NEOBOX_QA_EVENTS: logFile } });
      let scenario = null;
      try {
        await results.case(
          id,
          async (s) => {
            scenario = s;
            return body(s, logFile);
          },
          { browser, base: server.base },
        );
      } finally {
        await scenario?.close();
        await server.stop();
      }
    };
    try {
      for (const { renderer } of cells) {
        const out = { evidenceDir: results.evidenceDir };
        if (SELF === "hitbox" || (SELF === null && ONLY !== "replay")) {
          await runCase(`hitbox.${renderer}`, (s, logFile) => {
            instrument(s, renderer);
            return hitboxCase(s, renderer, out, logFile);
          });
        }
        if (SELF === "replay" || (SELF === null && ONLY !== "hitbox")) {
          const count = SELF === "replay" ? 1 : MATCHES;
          for (let n = 1; n <= count; n++) {
            await runCase(`replay.${renderer}.${n}`, (s, logFile) => {
              instrument(s, renderer);
              return replayCase(s, renderer, n, out, logFile);
            });
          }
          if (SELF === null && ONLY === null) {
            const matches = results.cases.filter((c) => c.id.startsWith(`replay.${renderer}.`) && c.metrics?.["replay.fidelity"] !== undefined);
            const passed = matches.filter((c) => c.metrics["replay.fidelity"] === 1).length;
            const all = matches.length === MATCHES && passed === MATCHES;
            results.cases.push({
              id: `replay.${renderer}.summary`,
              verdict: all ? "pass" : "fail",
              detail: `${passed} of ${MATCHES} matches reproduced`,
              metrics: { "replay.fidelity": all ? 1 : 0, "replay.fidelity.matches": passed },
            });
          }
        }
      }
    } finally {
      results.save();
      await browser.close?.().catch(() => {});
    }
  }
  writeIndex();
  await runCleanups();
}

export { FIXTURE_MAP, fixtureMatch };

if (import.meta.main) await main();
