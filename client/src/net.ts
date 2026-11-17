// Transport: JSON text frames over the WebSocket for control; binary frames for
// gameplay, sent over an optional unreliable WebRTC data channel when available.

import type { ClientMsg, ServerMsg } from "./protocol";
import { checkServerMsg } from "./frame-check";

export type NetStatus = "connecting" | "open" | "closed";
/** Active gameplay transport: "udp" = WebRTC data channel, "ws" = WebSocket. */
export type Transport = "udp" | "ws";

/** What a closed socket means to the player: status line, toast ("" = none), whether to resume. */
export interface CloseNotice {
  label: string;
  text: string;
  reconnect: boolean;
}

/** Map the close reason the server sends (see `hub::close`) to a notice. */
export function closeNotice(reason: string, wasClean: boolean): CloseNotice {
  switch (reason) {
    // the kick, ban or idle message already told the player why
    case "kicked":
    case "banned":
    case "idle":
      return { label: "", text: "", reconnect: false };
    case "replaced":
      return { label: "Opened in another window", text: "This game opened in another window.", reconnect: false };
    case "flood":
      return { label: "Sending too fast", text: "Disconnected: sending messages too fast.", reconnect: false };
    case "too_big":
      return { label: "Message too large", text: "Disconnected: a message was too large.", reconnect: false };
    case "shutdown":
      return { label: "Server restarting", text: "The server is restarting.", reconnect: true };
    default:
      return wasClean
        ? { label: "", text: "", reconnect: true }
        : { label: "Connection lost", text: "Connection lost.", reconnect: true };
  }
}

export interface NetHandlers {
  onMessage(msg: ServerMsg): void;
  onBinary(data: Uint8Array): void;
  /** `unexpected`: the socket closed without close() being called (network drop or server close). */
  onStatus(status: NetStatus, notice?: CloseNotice, unexpected?: boolean): void;
}

interface Rtc {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
}

/** At most one WebRTC attempt per this many milliseconds. */
const RTC_RETRY_MS = 30_000;
/** Liveness is checked every LIVE_TICK_MS (the browser never shows us a dead TCP link on its own): worst case the banner shows SILENT_MS + one tick after the last frame. */
const LIVE_TICK_MS = 250;
/** Silence before a ping goes out: a quiet link is tested, not assumed alive. */
const PING_AFTER_MS = 1_000;
/** Silence after which the socket is abandoned and reconnected: the banner shows about this long after the link dies. */
const SILENT_MS = 2_500;
/** A probe (the network changed) leaves this much of the silence limit to run out. */
const PROBE_GRACE_MS = 1_500;
/** A socket still connecting after this long is abandoned. */
const CONNECT_MS = 8_000;
/** A tick this late means the page was frozen or throttled, so the silence before it is not the network's. */
const FREEZE_MS = 1_500;
/** Tags of the app-level ping and its pong (crates/net protocol.rs). */
const C_PING = 2;
const S_PONG = 0x82;

export class Net {
  private ws: WebSocket | null = null;
  private rtc: Rtc | null = null;
  private rtcRetryAt = 0;
  private watch: number | null = null;
  private lastInbound = 0;
  private lastTick = 0;
  private connectStarted = 0;
  private lastPing = Number.NEGATIVE_INFINITY;
  /** Client times of our pings still unanswered: their pongs are liveness only, never the engine's. */
  private pings: number[] = [];
  status: NetStatus = "closed";

  constructor(private readonly handlers: NetHandlers) {
    // The page goes away with its socket open: close it quietly here. The server holds the seat for the resume,
    // and no status is set, so the session (and its seat) is kept. A bfcache freeze keeps the socket.
    window.addEventListener("pagehide", (ev) => {
      if (!ev.persisted) this.leavePage();
    });
  }

  /** Drop the socket without a status change: the page is unloading. */
  private leavePage(): void {
    const ws = this.ws;
    if (ws === null) return;
    this.ws = null;
    this.stopWatch();
    this.dropRtc();
    if (ws.readyState <= WebSocket.OPEN) ws.close(1000, "bye");
  }

  get transport(): Transport {
    return this.rtc?.dc.readyState === "open" ? "udp" : "ws";
  }

  connect(url: string): void {
    this.close();
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setStatus("connecting");
    const now = performance.now();
    this.lastInbound = now;
    this.lastTick = now;
    this.connectStarted = now;
    this.pings = [];
    this.lastPing = Number.NEGATIVE_INFINITY;
    this.watch = window.setInterval(() => this.watchTick(ws), LIVE_TICK_MS);
    ws.onopen = () => {
      if (this.ws === ws) {
        this.lastInbound = performance.now();
        this.setStatus("open");
      }
    };
    ws.onmessage = (ev: MessageEvent<unknown>) => {
      if (this.ws !== ws) return;
      this.lastInbound = performance.now();
      if (typeof ev.data === "string") {
        const msg = parseServerMsg(ev.data);
        if (msg === null) return;
        if (msg.t === "welcome") this.startRtc(msg.rtc);
        if (msg.t === "rtc_answer") {
          this.applyAnswer(msg.sdp);
          return;
        }
        if (msg.t === "error" && msg.code.startsWith("rtc_")) {
          // WebRTC is optional: stay on the WebSocket without bothering the player
          this.dropRtc();
          return;
        }
        this.handlers.onMessage(msg);
      } else if (ev.data instanceof ArrayBuffer) {
        this.inBinary(new Uint8Array(ev.data));
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.stopWatch();
      this.ws = null;
      this.dropRtc();
      this.setStatus("closed", closeNotice(ev.reason, ev.wasClean), true);
    };
    ws.onerror = () => {
      // onclose follows; it carries the reason.
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Send a binary frame over the data channel if open, else the WebSocket. Both copy synchronously. */
  sendBinary(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const dc = this.rtc?.dc;
    if (dc?.readyState === "open") {
      dc.send(data as Uint8Array<ArrayBuffer>); // WASM memory is never SharedArrayBuffer
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data as Uint8Array<ArrayBuffer>); // WASM memory is never SharedArrayBuffer
    }
  }

  close(): void {
    const ws = this.ws;
    this.stopWatch();
    this.ws = null;
    this.dropRtc();
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "bye");
    if (this.status !== "closed") this.setStatus("closed");
  }

  /** The network may have changed (window online or offline): check the socket now, not after the silence limit. */
  probe(): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    this.lastInbound = Math.min(this.lastInbound, performance.now() - (SILENT_MS - PROBE_GRACE_MS));
    this.watchTick(ws);
  }

