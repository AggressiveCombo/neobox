// Application shell: owns the services, the connection state machine and screen
// mounting. Screens render from the store; this file reacts to server messages.

import { fetchBuiltinMaps, wsUrl, type BuiltinMap } from "./api";
import { Sfx } from "./audio";
import type { AppCtx, HudHandle, ScreenFactory, ScreenHandle, WasmTools } from "./ctx";
import { Engine, loadWasmEngine, type RawEngine } from "./engine";
import { MatchLoop, type SnapshotBytes } from "./game";
import { Input } from "./input";
import { Net, type NetStatus } from "./net";
import { PROTOCOL_VERSION, type MatchStart, type RoomState, type ServerMsg } from "./protocol";
import { createRenderer, type Renderer } from "./render";
import { Overlay } from "./render/overlay";
import { CHAT_LIMIT, Store, initialState, type AppState, type ChatLine, type Screen } from "./state";
import { aboutScreen } from "./ui/screens/about";
import { browserScreen } from "./ui/screens/browser";
import { hudScreen } from "./ui/screens/hud";
import { menuScreen } from "./ui/screens/menu";
import { roomScreen } from "./ui/screens/room";
import { showToast } from "./ui/toast";

export interface StartOptions {
  /** Engine loader. Defaults to fetching `neobox.wasm`; the dev harness passes a fake. */
  loadEngine?: () => Promise<RawEngine>;
}

const SCREEN_FACTORIES: Record<Exclude<Screen, "match">, ScreenFactory> = {
  menu: menuScreen,
  about: aboutScreen,
  browse: browserScreen,
  room: roomScreen,
};

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendChat(chat: ChatLine[], line: ChatLine): ChatLine[] {
  const next = [...chat, line];
  return next.length > CHAT_LIMIT ? next.slice(next.length - CHAT_LIMIT) : next;
}

/** Decode the base64 snapshot state from a `snapshot` message. */
function decodeSnapshot(state: string): Uint8Array {
  return Uint8Array.from(atob(state), (c) => c.charCodeAt(0));
}

