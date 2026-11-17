// Security instrument: XSS payload injection, server name limit, WebSocket origin check, chat
// rate-limit feedback, and server-side profanity masking.
//
// Keys (RUBRIC D24 / section 9.1):
//   sec.xss.hits              payloads that run or inject markup, over the name, room name (room title and
//                             Browse list) and chat surfaces. 0 passes.
//   sec.server.nameLimit      1 when a 16-char hello name is refused with invalid_playername (raw WebSocket).
//   sec.ws.originRejected     1 when an upgrade with a foreign Origin is refused, or closes before any frame.
//   sec.chat.rateLimited      1 when 20 chats sent in one tick are cut off by the server and the sender sees a toast.
//   sec.profanity.viewerMasked  1 when a profane line sent over raw WebSocket shows masked in a browser viewer's room
//                             chat (filter on), and shows unmasked after the viewer turns the profanity filter off.
//
// Run: cd client && QA_OUT=<dir> node qa/security.mjs     (QA_ENGINES=chromium to narrow)
// Output: <QA_OUT>/security-<engine>.{json,md}; evidence under <QA_OUT>/evidence/security-<engine>/.
// The XSS, chat rate and profanity cases run on every selected engine. Raw WebSocket origin and name cases run on
// chromium only; other engines get an info row.
//
// Self-test: QA_SELF_TEST=<mode> runs only that key's case with a known fault; that case must FAIL.
//   xss        innerHTML of a marked payload into h1.room-title (a real unsafe DOM insertion)
//   namelimit  sends a valid 15-char name where the case expects the 16-char refusal
//   origin     opens with the server's own origin (allowed) where the case expects a refusal
//   ratelimit  sends 3 chats (within the server burst) where the case expects 20 to be limited
//   profanity  sends a clean line where the case expects the viewer to see a masked profane word
// Use a separate QA_OUT for self-tests (each run overwrites <instrument>-<engine>.json).

import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  Results,
  button,
  createRoom,
  launchEngine,
  menuName,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startServer,
  uniqueName,
  watchPage,
  writeIndex,
} from "./lib-qa.mjs";
import { joinByInvite, navTo, playFromMenu } from "../e2e/lib.mjs";

const MODE = selfTestMode();
const want = (key) => MODE === null || MODE === key;

// Each payload marks its element with QAX<n> and sets window.__xss when it runs. Room names are
// capped at 50 characters; the name field is capped at 15, so NAME_PAYLOADS are short.
const PAYLOADS = [
  '<img src=data: id=QAX1 onerror="window.__xss=1">',
  '"><svg id=QAX2 onload="window.__xss=1">',
  "<script id=QAX3>window.__xss=1</script>",
];
const NAME_PAYLOADS = ["<b id=QAX4>", '"><b id=QAX5>', "<i id=QAX6>"];

// Runs before page code in every page. Records the page's sockets and received frames, and counts any
// element added to the DOM that carries a QAX marker (attribute value or script text). Markup the app
// renders as text creates no element, so it is not a hit.
const INIT = () => {
  window.__ws = [];
  window.__frames = [];
  window.__xss = 0;
  window.__xssHits = [];
  const Orig = window.WebSocket;
  window.WebSocket = new Proxy(Orig, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      window.__ws.push(socket);
      socket.addEventListener("message", (e) => {
        try {
          window.__frames.push(JSON.parse(e.data));
        } catch {
          // not JSON
        }
      });
      return socket;
    },
  });
  const marked = (el) =>
    [...el.attributes].some((a) => a.value.includes("QAX")) || (el.localName === "script" && el.textContent.includes("QAX"));
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    for (const el of [node, ...node.querySelectorAll("*")]) if (marked(el)) window.__xssHits.push(el.localName);
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) scan(n);
  }).observe(document, { childList: true, subtree: true });
};

async function openPage(s, label) {
  const h = await s.open(label);
  await h.context.addInitScript(INIT);
  watchPage(h);
  return h;
}

const resetHits = (page) =>
  page.evaluate(() => {
    window.__xss = 0;
    window.__xssHits = [];
  });