  /** Begin the WebRTC offer after `welcome`; silently does nothing when unsupported or rate-limited. */
  private startRtc(enabled: boolean): void {
    if (!enabled || typeof RTCPeerConnection === "undefined") return;
    const now = performance.now();
    if (now < this.rtcRetryAt || this.rtc) return;
    this.rtcRetryAt = now + RTC_RETRY_MS;
    let rtc: Rtc | null = null;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const dc = pc.createDataChannel("g", { ordered: false, maxRetransmits: 0 });
      dc.binaryType = "arraybuffer";
      rtc = { pc, dc };
      const cur = rtc;
      this.rtc = cur;
      dc.onmessage = (ev: MessageEvent<unknown>) => {
        if (this.rtc === cur && ev.data instanceof ArrayBuffer) this.inBinary(new Uint8Array(ev.data));
      };
      dc.onclose = () => this.dropRtc();
      dc.onerror = () => this.dropRtc();
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") this.dropRtc();
      };
      // The offer goes out only once gathering is complete: candidates are not trickled, and Firefox puts none
      // in the local description until then (Chromium has them at once), so the server could never reach the browser.
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => whenGathered(pc))
        .then(() => {
          if (this.rtc === cur && pc.localDescription) this.send({ t: "rtc_offer", sdp: pc.localDescription.sdp });
        })
        .catch(() => this.dropRtc());
    } catch {
      if (rtc) rtc.pc.close();
      this.rtc = null;
    }
  }

  private applyAnswer(sdp: string): void {
    const cur = this.rtc;
    if (!cur) return;
    try {
      cur.pc.setRemoteDescription({ type: "answer", sdp }).catch(() => this.dropRtc());
    } catch {
      this.dropRtc();
    }
  }

  /** Tear down the data channel; gameplay falls back to the WebSocket. */
  private dropRtc(): void {
    const cur = this.rtc;
    if (!cur) return;
    this.rtc = null;
    cur.dc.onmessage = null;
    cur.dc.close();
    cur.pc.close();
  }

  /** One liveness check of `ws`: the connect deadline, the silence limit, and a ping on a quiet link. */
  private watchTick(ws: WebSocket): void {
    if (this.ws !== ws) {
      this.stopWatch();
      return;
    }
    const now = performance.now();
    if (now - this.lastTick > FREEZE_MS) {
      this.lastInbound = now;
      this.connectStarted = now;
    }
    this.lastTick = now;
    if (ws.readyState === WebSocket.CONNECTING) {
      if (now - this.connectStarted > CONNECT_MS) this.abandon(ws);
      return;
    }
    const silent = now - this.lastInbound;
    if (silent >= SILENT_MS) {
      this.abandon(ws);
    } else if (ws.readyState === WebSocket.OPEN && silent >= PING_AFTER_MS && now - this.lastPing >= PING_AFTER_MS) {
      this.lastPing = now;
      this.pings = [...this.pings.slice(-7), now];
      const frame = new Uint8Array(9);
      frame[0] = C_PING;
      new DataView(frame.buffer).setFloat64(1, now, true);
      ws.send(frame);
    }
  }

  /** A binary frame from the server, over the socket or the data channel. A pong to one of our pings stops here. */
  private inBinary(data: Uint8Array): void {
    this.lastInbound = performance.now();
    if (data.byteLength >= 9 && data[0] === S_PONG) {
      const sent = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(1, true);
      const i = this.pings.indexOf(sent);
      if (i >= 0) {
        this.pings = this.pings.slice(i + 1);
        return;
      }
    }
    this.handlers.onBinary(data);
  }

  /** Give up on a socket gone quiet: its close handshake may never finish, so its handlers go and the reconnect starts now. */
  private abandon(ws: WebSocket): void {
    this.stopWatch();
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState <= WebSocket.OPEN) ws.close(1000, "bye");
    this.dropRtc();
    this.setStatus("closed", closeNotice("", false), true);
  }

  private stopWatch(): void {
    if (this.watch === null) return;
    window.clearInterval(this.watch);
    this.watch = null;
  }

  private setStatus(status: NetStatus, notice?: CloseNotice, unexpected = false): void {
    this.status = status;
    this.handlers.onStatus(status, notice, unexpected);
  }
}

/** Resolves once the connection has gathered all its candidates (with no ICE servers, that is immediate). */
function whenGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  pc.addEventListener("icegatheringstatechange", () => {
    if (pc.iceGatheringState === "complete") resolve();
  });
  return promise;
}

/** Parse one text frame: JSON whose fields the handlers read are checked (see frame-check.ts). */
function parseServerMsg(text: string): ServerMsg | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("t" in value) || typeof value.t !== "string") return null;
  return checkServerMsg(value);
}