export function start(opts: StartOptions = {}): void {
  const store = new Store<AppState>(initialState());
  const input = new Input();
  const sfx = new Sfx();
  const overlay = new Overlay(byId<HTMLCanvasElement>("overlay"));
  const glHost = byId("gl-host");
  const uiRoot = byId("ui");
  const toastHost = byId("toasts");

  let engine: Engine | null = null;
  let renderer: Renderer | null = null;
  let rendererP: Promise<void> | null = null;
  let mapsP: Promise<BuiltinMap[]> | null = null;
  let pendingName: string | null = null;
  let mounted: Screen | null = null;
  let current: ScreenHandle | null = null;
  let hud: HudHandle | null = null;
  let loop: MatchLoop | null = null;
  let namesRoom: RoomState | null = null;
  let namesMap = new Map<number, string>();

  const toast = (text: string, kind: "info" | "error" = "info"): void => showToast(toastHost, text, kind);

  function needEngine(): Engine {
    if (!engine) throw new Error("engine not loaded");
    return engine;
  }

  const wasm: WasmTools = {
    mapPreview: (code) => needEngine().mapPreview(code),
    mapEncode: (json) => needEngine().mapEncode(json),
  };

  const net = new Net({
    onMessage: (msg) => handleServer(msg),
    onBinary: (bytes) => loop?.onServer(bytes),
    onStatus: (status, detail) => onStatus(status, detail),
  });

  const ctx: AppCtx = {
    store,
    net,
    input,
    sfx,
    wasm,
    send: (msg) => net.send(msg),
    toast,
    play,
    disconnect: () => {
      loop?.stop();
      pendingName = null;
      net.close();
      resetToMenu();
    },
    maps: () => {
      if (!mapsP) {
        mapsP = fetchBuiltinMaps().catch((err: unknown) => {
          mapsP = null;
          throw err;
        });
      }
      return mapsP;
    },
  };

  /** Mount a screen factory's output, replacing whatever is shown. */
  function mount(screen: Screen): void {
    current?.destroy();
    hud = null;
    let handle: ScreenHandle;
    if (screen === "match") {
      const h = hudScreen(ctx);
      hud = h;
      handle = h;
    } else {
      handle = SCREEN_FACTORIES[screen](ctx);
    }
    current = handle;
    mounted = screen;
    uiRoot.replaceChildren(handle.el);
  }

  store.subscribe((state, prev) => {
    if (state.screen !== mounted) mount(state.screen);
    current?.update(state, prev);
  });

  function names(): ReadonlyMap<number, string> {
    const room = store.state.room;
    if (room !== namesRoom) {
      namesRoom = room;
      namesMap = new Map((room?.players ?? []).map((p): [number, string] => [p.id, p.name]));
    }
    return namesMap;
  }

  /** Renderer creation is async (WebGPU or WebGL2 init); the loop skips drawing until it is ready. */
  function ensureRenderer(): void {
    if (renderer || rendererP) return;
    rendererP = createRenderer(glHost, onRendererLost).then(
      (r) => {
        renderer = r;
        document.documentElement.dataset.renderer = r.kind;
        resizeAll();
      },
      (err: unknown) => {
        rendererP = null;
        toast(`graphics unavailable: ${errText(err)}`, "error");
      },
    );
  }

  function onRendererLost(): void {
    renderer?.destroy();
    renderer = null;
    rendererP = null;
    toast("graphics context lost", "error");
    if (store.state.inMatch) ensureRenderer();
  }

  function resizeAll(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    renderer?.resize(w, h);
    overlay.resize(w, h);
  }

  function resetToMenu(): void {
    store.set({
      screen: "menu",
      myId: null,
      serverName: "",
      rooms: [],
      room: null,
      chat: [],
      inMatch: false,
      tickHz: 0,
      showScores: false,
    });
  }

  function leaveRoom(): void {
    loop?.stop();
    store.set({ room: null, chat: [], inMatch: false, tickHz: 0, showScores: false, screen: "browse" });
  }

  function startMatch(match: MatchStart, you: number | null, snap: SnapshotBytes | null): void {
    const eng = engine;
    if (!eng) {
      toast("engine not loaded", "error");
      return;
    }
    ensureRenderer();
    loop ??= new MatchLoop({
      engine: eng,
      input,
      net,
      sfx,
      store,
      overlay,
      renderer: () => renderer,
      hud: () => hud,
      names,
      onError: (message) => {
        toast(`match stopped: ${message}`, "error");
        store.set({ inMatch: false, tickHz: 0, screen: store.state.room ? "room" : "browse" });
      },
    });
    try {
      loop.begin(match, you ?? -1, snap);
    } catch (err) {
      toast(`match failed: ${errText(err)}`, "error");
      return;
    }
    store.set({ inMatch: true, tickHz: match.tick_hz, screen: "match", showScores: false });
  }

  function handleServer(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome":
        store.set({ serverName: msg.server, screen: "browse" });
        net.send({ t: "list_rooms" });
        return;
      case "joined":
        store.set({ myId: msg.you });
        return;
      case "error":
        toast(msg.message, "error");
        return;
      case "rooms":
        store.set({ rooms: msg.rooms });
        return;
      case "room": {
        const chat = store.state.room?.code === msg.room.code ? store.state.chat : [];
        store.set({
          room: msg.room,
          chat,
          screen: store.state.inMatch ? store.state.screen : "room",
        });
        return;
      }
      case "left":
        leaveRoom();
        net.send({ t: "list_rooms" });
        return;
      case "kicked":
        toast(`kicked: ${msg.reason}`, "error");
        leaveRoom();
        net.send({ t: "list_rooms" });
        return;
      case "chat":
        store.set({ chat: appendChat(store.state.chat, { from: msg.from, name: msg.name, text: msg.text }) });
        return;
      case "match_start":
        startMatch(msg.start, msg.you, null);
        return;
      case "snapshot":
        startMatch(msg.start, msg.you, { tick: msg.tick, bytes: decodeSnapshot(msg.state) });
        return;
      case "match_end":
        loop?.stop();
        store.set({ inMatch: false, tickHz: 0, showScores: false, screen: "room" });
        return;
      case "tick_rate":
        store.set({ tickHz: msg.tick_hz });
        return;
      case "rtc_answer":
        // Consumed by Net before it reaches the app.
        return;
    }
  }

  function onStatus(status: NetStatus, detail?: string): void {
    store.set({ connection: status, connectDetail: detail ?? "" });
    if (status === "open" && pendingName !== null) {
      net.send({ t: "hello", version: PROTOCOL_VERSION, name: pendingName });
      pendingName = null;
    }
    if (status === "closed") {
      loop?.stop();
      resetToMenu();
      if (detail) toast(detail, "error");
    }
  }

  /** Connect if needed, then say hello with `name`. The welcome message moves the app to the browser. */
  function play(name: string): void {
    store.set({ name });
    if (net.status === "open") {
      net.send({ t: "hello", version: PROTOCOL_VERSION, name });
      return;
    }
    pendingName = name;
    if (net.status === "closed") net.connect(wsUrl());
  }

  input.onKey = (code, down) => {
    if (code === "F3" && down) store.set({ showStats: !store.state.showStats });
    else if (code === "Tab") store.set({ showScores: down && store.state.inMatch });
  };

  window.addEventListener("keydown", (e) => {
    if (e.code === "F3") e.preventDefault();
  });
  window.addEventListener("pointerdown", () => sfx.unlock());
  window.addEventListener("keydown", () => sfx.unlock());
  window.addEventListener("resize", resizeAll);

  // The menu mounts immediately; the engine loads in the background.
  const load = opts.loadEngine ?? loadWasmEngine;
  load().then(
    (raw) => {
      engine = new Engine(raw);
    },
    (err: unknown) => toast(`engine failed to load: ${errText(err)}`, "error"),
  );

  mount(store.state.screen);
  const boot = document.getElementById("boot");
  if (boot) boot.hidden = true;
}