const hitOf = (page) => page.evaluate(() => (window.__xss === 1 || (window.__xssHits ?? []).length > 0 ? 1 : 0));

// ---------------------------------------------------------------- browser cases

async function nameSurface(page, base, payload) {
  await page.goto(base);
  await menuName(page).waitFor();
  await menuName(page).fill(payload);
  await playFromMenu(page, null);
  await button(page, "New room").click();
  await page.getByLabel("room name", { exact: true }).fill(uniqueName("xn"));
  await button(page, "Create room").click();
  await page.locator("h1.room-title").waitFor();
  await page.locator(".room-player-name").first().waitFor();
}

async function roomSurface(host, browse, base, payload) {
  await createRoom(host, base, payload, { isPublic: true });
  await browse.page.goto(base);
  await playFromMenu(browse.page, null);
  await browse.page.locator('ul[aria-label="rooms"]').waitFor();
  await sleep(800);
}

async function xssCase(s, base) {
  const parts = { name: 0, room: 0, chat: 0, injected: 0 };
  if (MODE === "xss") {
    const h = await openPage(s, "inject");
    await createRoom(h, base, uniqueName("xi"), { isPublic: false });
    await resetHits(h.page);
    await h.page.evaluate((p) => {
      document.querySelector("h1.room-title").innerHTML = p;
    }, PAYLOADS[0]);
    await sleep(500);
    parts.injected = await hitOf(h.page);
  } else {
    const h = await openPage(s, "xss");
    const browse = await openPage(s, "browse");
    for (const p of NAME_PAYLOADS) {
      await resetHits(h.page);
      await nameSurface(h.page, base, p);
      await sleep(800);
      parts.name += await hitOf(h.page);
    }
    for (const p of PAYLOADS) {
      await resetHits(h.page);
      await roomSurface(h, browse, base, p);
      parts.room += Math.max(await hitOf(h.page), await hitOf(browse.page));
    }
    const chat = await openPage(s, "chat");
    await createRoom(chat, base, uniqueName("xc"), { isPublic: false });
    const input = chat.page.locator(".room-chat-input");
    for (const p of PAYLOADS) {
      await resetHits(chat.page);
      await input.fill(p);
      await input.press("Enter");
      await sleep(1500);
      parts.chat += await hitOf(chat.page);
    }
  }
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  const metrics = { "sec.xss.hits": total };
  for (const [k, v] of Object.entries(parts)) metrics[`sec.xss.hits.${k}`] = v;
  return {
    pass: total === 0,
    metrics,
    detail: Object.entries(parts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", "),
  };
}

async function chatRateCase(s, base) {
  const h = await openPage(s, "rate");
  const page = h.page;
  await createRoom(h, base, uniqueName("rate"), { isPublic: false });
  await page.locator(".room-chat-input").waitFor();
  const n = MODE === "ratelimit" ? 3 : 20;
  await page.evaluate((count) => {
    const sock = window.__ws.filter((w) => w.readyState === 1).at(-1);
    for (let i = 0; i < count; i++) sock.send(JSON.stringify({ t: "chat", text: `QA burst ${i}` }));
  }, n);
  await sleep(1500);
  const frames = await page.evaluate(() => window.__frames);
  const accepted = frames.filter((f) => f.t === "chat" && typeof f.text === "string" && f.text.startsWith("QA burst")).length;
  const limited = frames.filter((f) => f.t === "error" && f.code === "rate_limited").length;
  const toast = await page
    .getByRole("alert")
    .filter({ hasText: "too much" })
    .first()
    .waitFor({ timeout: 3000 })
    .then(
      () => true,
      () => false,
    );
  const rateLimited = limited > 0 && toast ? 1 : 0;
  return {
    pass: rateLimited === 1,
    metrics: { "sec.chat.rateLimited": rateLimited, "sec.chat.accepted": accepted, "sec.chat.sent": n },
    detail: `sent ${n}, accepted ${accepted}, rate_limited errors ${limited}, toast ${toast ? "shown" : "not shown"}`,
  };
}

