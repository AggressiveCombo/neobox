// Transport: JSON text frames over the WebSocket for control; binary frames for
// gameplay, sent over an optional unreliable WebRTC data channel when available.

import type { ClientMsg, ServerMsg } from "./protocol";

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
    case "too_many":
      return { label: "Too many connections", text: "Too many connections from your network.", reconnect: false };
    case "shutdown":
      return { label: "Server restarting", text: "The server is restarting. Reconnecting…", reconnect: true };
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

export class Net {
  private ws: WebSocket | null = null;
  private rtc: Rtc | null = null;
  private rtcRetryAt = 0;
  status: NetStatus = "closed";

  constructor(private readonly handlers: NetHandlers) {}

  get transport(): Transport {
    return this.rtc?.dc.readyState === "open" ? "udp" : "ws";
  }

  connect(url: string): void {
    this.close();
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => {
      if (this.ws === ws) this.setStatus("open");
    };
    ws.onmessage = (ev: MessageEvent<unknown>) => {
      if (this.ws !== ws) return;
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
        this.handlers.onBinary(new Uint8Array(ev.data));
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
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
    this.ws = null;
    this.dropRtc();
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "bye");
    if (this.status !== "closed") this.setStatus("closed");
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
        if (this.rtc === cur && ev.data instanceof ArrayBuffer) this.handlers.onBinary(new Uint8Array(ev.data));
      };
      dc.onclose = () => this.dropRtc();
      dc.onerror = () => this.dropRtc();
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") this.dropRtc();
      };
      // The server is ICE-lite with a host candidate; send the offer without waiting for gathering.
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
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

  private setStatus(status: NetStatus, notice?: CloseNotice, unexpected = false): void {
    this.status = status;
    this.handlers.onStatus(status, notice, unexpected);
  }
}

/** Parse one text frame. The server schema is trusted; only the `t` tag is checked here. */
function parseServerMsg(text: string): ServerMsg | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("t" in value) || typeof value.t !== "string") return null;
  return value as ServerMsg;
}
