// Liveness: a link that goes silent while its socket stays open shows the reconnect banner within about 3 s,
// and the match resumes when the link returns. A slow but live link shows no banner.
// The blackhole and slow-link cases route each page's socket through Playwright's relay (every engine), so the
// relay can drop traffic both ways. The offline case cuts the real socket with CDP network emulation (chromium),
// with no routing at all.

import { matchWithGuest, sleep } from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** The reconnect banner element. */
const BANNER = ".reconnect-banner";
/** The banner must show this long after the link goes silent (the silence limit is 2.5 s, checked every 0.25 s). */
const BANNER_MS = 3_500;
/** The browser's own refused reconnect while the emulated network is offline. */
const OFFLINE_CONSOLE_RE = /console error: WebSocket connection to .* failed: .*net::ERR_INTERNET_DISCONNECTED/;
/** How long the blackhole holds: past the server's own 10 s silence limit, so the server drops its side too. */
const HOLD_MS = 12_000;
/** How long the match takes to resume once the link is back: the reconnect plus the resume handshake. */
const RECOVER_MS = 15_000;
function pipe(deliver, link) {
  const items = [];
  let timer = null;
  const pump = () => {
    clearTimeout(timer);
    timer = null;
    while (items.length && items[0].at <= Date.now()) {
      const { fn } = items.shift();
      if (!link.hole) {
        try {
          fn();
        } catch {}
      }
    }
    if (items.length) timer = setTimeout(pump, Math.max(0, items[0].at - Date.now()));
  };
  return (msg) => {
    if (link.hole) return;
    const c = link.cond;
    const delay = c ? c.rtt / 2 + Math.random() * c.jitter + (Math.random() < c.loss ? c.rtt + 200 : 0) : 0;
    const last = items.length ? items[items.length - 1].at : 0;
    items.push({ at: Math.max(Date.now() + delay, last), fn: () => deliver(msg) });
    pump();
  };
}

/** The relay for one page's socket. A socket opened while the link is down is refused. */
function relay(link) {
  return (ws) => {
    if (link.hole) {
      ws.close();
      return;
    }
    const server = ws.connectToServer();
    const up = pipe((m) => server.send(m), link);
    const down = pipe((m) => ws.send(m), link);
    ws.onMessage((m) => up(m));
    server.onMessage((m) => down(m));
    // a close does not cross a dead link either: the far side only learns of it when the link returns
    ws.onClose(() => {
      if (!link.hole) server.close();
    });
    server.onClose(() => {
      if (!link.hole) ws.close();
    });
  };
}

/**
 * Page-side record for the offline case: every socket close with its time and code, and the time the banner
 * first showed. A close from the browser's own network failure (1006) before the banner would mean the
 * socket was not the liveness path's to abandon; `abandon()` closes with 1000.
 */
const SPY = () => {
  const Real = window.WebSocket;
  window.__closes = [];
  window.__bannerAt = null;
  window.WebSocket = class extends Real {
    constructor(...args) {
      super(...args);
      this.addEventListener("close", (e) => window.__closes.push({ t: Date.now(), code: e.code }));
    }
  };
  setInterval(() => {
    const b = document.querySelector(".reconnect-banner");
    if (window.__bannerAt === null && b && !b.hidden) window.__bannerAt = Date.now();
  }, 20);
};

/** Each page of the scenario gets a link. `spy` records socket closes instead of routing the socket. */
function linked(s, { spy = false } = {}) {
  const openOrig = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOrig(label, opts);
    h.link = { hole: false, cond: null };
    if (spy) await h.context.addInitScript(SPY);
    else await h.page.routeWebSocket(/.*/, relay(h.link));
    return h;
  };
  return s;
}

async function blackhole(s) {
  const { host } = await matchWithGuest(s, { clipboard: false });
  const banner = host.page.locator(BANNER);
  host.link.hole = true;
  const t0 = Date.now();
  await banner.waitFor({ state: "visible", timeout: BANNER_MS + 6_000 });
  const shownMs = Date.now() - t0;
  check(shownMs <= BANNER_MS, `banner after ${shownMs} ms of silence (budget ${BANNER_MS} ms)`);
  await sleep(Math.max(0, HOLD_MS - (Date.now() - t0)));
  check(await banner.isVisible(), "the banner hid while the link was still down");
  host.link.hole = false;
  const back = Date.now();
  await banner.waitFor({ state: "hidden", timeout: RECOVER_MS });
  const recoverMs = Date.now() - back;
  await host.page.locator(".hud-leave").waitFor({ state: "visible", timeout: RECOVER_MS });
  return `banner ${shownMs} ms after the link went silent; match back ${recoverMs} ms after the link returned`;
}

async function slowLink(s) {
  const { host, guest } = await matchWithGuest(s, { clipboard: false });
  // 150 ms RTT, 50 ms jitter, 2% stalls of rtt+200 ms: the netcode's own impaired profile
  const cond = { rtt: 150, jitter: 50, loss: 0.02 };
  host.link.cond = cond;
  guest.link.cond = cond;
  const banner = host.page.locator(BANNER);
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    check(!(await banner.isVisible()), "the banner showed on a slow but live link");
    await sleep(250);
  }
  await host.page.locator(".hud-leave").waitFor({ state: "visible" });
  return "150 ms RTT, 50 ms jitter, 2% stalls: no banner over 8 s";
}

async function offlineCdp(s) {
  const { host } = await matchWithGuest(s, { clipboard: false });
  const banner = host.page.locator(BANNER);
  const cdp = await host.context.newCDPSession(host.page);
  const setOffline = (offline) =>
    cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const t0 = Date.now();
  await setOffline(true);
  await banner.waitFor({ state: "visible", timeout: BANNER_MS + 6_000 });
  const shownMs = Date.now() - t0;
  check(shownMs <= BANNER_MS, `banner after ${shownMs} ms offline (budget ${BANNER_MS} ms)`);
  const { closes, bannerAt } = await host.page.evaluate(() => ({ closes: window.__closes, bannerAt: window.__bannerAt }));
  const early = closes.filter((c) => c.t < bannerAt);
  check(
    early.every((c) => c.code === 1000),
    `the browser closed the socket before liveness did (close codes ${early.map((c) => c.code).join(",")})`,
  );
  await sleep(Math.max(0, 4_000 - (Date.now() - t0)));
  check(await banner.isVisible(), "the banner hid while offline");
  await setOffline(false);
  const back = Date.now();
  await banner.waitFor({ state: "hidden", timeout: RECOVER_MS });
  const recoverMs = Date.now() - back;
  await host.page.locator(".hud-leave").waitFor({ state: "visible", timeout: RECOVER_MS });
  // Chromium logs each reconnect attempt on the cut link as a console error while offline: expected, not a page fault.
  for (let i = host.problems.length - 1; i >= 0; i--) {
    if (OFFLINE_CONSOLE_RE.test(host.problems[i])) host.problems.splice(i, 1);
  }
  return `banner ${shownMs} ms after CDP offline (${early.length} liveness close before it); match back ${recoverMs} ms after online`;
}

export const livenessScenarios = [
  { name: "liveness blackhole", run: (s) => blackhole(linked(s)) },
  { name: "liveness slow link", run: (s) => slowLink(linked(s)) },
  { name: "liveness offline", run: (s) => offlineCdp(linked(s, { spy: true })), cdp: true },
];