// ---------------------------------------------------------------- raw WebSocket cases

class RawWs {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head ?? Buffer.alloc(0);
    this.frames = [];
    this.closed = false;
    socket.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", () => {
      this.closed = true;
    });
    this.parse();
  }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (b.length < off + len) return;
      const op = b[0] & 0x0f;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op === 1) {
        try {
          this.frames.push(JSON.parse(payload.toString("utf8")));
        } catch {
          // not JSON
        }
      } else if (op === 9) this.write(0xa, payload);
      else if (op === 8) this.closed = true;
    }
  }

  // Client frames are masked, as RFC 6455 requires.
  write(op, payload) {
    const n = payload.length;
    const head = Buffer.alloc(n < 126 ? 2 : 4);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = 0x80 | n;
    else {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(n, 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < n; i++) body[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  send(obj) {
    this.write(1, Buffer.from(JSON.stringify(obj)));
  }

  /** First frame matching pred, or undefined on timeout or close. */
  async until(pred, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const f = this.frames.find(pred);
      if (f) return f;
      if (this.closed || Date.now() > end) return undefined;
      await sleep(50);
    }
  }

  close() {
    this.socket.destroy();
  }
}

/** Opens /ws with an optional Origin header. Resolves with the HTTP status and the RawWs (null when not upgraded). */
function connect(base, origin) {
  const url = new URL(base);
  const headers = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
  };
  if (origin) headers.Origin = origin;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: "/ws", headers });
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode, raw: new RawWs(socket, head) }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, raw: null });
    });
    req.on("error", reject);
    req.end();
  });
}

async function nameCase(base) {
  const name = MODE === "namelimit" ? "ABCDEFGHIJKLMNO" : "ABCDEFGHIJKLMNOP";
  const ws = await connect(base);
  if (!ws.raw) return { pass: false, metrics: { "sec.server.nameLimit": 0 }, detail: `upgrade status ${ws.status}` };
  ws.raw.send({ t: "hello", version: 1, name });
  const reply = await ws.raw.until((f) => f.t === "welcome" || f.t === "error", 4000);
  ws.raw.close();
  const rejected = reply?.t === "error" && reply.code === "invalid_playername" ? 1 : 0;
  return {
    pass: rejected === 1,
    metrics: { "sec.server.nameLimit": rejected },
    detail: `${name.length}-char name -> ${reply ? JSON.stringify(reply).slice(0, 140) : "no reply"}`,
  };
}

async function originCase(base) {
  const origin = MODE === "origin" ? base : "https://evil.example";
  const ws = await connect(base, origin);
  let refused = ws.raw === null;
  let detail = `upgrade status ${ws.status}`;
  if (ws.raw) {
    ws.raw.send({ t: "hello", version: 1, name: "QAOrigin" });
    const first = await ws.raw.until(() => true, 3000);
    refused = ws.raw.closed && ws.raw.frames.length === 0;
    detail += first ? `; first frame ${first.t}` : refused ? "; closed with no frame" : "; open, no frame in 3s";
    ws.raw.close();
  }
  const v = refused ? 1 : 0;
  return { pass: v === 1, metrics: { "sec.ws.originRejected": v }, detail: `Origin ${origin}: ${detail}` };
}

const sec = (page, name) => page.locator(".settings-nav-item").filter({ hasText: name }).click();
const sw = (page, text) => page.locator("label.check").filter({ hasText: text }).click();
const chatLinesWith = (page, needle) => page.locator(".room-chat-line").filter({ hasText: needle }).allTextContents();
const seenInChat = (page, needle) =>
  page
    .waitForFunction((n) => [...document.querySelectorAll(".room-chat-line")].some((el) => el.textContent.includes(n)), needle, {
      timeout: 5000,
    })
    .then(
      () => true,
      () => false,
    );

/**
 * A raw-WebSocket host (client bypassed) posts profane lines into its room. The browser viewer's own client must
 * mask them with the filter on, and show them as typed after the viewer turns the filter off in settings.
 */
