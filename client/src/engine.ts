// Typed wrapper over the neobox WASM module (C ABI, see docs/CLIENT-API.md).
// All calls are synchronous. Byte outputs (`frame`, `ping`) are views into
// linear memory and are valid until the next engine call.

import type { MatchStart } from "./protocol";
import { fetchPrecached } from "./precached";
import { HttpError } from "./http-error";

export interface NeoboxExports {
  memory: WebAssembly.Memory;
  nb_alloc(len: number): number;
  nb_free(ptr: number, len: number): void;
  nb_error_ptr(): number;
  nb_error_len(): number;
  nb_match_start(json: number, jsonLen: number, local: number, nowMs: number): number;
  nb_match_snapshot(
    json: number,
    jsonLen: number,
    held: number,
    heldLen: number,
    local: number,
    tick: number,
    snap: number,
    snapLen: number,
    nowMs: number,
  ): number;
  nb_match_end(): void;
  nb_server_frame(ptr: number, len: number, nowMs: number): number;
  nb_frame(nowMs: number, mask: number): number;
  nb_out_ptr(): number;
  nb_frame_ptr(): number;
  nb_frame_len(): number;
  nb_ping(nowMs: number): number;
  nb_map_preview(code: number, codeLen: number): number;
  nb_map_encode(json: number, jsonLen: number): number;
  nb_rtt(): number;
  nb_net_stats(): number;
  nb_rollback_hist(): number;
  nb_hash_log(): number;
  nb_set_cap(cap: number): void;
  nb_corr_hist(): number;
  nb_stall_stats(): number;
  nb_set_trace(on: number): void;
  nb_trace(): number;
  nb_reset_stall(): void;
  nb_map_decode(code: number, codeLen: number): number;
  nb_replay_export(names: number, namesLen: number): number;
  nb_replay_clip(names: number, namesLen: number, maxSecs: number, minSecs: number): number;
  nb_replay_load(json: number, jsonLen: number): number;
  nb_replay_frame(tickF: number, follow: number): number;
  nb_replay_close(): void;
  nb_replay_build_keyframes(maxTicks: number): number;
  nb_local_start(json: number, jsonLen: number, player: number): number;
  nb_local_frame(dtMs: number, mask: number): number;
  nb_local_end(): void;
}

/** A loaded module: the exports plus the memory they operate on. */
export interface RawEngine {
  exports: NeoboxExports;
}

/** Frame buffer views over linear memory, re-created when memory grows. */
export interface FrameView {
  u32: Uint32Array;
  f32: Float32Array;
  i32: Int32Array;
  /** Length in 4-byte words. */
  words: number;
}

/** `replayFrame` result while a seek waits for keyframes (the wasm side's REPLAY_PENDING). */
const REPLAY_PENDING = -2;

export class EngineError extends Error {}

/** Stall and clock counters of a session (see `Engine.stallStats`). */
export interface StallStats {
  /** frames the prediction cap held the local head back */
  stallFrames: number;
  /** runs of consecutive stalled frames */
  stallRuns: number;
  /** longest such run, ms */
  longestStallMs: number;
  /** frames counted */
  frames: number;
  margins: number;
  staleMargins: number;
  /** stale margins more than 8 ticks off target */
  staleBig: number;
  corrections: number;
  gapResets: number;
  /** largest local-player correction of a remote rollback, world units */
  corrMax: number;
}

/** Start options of an offline game: a `MatchStart` plus its scripted training dummies. `map`, when set, is the map itself and is used instead of `maps`. */
export interface LocalStart extends MatchStart {
  dummies?: { id: number; mode: "idle" | "left_even" }[];
  map?: object;
}

export class Engine {
  readonly x: NeoboxExports;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();
  private viewBuf: ArrayBuffer | null = null;
  private viewPtr = -1;
  private viewLen = -1;
  private view: FrameView | null = null;

