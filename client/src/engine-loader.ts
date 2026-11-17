// The wasm engine, loaded in the background and shared by every screen that needs it. Its state
// is observable, so a screen can show the download's progress, the failure and a retry.

import { Engine, loadWasmEngine } from "./engine";

// build.ts defines WASM_VERSION (a hash of neobox.wasm). The query names this build's copy, so a service worker
// from an older build, which caches the bare name, cannot answer with the previous engine.
declare const WASM_VERSION: string | undefined;
const WASM_URL = typeof WASM_VERSION === "string" && WASM_VERSION ? `/neobox.wasm?v=${WASM_VERSION}` : "/neobox.wasm";

export type EngineState =
  | { status: "loading"; loaded: number; total: number }
  | { status: "ready"; engine: Engine }
  | { status: "failed"; error: string };

class EngineLoader {
  private current: EngineState = { status: "loading", loaded: 0, total: 0 };
  private attempt: Promise<Engine> | null = null;
  private readonly listeners = new Set<(state: EngineState) => void>();

  get state(): EngineState {
    return this.current;
  }

  /** The engine once loaded (null before that or after a failure). */
  get ready(): Engine | null {
    return this.current.status === "ready" ? this.current.engine : null;
  }

  /** The loaded engine. Starts a load when none is running, so a call after a failure tries again. */
  get(): Promise<Engine> {
    this.attempt ??= this.load();
    return this.attempt;
  }

  /** Try again after a failure. Does nothing while loading or once loaded. */
  retry(): void {
    if (this.current.status === "failed") this.get().catch(() => {});
  }

  /** Call `fn` on every state change; returns the unsubscribe function. */
  subscribe(fn: (state: EngineState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(state: EngineState): void {
    this.current = state;
    for (const fn of this.listeners) fn(state);
  }

  private load(): Promise<Engine> {
    this.set({ status: "loading", loaded: 0, total: 0 });
    return loadWasmEngine(WASM_URL, (loaded, total) => this.set({ status: "loading", loaded, total })).then(
      (raw) => {
        const engine = new Engine(raw);
        this.set({ status: "ready", engine });
        return engine;
      },
      (err: unknown) => {
        this.attempt = null;
        this.set({ status: "failed", error: err instanceof Error ? err.message : String(err) });
        throw err;
      },
    );
  }
}

export const engineLoader = new EngineLoader();
