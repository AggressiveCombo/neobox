// The match loop: one animation frame drives the engine, sends its outgoing
// frame, and hands the built scene to the renderer, overlay, sounds and HUD.
// Ping and stats are timed from frame timestamps, so no timers need clearing.

import { computeCamera, findLocal } from "./camera";
import type { Sfx } from "./audio";
import type { HudHandle } from "./ctx";
import type { Engine } from "./engine";
import { readScene, type Scene } from "./frame";
import type { Input } from "./input";
import type { Net } from "./net";
import type { MatchStart } from "./protocol";
import type { Renderer } from "./render";
import type { Overlay } from "./render/overlay";
import type { AppState, Store } from "./state";

/** Ping frame period, ms. */
const PING_MS = 1000;
/** Stats publish period, ms. */
const STATS_MS = 250;
/** FPS measurement window, ms. */
const FPS_WINDOW_MS = 1000;

export interface LoopDeps {
  engine: Engine;
  input: Input;
  net: Net;
  sfx: Sfx;
  store: Store<AppState>;
  overlay: Overlay;
  /** The renderer, or null while it is still starting (the match is simulated, not drawn). */
  renderer(): Renderer | null;
  /** The mounted HUD, or null when another screen is shown. */
  hud(): HudHandle | null;
  /** Player id to display name, for overlay labels. */
  names(): ReadonlyMap<number, string>;
  /** Called once when the engine fails; the loop has already stopped. */
  onError(message: string): void;
}

/** A decoded snapshot: the tick it was taken at and the engine state bytes. */
export interface SnapshotBytes {
  tick: number;
  bytes: Uint8Array;
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

  constructor(private readonly d: LoopDeps) {}

  /** Start the engine session (fresh, or from a snapshot) and the frame loop. Throws on engine errors. */
  begin(start: MatchStart, local: number, snap: SnapshotBytes | null): void {
    const now = performance.now();
    if (snap) this.d.engine.matchSnapshot(start, local, snap.tick, snap.bytes, now);
    else this.d.engine.matchStart(start, local, now);
    this.running = true;
    this.lastPing = now;
    this.lastStats = now;
    this.fpsSince = now;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Feed one binary server frame; requests a resync when the engine asks for one. */
  onServer(bytes: Uint8Array): void {
    if (!this.running) return;
    try {
      if (this.d.engine.serverFrame(bytes)) this.d.net.send({ t: "resync" });
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
    const { engine, net, input } = this.d;
    net.sendBinary(engine.frame(now, input.mask()));
    this.countFrame(now);

    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      net.sendBinary(engine.ping(now));
    }

    const fb = engine.framebuffer();
    if (fb) {
      const scene = readScene(fb);
      this.lastScene = scene;
      const cam = computeCamera(scene, window.innerWidth, window.innerHeight, findLocal(scene));
      this.d.renderer()?.draw(scene, cam);
      this.d.overlay.draw(scene, cam, this.d.names(), this.d.store.state.tickHz);
      for (const s of scene.sounds) this.d.sfx.play(s.kind, s.volume);
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