  constructor(raw: RawEngine) {
    this.x = raw.exports;
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.x.memory.buffer);
  }

  private lastError(): string {
    const p = this.x.nb_error_ptr();
    const n = this.x.nb_error_len();
    return this.dec.decode(this.bytes().subarray(p, p + n));
  }

  /** Copy `data` into engine memory; the caller must `free` the result. */
  private alloc(data: Uint8Array): { ptr: number; len: number } {
    const len = data.byteLength;
    const ptr = this.x.nb_alloc(len);
    this.bytes().set(data, ptr);
    return { ptr, len };
  }

  private free(b: { ptr: number; len: number }): void {
    this.x.nb_free(b.ptr, b.len);
  }

  private check(rc: number): void {
    if (rc < 0) throw new EngineError(this.lastError() || `engine error ${rc}`);
  }

  matchStart(start: MatchStart, local: number, nowMs: number): void {
    const json = this.alloc(this.enc.encode(JSON.stringify(start)));
    try {
      this.check(this.x.nb_match_start(json.ptr, json.len, local, nowMs));
    } finally {
      this.free(json);
    }
  }

  /** Join from a `snapshot` message; `held` is its `held` array. */
  matchSnapshot(start: MatchStart, held: [number, number][], local: number, tick: number, snap: Uint8Array, nowMs: number): void {
    const json = this.alloc(this.enc.encode(JSON.stringify(start)));
    const h = this.alloc(this.enc.encode(JSON.stringify(held)));
    const s = this.alloc(snap);
    try {
      this.check(this.x.nb_match_snapshot(json.ptr, json.len, h.ptr, h.len, local, tick, s.ptr, s.len, nowMs));
    } finally {
      this.free(json);
      this.free(h);
      this.free(s);
    }
  }

  matchEnd(): void {
    this.x.nb_match_end();
  }

  /** Feed one binary server frame received at `nowMs` (performance.now()). Returns true when a resync must be requested. */
  serverFrame(data: Uint8Array, nowMs: number): boolean {
    const b = this.alloc(data);
    try {
      const rc = this.x.nb_server_frame(b.ptr, b.len, nowMs);
      if (rc < 0) throw new EngineError(this.lastError() || "server frame rejected");
      return rc === 1;
    } finally {
      this.free(b);
    }
  }

  /** Advance one step; returns the outgoing binary frame (empty = nothing to send). */
  frame(nowMs: number, mask: number): Uint8Array {
    const n = this.x.nb_frame(nowMs, mask);
    return n > 0 ? this.outView(n) : EMPTY;
  }

  ping(nowMs: number): Uint8Array {
    return this.outView(this.x.nb_ping(nowMs));
  }

  rtt(): number {
    return this.x.nb_rtt();
  }

  /** Desync reason and p95 rollback depth of the current session (see `nb_net_stats`). */
  netStats(): { kind: number; a: number; b: number; rollbackP95: number } {
    const n = this.x.nb_net_stats();
    if (n < 16) return { kind: 0, a: 0, b: 0, rollbackP95: 0 };
    const w = new Uint32Array(this.x.memory.buffer.slice(this.x.nb_out_ptr(), this.x.nb_out_ptr() + 16));
    return { kind: w[0], a: w[1], b: w[2], rollbackP95: w[3] };
  }

  /** Rollback depth histogram since the depth warm-up: bin i counts depth i ticks, the last bin deeper ones. */
  rollbackHist(): number[] {
    return this.bins(this.x.nb_rollback_hist());
  }

  /** Local-player correction histogram (see `nb_corr_hist`): bin i counts remote rollbacks moving it i/2 to (i+1)/2 units. */
  correctionHist(): number[] {
    return this.bins(this.x.nb_corr_hist());
  }

  private bins(n: number): number[] {
    if (n === 0) return [];
    return Array.from(new BigUint64Array(this.x.memory.buffer.slice(this.x.nb_out_ptr(), this.x.nb_out_ptr() + n)), Number);
  }

  /** Client state hashes at every confirmed tick that is a multiple of 60: tick and hash (16 hex digits). */
  hashLog(): { tick: number; hash: string }[] {
    const n = this.x.nb_hash_log();
    const out: { tick: number; hash: string }[] = [];
    if (n === 0) return out;
    const dv = new DataView(this.x.memory.buffer.slice(this.x.nb_out_ptr(), this.x.nb_out_ptr() + n));
    for (let i = 0; i + 12 <= n; i += 12) {
      out.push({ tick: dv.getUint32(i, true), hash: dv.getBigUint64(i + 4, true).toString(16).padStart(16, "0") });
    }
    return out;
  }

  /** Prediction cap (ticks) of the session; applies now and to later sessions. */
  setPredictionCap(cap: number): void {
    this.x.nb_set_cap(cap);
  }

  /** Stall and clock counters since the depth warm-up (see `nb_stall_stats`); null without a session. */
  stallStats(): StallStats | null {
    const n = this.x.nb_stall_stats();
    if (n < 40) return null;
    const dv = new DataView(this.x.memory.buffer.slice(this.x.nb_out_ptr(), this.x.nb_out_ptr() + n));
    const u = (i: number) => dv.getUint32(i * 4, true);
    return {
      stallFrames: u(0),
      stallRuns: u(1),
      longestStallMs: u(2),
      frames: u(3),
      margins: u(4),
      staleMargins: u(5),
      staleBig: u(6),
      corrections: u(7),
      gapResets: u(8),
      corrMax: dv.getFloat32(36, true),
    };
  }

  /** Per-frame trace rows since the last call, 9 floats each (see `nb_trace`). */
  takeTrace(): Float32Array {
    const n = this.x.nb_trace();
    if (n === 0) return new Float32Array(0);
    return new Float32Array(this.x.memory.buffer.slice(this.x.nb_out_ptr(), this.x.nb_out_ptr() + n));
  }

  /** Starts (true) or stops per-frame tracing; starting clears the trace. */
  setTrace(on: boolean): void {
    this.x.nb_set_trace(on ? 1 : 0);
  }

  /** Resets the stall and clock counters for the play window (see `nb_reset_stall`). */
  resetStall(): void {
    this.x.nb_reset_stall();
  }

  private outView(n: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.nb_out_ptr(), n);
  }

  /** Current frame buffer (valid after `frame`/`mapPreview`), or null when empty. */
  framebuffer(): FrameView | null {
    const ptr = this.x.nb_frame_ptr();
    const len = this.x.nb_frame_len();
    if (len < 4) return null;
    const buf = this.x.memory.buffer;
    if (this.view === null || this.viewBuf !== buf || this.viewPtr !== ptr || this.viewLen !== len) {
      const words = len >>> 2;
      this.view = {
        u32: new Uint32Array(buf, ptr, words),
        f32: new Float32Array(buf, ptr, words),
        i32: new Int32Array(buf, ptr, words),
        words,
      };
      this.viewBuf = buf;
      this.viewPtr = ptr;
      this.viewLen = len;
    }
    return this.view;
  }

  /** Build the lobby layout of a map code. Throws with the engine's message on failure. */
  mapPreview(code: string): FrameView {
    const b = this.alloc(this.enc.encode(code));
    try {
      this.check(this.x.nb_map_preview(b.ptr, b.len));
    } finally {
      this.free(b);
    }
    const fb = this.framebuffer();
    if (!fb) throw new EngineError("empty map preview");
    return fb;
  }

  /** Compact map JSON into a map code. */
  mapEncode(json: string): string {
    return this.textCall(json, (p, n) => this.x.nb_map_encode(p, n));
  }

  /** Map code into its compact JSON text (what the editor edits). */
  mapDecode(code: string): string {
    return this.textCall(code, (p, n) => this.x.nb_map_decode(p, n));
  }

  /**
   * The recording of the current or last online match as replay JSON, or
   * null when nothing was recorded. `names`: [player id, name] pairs.
   */
  replayExport(names: [number, string][]): string | null {
    const text = this.textCall(JSON.stringify(names), (p, n) => this.x.nb_replay_export(p, n));
    return text === "" ? null : text;
  }

  /**
   * The last `maxSecs` (at least `minSecs`) of the current or last online match as clip replay
   * JSON, starting from a state snapshot. Null when the recording is too short or empty.
   */
  replayClip(names: [number, string][], maxSecs: number, minSecs: number): string | null {
    const text = this.textCall(JSON.stringify(names), (p, n) => this.x.nb_replay_clip(p, n, maxSecs, minSecs));
    return text === "" ? null : text;
  }

  /** Load a replay (decompressed JSON text) for watching. */
  replayLoad(json: string): ReplayInfo {
    return JSON.parse(this.textCall(json, (p, n) => this.x.nb_replay_load(p, n))) as ReplayInfo;
  }

  /** Build the replay frame at fractional tick `tickF`, following player `follow` (-1 none). Returns the tick shown, or null while a seek waits for keyframes (the previous frame stays). */
  replayFrame(tickF: number, follow: number): number | null {
    const rc = this.x.nb_replay_frame(tickF, follow);
    if (rc === REPLAY_PENDING) return null;
    this.check(rc);
    return rc;
  }

  replayClose(): void {
    this.x.nb_replay_close();
  }

  /** Simulate up to `maxTicks` more ticks into the loaded replay's seek keyframes. `done` once all are built and checked; `failed` once a checkpoint failed its check (the seek data is dropped). */
  replayBuildKeyframes(maxTicks: number): { done: boolean; failed: boolean } {
    const rc = this.x.nb_replay_build_keyframes(maxTicks);
    this.check(rc);
    return { done: (rc & 1) === 1, failed: (rc & 2) === 2 };
  }

  /** Start an offline game (practice, training, editor test-play) as player `player` of `start.players`. */
  localStart(start: LocalStart, player: number): void {
    const b = this.alloc(this.enc.encode(JSON.stringify(start)));
    try {
      this.check(this.x.nb_local_start(b.ptr, b.len, player));
    } finally {
      this.free(b);
    }
  }

  /** Advance the offline game by `dtMs` with input `mask` and build its frame; true once the game is over. */
  localFrame(dtMs: number, mask: number): boolean {
    const rc = this.x.nb_local_frame(dtMs, mask);
    this.check(rc);
    return rc === 1;
  }

  localEnd(): void {
    this.x.nb_local_end();
  }

  /** Pass `text` in, read the text result at nb_out_ptr (the export returns its length or < 0). */
  private textCall(text: string, call: (ptr: number, len: number) => number): string {
    const b = this.alloc(this.enc.encode(text));
    try {
      const n = call(b.ptr, b.len);
      this.check(n);
      return this.dec.decode(this.bytes().subarray(this.x.nb_out_ptr(), this.x.nb_out_ptr() + n));
    } finally {
      this.free(b);
    }
  }
}

