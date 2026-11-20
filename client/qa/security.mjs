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
//   sec.mod.muteBlocked        1 when a muted guest's chat is refused with a `muted` error and never reaches the host.
//   sec.mod.kickVisible        1 when a kicked guest receives the `kicked` notice with a reason.
//   sec.chat.dupDelivered      1 when a host's chat line reaches a watcher exactly once (raw WebSocket).
//   sec.chat.extraCopies       extra deliveries of that line beyond the first (0 passes).
//   sec.chat.multiSocketDelivered  lines from three raw tabs on one address (one 3-line burst each) that reach the
//                             host. Passes at 1-3: sockets on one address share one chat budget.
//   sec.chat.commandReplies   `/help` replies to 20 slash commands sent in one tick. Passes at 1-3 (commands spend
//                             the chat budget), with rate_limited errors for the rest.
//   sec.typing.relayed        1 when a guest's typing reaches the host before any mute (raw WebSocket).
//   sec.typing.mutedRelayed   typing signals from a muted guest that reach the host (0 passes).
//   sec.presence.flood       updates a watcher gets: typing bursts bounded (<=2 of 10 relayed), join/leave bursts
//                             bounded (room updates <= joins+leaves+2). 1 passes. Chromium only.
//   *.phone                   chat rate and profanity cases re-run in a phone viewport (sec.chat.rateLimited.phone,
//                             sec.profanity.viewerMasked.phone).
//
// Run: cd client && QA_OUT=<dir> node qa/security.mjs     (QA_ENGINES=chromium to narrow)
// Output: <QA_OUT>/security-<engine>.{json,md}; evidence under <QA_OUT>/evidence/security-<engine>/.
// The XSS, chat rate and profanity cases run on every selected engine (chat rate and profanity also in a phone
// viewport). Raw WebSocket origin, name, moderation, multi-socket and command cases run on chromium only; other
// engines get an info row.
//
// Self-test: QA_SELF_TEST=<mode> runs only that key's case with a known fault; that case must FAIL.
//   xss        innerHTML of a marked payload into h1.room-title (a real unsafe DOM insertion)
//   namelimit  sends a valid 15-char name where the case expects the 16-char refusal
//   origin     opens with the server's own origin (allowed) where the case expects a refusal
//   ratelimit  sends 3 chats (within the server burst) where the case expects 20 to be limited
//   profanity  sends a clean line where the case expects the viewer to see a masked profane word
//   mute       skips the host's mute frame where the case expects the guest to be refused
//   multisocket  gives each tab of the three-tab burst its own forwarded address where the case expects one budget
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
import { drumOption, joinByInvite, navTo, playFromMenu } from "../e2e/lib.mjs";

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

// Runs before page code in every page. Records the page's sockets and received frames, and counts any element the
// page inserts into the DOM with a QAX<n> id (the payloads' marker). Markup the app renders as text creates no
// element, so it is not a hit.
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
  const marked = (el) => /^QAX\d+$/.test(el.id);
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    for (const el of [node, ...node.querySelectorAll("*")]) if (marked(el)) window.__xssHits.push(el.localName);
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) scan(n);
  }).observe(document, { childList: true, subtree: true });
};

