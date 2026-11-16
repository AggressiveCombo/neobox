// Typed wrapper over the neobox WASM module (C ABI, see docs/CLIENT-API.md).
// All calls are synchronous. Byte outputs (`frame`, `ping`) are views into
// linear memory and are valid until the next engine call.

import type { MatchStart } from "./protocol";

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
  nb_map_decode(code: number, codeLen: number): number;
  nb_replay_export(names: number, namesLen: number): number;
  nb_replay_clip(names: number, namesLen: number, maxSecs: number, minSecs: number): number;
  nb_replay_load(json: number, jsonLen: number): number;
  nb_replay_frame(tickF: number, follow: number): number;
  nb_replay_close(): void;
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

export class EngineError extends Error {}

/** Start options of an offline game: a `MatchStart` plus its scripted training dummies. */
export interface LocalStart extends MatchStart {
  dummies?: { id: number; mode: "idle" | "left_even" }[];
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

  /** Build the replay frame at fractional tick `tickF`, following player `follow` (-1 none). */
  replayFrame(tickF: number, follow: number): void {
    this.check(this.x.nb_replay_frame(tickF, follow));
  }

  replayClose(): void {
    this.x.nb_replay_close();
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

/** Load the production module from `neobox.wasm` next to the page. */
export async function loadWasmEngine(url = "./neobox.wasm"): Promise<RawEngine> {
  const imports: WebAssembly.Imports = {};
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), imports));
  } catch {
    const bytes = await (await fetch(url)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, imports));
  }
  // The export set is the ABI of docs/CLIENT-API.md; the memory check above guards the
  // only property read here, and a missing function fails at its first call.
  const api: NeoboxExports = instance.exports as unknown as NeoboxExports;
  if (!(api.memory instanceof WebAssembly.Memory)) throw new EngineError("neobox.wasm has no memory export");
  return { exports: api };
}