async function profanityCase(s, base) {
  const clean = MODE === "profanity";
  const first = clean ? "hello there" : "fuck";
  const second = "shit";
  const sender = await connect(base);
  if (!sender.raw) return { pass: false, metrics: { "sec.profanity.viewerMasked": 0 }, detail: `upgrade status ${sender.status}` };
  const raw = sender.raw;
  raw.send({ t: "hello", version: 1, name: "QAProfanity" });
  await raw.until((f) => f.t === "welcome" || f.t === "error", 4000);
  raw.send({ t: "create_room", name: "QA profanity room", password: null, max_players: 8, public: false });
  const created = await raw.until((f) => f.t === "room", 4000);
  if (!created) {
    raw.close();
    return { pass: false, metrics: { "sec.profanity.viewerMasked": 0 }, detail: "no room frame after create_room" };
  }
  const { code, name: roomName } = created.room;

  const viewer = await s.open("viewer", { name: uniqueName("pview") });
  const page = viewer.page;
  await joinByInvite(viewer, base, code, roomName);

  raw.send({ t: "chat", text: first });
  const sawFirst = await seenInChat(page, "QAProfanity");
  const shownFirst = sawFirst ? ((await chatLinesWith(page, "QAProfanity")).at(-1) ?? "") : "none";
  const masked = sawFirst && shownFirst.includes("****") ? 1 : 0;

  // Prefs live in page memory, so the viewer leaves the room, changes the setting, and joins again.
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.goto(base);
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  await sec(page, "Chat");
  await sw(page, "Filter profanity");
  await sleep(300);
  const off = await page.evaluate(() => JSON.parse(localStorage.getItem("neobox.prefs") ?? "null")?.filterProfanity === false);
  await joinByInvite(viewer, base, code, roomName);

  raw.send({ t: "chat", text: second });
  const sawSecond = await seenInChat(page, second);
  const shownSecond = sawSecond ? ((await chatLinesWith(page, second)).at(-1) ?? "") : "none";
  const unmasked = sawSecond && shownSecond.includes(second) ? 1 : 0;
  raw.close();

  const v = masked === 1 && off && unmasked === 1 ? 1 : 0;
  return {
    pass: v === 1,
    metrics: { "sec.profanity.viewerMasked": v },
    detail: `filter on: "${shownFirst}" (masked ${masked}); filter off (pref off ${off}): "${shownSecond}" (unmasked ${unmasked})`,
  };
}

// ---------------------------------------------------------------- run

const engines = selectedEngines();
const server = await startServer();
const base = server.base;

for (const engine of engines) {
  const browser = await launchEngine(engine);
  const results = new Results("security", engine);
  const opts = { browser, base };

  if (engine === "chromium") {
    if (want("xss")) await results.case("xss.hits", (s) => xssCase(s, base), opts);
    if (want("ratelimit")) await results.case("chat.rateLimited", (s) => chatRateCase(s, base), opts);
    if (want("namelimit")) await results.case("server.nameLimit", () => nameCase(base), opts);
    if (want("origin")) await results.case("ws.originRejected", () => originCase(base), opts);
  } else {
    // Firefox reports requests the instrument's own page.goto aborts as "Navigated away from page" (one per
    // aborted request: problems == net.abortedOther in the run record). Only those are ignored, on non-chromium.
    if (want("xss")) await results.case("xss.hits", (s) => xssCase(s, base), { ...opts, ignore: [/Navigated away from page/] });
    if (want("ratelimit")) await results.case("chat.rateLimited", (s) => chatRateCase(s, base), opts);
    await results.case(
      "raw.skipped",
      () => ({ detail: "raw WebSocket cases (nameLimit, originRejected) run on chromium only" }),
      { ...opts, info: true },
    );
  }
  // The viewer navigates on purpose (leave, settings, rejoin); firefox and webkit report the app's in-flight calls as
  // "Navigated away from page". Chromium does not, so its run keeps every error.
  const profanityOpts = engine === "chromium" ? opts : { ...opts, ignore: [/Navigated away from page/] };
  if (want("profanity")) await results.case("profanity.viewerMasked", (s) => profanityCase(s, base), profanityOpts);

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