async function openPage(s, label, { phone = false } = {}) {
  const h = await s.open(label, { phone });
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

// Markup is never a valid name: the field refuses it (the reason is shown, Browse stays disabled), so it cannot
// reach a room. A name the field accepts is a failure of that contract.
async function nameSurface(page, base, payload) {
  await page.goto(base);
  await menuName(page).waitFor();
  await menuName(page).fill(payload);
  await page.locator(".field-error:not([hidden])").first().waitFor();
  if ((await drumOption(page, "Browse rooms").getAttribute("aria-disabled")) !== "true") throw new Error(`name accepted: ${payload}`);
}

// The server strips '<' and '>' from room names (clean_label), so the title shows the stored form. The raw payload
// is still sent, so the server's stripping is part of what this case exercises.
const storedName = (typed) => typed.replace(/[<>]/g, "");
async function createRoomRaw(h, base, typed, { isPublic }) {
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await playFromMenu(page, null);
  await button(page, "New room").click();
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
  await page.getByLabel("room name", { exact: true }).fill(typed);
  const box = page.getByLabel("Public", { exact: true });
  if ((await box.isChecked()) !== isPublic) await box.setChecked(isPublic);
  await button(page, "Create room").click();
  await page.locator("h1.room-title").filter({ hasText: storedName(typed) }).waitFor();
}

async function roomSurface(host, browse, base, payload) {
  await createRoomRaw(host, base, payload, { isPublic: true });
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

async function chatRateCase(s, base, { phone = false } = {}) {
  const h = await openPage(s, "rate", { phone });
  const page = h.page;
  await createRoom(h, base, uniqueName("rate"), { isPublic: false });
  if (phone) await page.locator('button[data-tab="chat"]').click();
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

/** Opens /ws with an optional Origin and extra request headers. Resolves with the HTTP status and the RawWs (null when not upgraded). */
function connect(base, origin, extra = {}) {
  const url = new URL(base);
  const headers = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
  };
  if (origin) headers.Origin = origin;
  Object.assign(headers, extra);
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

/**
 * Host moderation over raw WebSocket. A host, a guest and a watcher share one room. Before any mute, a typing
 * signal from the guest reaches the host (control), and one chat line from the host is counted at the watcher
 * (extra frames are duplicates). The host mutes the guest: the guest's chat is refused with a `muted` error and
 * never reaches the host, and its typing signals stop reaching the host. The host kicks the guest: the guest gets
 * a `kicked` notice with a reason before the close.
 */
async function modCase(base) {
  const nonce = randomBytes(3).toString("hex");
  const socks = await Promise.all([connect(base), connect(base), connect(base)]);
  const [host, guest, watch] = socks;
  const closeAll = () => socks.forEach((s) => s.raw?.close());
  if (!host.raw || !guest.raw || !watch.raw) {
    closeAll();
    return {
      pass: false,
      metrics: { "sec.mod.muteBlocked": 0, "sec.mod.kickVisible": 0 },
      detail: `upgrade status ${socks.map((s) => s.status).join("/")}`,
    };
  }
  try {
    const [h, g, w] = [host.raw, guest.raw, watch.raw];
    for (const [x, name] of [
      [h, `QAHost${nonce}`],
      [g, `QAGuest${nonce}`],
      [w, `QAWatch${nonce}`],
    ]) {
      x.send({ t: "hello", version: 1, name });
      await x.until((f) => f.t === "welcome" || f.t === "error", 4000);
    }
    h.send({ t: "create_room", name: `QA mod ${nonce}`, password: null, max_players: 8, public: false });
    const created = await h.until((f) => f.t === "room", 4000);
    if (!created) return { pass: false, metrics: {}, detail: "no room frame after create_room" };
    for (const x of [g, w]) x.send({ t: "join_room", room: created.room.code, password: null });
    const joined = await g.until((f) => f.t === "joined", 4000);
    await w.until((f) => f.t === "joined", 4000);
    if (!joined) return { pass: false, metrics: {}, detail: "guest did not join the room" };
    const guestId = joined.you;

    const line = `QA dup ${nonce}`;
    h.send({ t: "chat", text: line });
    await sleep(1500);
    const delivered = w.frames.filter((f) => f.t === "chat" && typeof f.text === "string" && f.text.includes(line)).length;

    g.send({ t: "typing" });
    const control = (await h.until((f) => f.t === "typing" && f.player === guestId, 2000)) !== undefined;

    if (MODE !== "mute") h.send({ t: "mute", player: guestId, muted: true });
    await sleep(900); // clears the typing gap, so only the mute can stop the next signal
    const mark = h.frames.length;
    const muted = `QA muted ${nonce}`;
    g.send({ t: "chat", text: muted });
    g.send({ t: "typing" });
    const refused = await g.until((f) => f.t === "error" && f.code === "muted", 3000);
    await sleep(1000);
    const after = h.frames.slice(mark);
    const leaked = after.some((f) => f.t === "chat" && typeof f.text === "string" && f.text.includes(muted));
    const relayed = after.filter((f) => f.t === "typing" && f.player === guestId).length;
    const muteBlocked = refused && !leaked ? 1 : 0;

    h.send({ t: "kick", player: guestId, ban: false });
    const kicked = await g.until((f) => f.t === "kicked" && typeof f.reason === "string" && f.reason.length > 0, 3000);
    const kickVisible = kicked ? 1 : 0;

    return {
      pass: control && delivered === 1 && muteBlocked === 1 && relayed === 0 && kickVisible === 1,
      metrics: {
        "sec.mod.muteBlocked": muteBlocked,
        "sec.mod.kickVisible": kickVisible,
        "sec.chat.dupDelivered": delivered === 1 ? 1 : 0,
        "sec.chat.extraCopies": Math.max(0, delivered - 1),
        "sec.typing.relayed": control ? 1 : 0,
        "sec.typing.mutedRelayed": relayed,
      },
      detail: `control typing ${control ? "relayed" : "not relayed"}; line delivered ${delivered}x; muted chat ${refused ? "refused" : "not refused"}, reached host ${leaked}; muted typing relayed ${relayed}; kick notice ${kicked ? JSON.stringify(kicked.reason) : "none"}`,
    };
  } finally {
    closeAll();
  }
}

/**
 * Chat budget across sockets. A host and three raw tabs on one address (no forwarded header) share one room.
 * Each tab sends a 3-line burst in one tick. Chat is budgeted per player, per address and per account, so the
 * tabs share the address's single burst: the host gets at most one burst (3 lines) between them. The
 * `multisocket` self-test gives each tab its own forwarded address, which multiplies the burst and must fail.
 */
async function multiSocketCase(base) {
  const nonce = randomBytes(3).toString("hex");
  const burst = 3;
  const forwarded = (i) => (MODE === "multisocket" ? { "X-Forwarded-For": `10.9.0.${i}` } : {});
  const socks = await Promise.all([
    connect(base),
    connect(base, undefined, forwarded(1)),
    connect(base, undefined, forwarded(2)),
    connect(base, undefined, forwarded(3)),
  ]);
  const closeAll = () => socks.forEach((s) => s.raw?.close());
  if (socks.some((s) => !s.raw)) {
    closeAll();
    return {
      pass: false,
      metrics: { "sec.chat.multiSocketDelivered": 0 },
      detail: `upgrade status ${socks.map((s) => s.status).join("/")}`,
    };
  }
  try {
    const [host, ...tabs] = socks.map((s) => s.raw);
    for (const [x, name] of [
      [host, `QAHost${nonce}`],
      ...tabs.map((x, i) => [x, `QATab${i}${nonce}`]),
    ]) {
      x.send({ t: "hello", version: 1, name });
      await x.until((f) => f.t === "welcome" || f.t === "error", 4000);
    }
    host.send({ t: "create_room", name: `QA sockets ${nonce}`, password: null, max_players: 8, public: false });
    const created = await host.until((f) => f.t === "room", 4000);
    if (!created) return { pass: false, metrics: { "sec.chat.multiSocketDelivered": 0 }, detail: "no room frame after create_room" };
    for (const x of tabs) x.send({ t: "join_room", room: created.room.code, password: null });
    const joined = await Promise.all(tabs.map((x) => x.until((f) => f.t === "joined", 4000)));
    if (joined.some((j) => !j)) {
      return {
        pass: false,
        metrics: { "sec.chat.multiSocketDelivered": 0 },
        detail: `${joined.filter(Boolean).length} of 3 tabs joined`,
      };
    }
    tabs.forEach((x, i) => {
      for (let j = 0; j < burst; j++) x.send({ t: "chat", text: `QA tab${i} ${nonce} ${j}` });
    });
    await sleep(1500);
    const delivered = host.frames.filter(
      (f) => f.t === "chat" && typeof f.text === "string" && f.text.startsWith("QA tab") && f.text.includes(nonce),
    ).length;
    const limited = tabs.reduce((n, x) => n + x.frames.filter((f) => f.t === "error" && f.code === "rate_limited").length, 0);
    return {
      pass: delivered >= 1 && delivered <= burst,
      metrics: { "sec.chat.multiSocketDelivered": delivered },
      detail: `3 tabs x ${burst} lines on one address: delivered ${delivered}, rate_limited errors ${limited}`,
    };
  } finally {
    closeAll();
  }
}

/**
 * Slash commands share the chat budget. A host sends 20 `/help` lines in one tick: at most one burst gets a reply,
 * and the rest are refused with `rate_limited`.
 */
async function commandCase(base) {
  const nonce = randomBytes(3).toString("hex");
  const sock = await connect(base);
  if (!sock.raw) return { pass: false, metrics: { "sec.chat.commandReplies": 0 }, detail: `upgrade status ${sock.status}` };
  const raw = sock.raw;
  try {
    raw.send({ t: "hello", version: 1, name: `QACmd${nonce}` });
    await raw.until((f) => f.t === "welcome" || f.t === "error", 4000);
    raw.send({ t: "create_room", name: `QA commands ${nonce}`, password: null, max_players: 8, public: false });
    if (!(await raw.until((f) => f.t === "room", 4000))) {
      return { pass: false, metrics: { "sec.chat.commandReplies": 0 }, detail: "no room frame after create_room" };
    }
    for (let i = 0; i < 20; i++) raw.send({ t: "chat", text: "/help" });
    await sleep(1500);
    const replies = raw.frames.filter((f) => f.t === "chat" && typeof f.text === "string" && f.text.startsWith("Commands")).length;
    const limited = raw.frames.filter((f) => f.t === "error" && f.code === "rate_limited").length;
    return {
      pass: replies >= 1 && replies <= 3 && limited >= 1,
      metrics: { "sec.chat.commandReplies": replies },
      detail: `sent 20 /help: replies ${replies}, rate_limited errors ${limited}`,
    };
  } finally {
    raw.close();
  }
}

/**
 * Presence fan-out. A host, a watcher and a guest share one room. The guest sends a 10-line typing burst in one tick:
 * the watcher gets at most 2 typing frames (typing is relayed at most once per gap). Then two extra guests each join
 * and leave the room: the watcher gets at most one room update per join or leave, plus 2 slack.
 */
async function presenceFloodCase(base) {
  const nonce = randomBytes(3).toString("hex");
  const socks = await Promise.all([connect(base), connect(base), connect(base), connect(base), connect(base)]);
  const [host, guest, watch, flick1, flick2] = socks;
  const closeAll = () => socks.forEach((s) => s.raw?.close());
  const fail = (detail) => ({ pass: false, metrics: { "sec.presence.flood": 0 }, detail });
  if (!socks.every((s) => s.raw)) {
    closeAll();
    return fail(`upgrade status ${socks.map((s) => s.status).join("/")}`);
  }
  try {
    const [h, g, w, f1, f2] = [host.raw, guest.raw, watch.raw, flick1.raw, flick2.raw];
    for (const [x, tag] of [
      [h, "Host"],
      [g, "Guest"],
      [w, "Watch"],
      [f1, "Flick1"],
      [f2, "Flick2"],
    ]) {
      x.send({ t: "hello", version: 1, name: `QA${tag}${nonce}` });
      await x.until((f) => f.t === "welcome" || f.t === "error", 4000);
    }
    h.send({ t: "create_room", name: `QA flood ${nonce}`, password: null, max_players: 8, public: false });
    const created = await h.until((f) => f.t === "room", 4000);
    if (!created) return fail("no room frame after create_room");
    for (const x of [g, w]) x.send({ t: "join_room", room: created.room.code, password: null });
    const joined = await g.until((f) => f.t === "joined", 4000);
    await w.until((f) => f.t === "joined", 4000);
    if (!joined) return fail("guest did not join the room");

    const typing0 = w.frames.filter((f) => f.t === "typing").length;
    for (let i = 0; i < 10; i++) g.send({ t: "typing" });
    await sleep(1500);
    const typingSeen = w.frames.filter((f) => f.t === "typing").length - typing0;

    const room0 = w.frames.filter((f) => f.t === "room").length;
    let actions = 0;
    for (const x of [f1, f2]) {
      x.send({ t: "join_room", room: created.room.code, password: null });
      if (!(await x.until((f) => f.t === "joined", 4000))) break;
      actions++;
      x.send({ t: "leave_room" });
      if (!(await x.until((f) => f.t === "left", 4000))) break;
      actions++;
    }
    await sleep(500);
    const roomSeen = w.frames.filter((f) => f.t === "room").length - room0;

    if (actions < 4) return fail(`join/leave did not complete (${actions} of 4 actions)`);
    const v = typingSeen <= 2 && roomSeen <= actions + 2 ? 1 : 0;
    return {
      pass: v === 1,
      metrics: { "sec.presence.flood": v },
      detail: `typing burst of 10: watcher got ${typingSeen} typing frames (bound 2); ${actions} join/leave actions: watcher got ${roomSeen} room frames (bound ${actions + 2})`,
    };
  } finally {
    closeAll();
  }
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

// The app navigates on Leave, so a goto issued right after it can be aborted (ERR_ABORTED) by that navigation. Retry
// the same navigation once the app's own has settled.
async function gotoSettled(page, url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url);
    } catch (e) {
      if (attempt >= 3 || !String(e).includes("ERR_ABORTED")) throw e;
      await sleep(500);
    }
  }
}

/**
 * A raw-WebSocket host (client bypassed) posts profane lines into its room. The browser viewer's own client must
 * mask them with the filter on, and show them as typed after the viewer turns the filter off in settings.
 */
async function profanityCase(s, base, { phone = false } = {}) {
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

  const viewer = await s.open("viewer", { name: uniqueName("pview"), phone });
  const page = viewer.page;
  await joinByInvite(viewer, base, code, roomName);

  raw.send({ t: "chat", text: first });
  const sawFirst = await seenInChat(page, "QAProfanity");
  const shownFirst = sawFirst ? ((await chatLinesWith(page, "QAProfanity")).at(-1) ?? "") : "none";
  const masked = sawFirst && !/fuck/i.test(shownFirst) && shownFirst.includes("****") ? 1 : 0;

  // Prefs live in page memory, so the viewer leaves the room, changes the setting, and joins again.
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await gotoSettled(page, base);
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
    if (want("ratelimit")) await results.case("chat.rateLimited.phone", (s) => chatRateCase(s, base, { phone: true }), opts);
    if (want("namelimit")) await results.case("server.nameLimit", () => nameCase(base), opts);
    if (want("origin")) await results.case("ws.originRejected", () => originCase(base), opts);
    if (want("mute")) await results.case("mod", () => modCase(base), opts);
    if (want("multisocket")) await results.case("chat.multiSocket", () => multiSocketCase(base), opts);
    if (MODE === null) await results.case("chat.commandFlood", () => commandCase(base), opts);
    if (MODE === null) await results.case("presence.flood", () => presenceFloodCase(base), opts);
  } else {
    // Firefox reports requests the instrument's own page.goto aborts as "Navigated away from page" (one per
    // aborted request: problems == net.abortedOther in the run record). Only those are ignored, on non-chromium.
    if (want("xss")) await results.case("xss.hits", (s) => xssCase(s, base), { ...opts, ignore: [/Navigated away from page/] });
    if (want("ratelimit")) await results.case("chat.rateLimited", (s) => chatRateCase(s, base), opts);
    if (want("ratelimit")) await results.case("chat.rateLimited.phone", (s) => chatRateCase(s, base, { phone: true }), opts);
    await results.case(
      "raw.skipped",
      () => ({ detail: "raw WebSocket cases (nameLimit, originRejected, mod) run on chromium only" }),
      { ...opts, info: true },
    );
  }
  // The viewer navigates on purpose (leave, settings, rejoin); firefox and webkit report the app's in-flight calls as
  // "Navigated away from page". Chromium does not, so its run keeps every error.
  const profanityOpts = engine === "chromium" ? opts : { ...opts, ignore: [/Navigated away from page/] };
  if (want("profanity")) await results.case("profanity.viewerMasked", (s) => profanityCase(s, base), profanityOpts);
  if (want("profanity")) await results.case("profanity.viewerMasked.phone", (s) => profanityCase(s, base, { phone: true }), profanityOpts);

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