/** Summary of a loaded replay. */
export interface ReplayInfo {
  /** First and one-past-last tick. */
  first: number;
  end: number;
  hz: number;
  names: [number, string][];
  /** [player id, team] at the start of the match. */
  players: [number, number][];
}

const EMPTY = new Uint8Array(0);

/**
 * Load the production module from `neobox.wasm` at the site root. `onProgress` gets the bytes
 * received so far and the total (0 when unknown: compressed responses carry no usable length).
 */
export async function loadWasmEngine(url = "/neobox.wasm", onProgress?: (loaded: number, total: number) => void): Promise<RawEngine> {
  const imports: WebAssembly.Imports = {};
  const { instance } = await WebAssembly.instantiate(await readWasm(url, onProgress), imports);
  // The export set is the ABI of docs/CLIENT-API.md; the memory check above guards the
  // only property read here, and a missing function fails at its first call.
  const api: NeoboxExports = instance.exports as unknown as NeoboxExports;
  if (!(api.memory instanceof WebAssembly.Memory)) throw new EngineError("neobox.wasm has no memory export");
  return { exports: api };
}

/**
 * The module bytes, counting each chunk as it arrives. Compiles from the bytes, not a Response
 * rebuilt around a piped stream: Firefox logs "microtasks reordered" when instantiateStreaming
 * consumes such a Response.
 */
async function readWasm(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetchPrecached(url);
  if (!res.ok) throw new EngineError(new HttpError(res.status).message);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const total = res.headers.get("content-encoding") ? 0 : Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
