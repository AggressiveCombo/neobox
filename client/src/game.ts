// The match loop: one animation frame drives the engine, sends its outgoing
// frame, and presents the built scene (renderer, overlay, sounds) and HUD.
// Ping and stats are timed from frame timestamps, so no timers need clearing.

import type { HudHandle, Present } from "./ctx";
import type { Engine } from "./engine";
import type { Scene } from "./frame";
import type { Input } from "./input";
import type { Net } from "./net";
import type { MatchStart } from "./protocol";
import type { AppState, Store } from "./state";

/** Ping frame period, ms. */
const PING_MS = 1000;
/** Stats publish period, ms. */
const STATS_MS = 250;
/** FPS measurement window, ms. */
const FPS_WINDOW_MS = 1000;
/** Longest gap between animation frames before the page counts as hidden, ms. */
const STALL_MS = 250;

export interface LoopDeps {
  engine: Engine;
  input: Input;
  net: Net;
  store: Store<AppState>;
  present: Present;
  /** The mounted HUD, or null when another screen is shown. */
  hud(): HudHandle | null;
  /** Player id to display name, for overlay labels. */
  names(): ReadonlyMap<number, string>;
  /** Called once when the engine fails; the loop has already stopped. */
  onError(message: string): void;
}

/** A decoded snapshot: the tick it was taken at, the engine state bytes and the masks players held. */
export interface SnapshotBytes {
  tick: number;
  bytes: Uint8Array;
  held: [number, number][];
}

export class MatchLoop {
  private running = false;
  private raf = 0;
  private lastPing = 0;
  private lastStats = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private fps = 0;
  private lastScene: Scene | null = null;
  private lastStep = 0;

  constructor(private readonly d: LoopDeps) {}

  /** Start the engine session (fresh, or from a snapshot) and the frame loop. Throws on engine errors. */
  begin(start: MatchStart, local: number, snap: SnapshotBytes | null): void {
    const now = performance.now();
    if (snap) this.d.engine.matchSnapshot(start, snap.held, local, snap.tick, snap.bytes, now);
    else this.d.engine.matchStart(start, local, now);
    this.lastPing = now;
    this.lastStats = now;
    this.fpsSince = now;
    this.lastStep = now;
    // a resync restarts the session while the frame chain runs: keep that one chain
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Feed one binary server frame; requests a resync when the engine asks for one. */
  onServer(bytes: Uint8Array): void {
    if (!this.running) return;
    try {
      const now = performance.now();
      if (this.d.engine.serverFrame(bytes, now)) this.d.net.send({ t: "resync" });
      // With no animation frames (hidden page) nothing else acknowledges the
      // server's ticks, and the server would resend a snapshot every few seconds.
      if (now - this.lastStep > STALL_MS) this.d.net.sendBinary(this.d.engine.frame(now, this.d.input.mask()));
    } catch (err) {
      this.fail(err);
    }
  }

  /** Stop the frame loop and end the engine session. Safe to call twice. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.d.engine.matchEnd();
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    try {
      this.step(now);
    } catch (err) {
      this.fail(err);
    }
  };

  private step(now: number): void {
    this.lastStep = now;
    const { engine, net, input } = this.d;
    net.sendBinary(engine.frame(now, input.mask()));
    this.countFrame(now);

    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      net.sendBinary(engine.ping(performance.now()));
    }

    const scene = this.d.present(this.d.names(), this.d.store.state.tickHz);
    if (scene) {
      this.lastScene = scene;
      this.d.hud()?.onFrame(scene);
    }

    if (now - this.lastStats >= STATS_MS) {
      this.lastStats = now;
      this.publishStats();
    }
  }

  private countFrame(now: number): void {
    this.fpsFrames++;
    const span = now - this.fpsSince;
    if (span < FPS_WINDOW_MS) return;
    this.fps = Math.round((this.fpsFrames * 1000) / span);
    this.fpsFrames = 0;
    this.fpsSince = now;
  }

  private publishStats(): void {
    const { store, net, engine } = this.d;
    const { state } = store;
    const me = state.room?.players.find((p) => p.id === state.myId);
    store.set({
      stats: {
        transport: net.transport,
        pingMs: me?.ping_ms ?? -1,
        rttMs: engine.rtt(),
        predDepth: this.lastScene?.predictionDepth ?? 0,
        rollbacksPerSec: this.lastScene?.rollbacksPerSec ?? 0,
        fps: this.fps,
      },
    });
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.stop();
    this.d.onError(message);
  }
}
