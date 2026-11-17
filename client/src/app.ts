// Application shell: owns the services, the connection state machine and screen
// mounting. Screens render from the store; this file reacts to server messages.

import { fetchBuiltinMaps, fetchTicket, wsUrl, wsUrlFor, type BuiltinMap } from "./api";
import { sfx } from "./audio";
import { computeCamera, coverCamera, fitView, findLocal, publishView } from "./camera";
import type { AppCtx, HudHandle, Present, ScreenFactory, ScreenHandle, WasmTools } from "./ctx";
import type { Engine } from "./engine";
import { engineLoader } from "./engine-loader";
import { readScene } from "./frame";
import { MatchLoop, type SnapshotBytes } from "./game";
import { Input } from "./input";
import { Net, type CloseNotice, type NetStatus } from "./net";
import { NAME_RE, PROTOCOL_VERSION, type ClientMsg, type MatchStart, type RoomState, type ServerMsg } from "./protocol";
import { createRenderer, type Renderer } from "./render";
import { Overlay } from "./render/overlay";
import { CHAT_LIMIT, Store, initialState, type AppState, type ChatLine, type Screen } from "./state";
import { NAME_STORAGE_KEY, SEAT_STORAGE_KEY } from "./storage-keys";
import { local, session } from "./storage";
import { aboutScreen } from "./ui/screens/about";
import { browserScreen } from "./ui/screens/browser";
import { hudScreen } from "./ui/screens/hud";
import { guestName, menuScreen } from "./ui/screens/menu";
import { roomScreen } from "./ui/screens/room";
import { practiceScreen } from "./ui/screens/practice";
import { settingsScreen } from "./ui/screens/settings";
import { replayScreen } from "./ui/screens/replay";
import { startAccountSync } from "./account";
import { accountScreen } from "./ui/screens/account";
import { friendsScreen } from "./ui/screens/friends";
import { libraryScreen } from "./ui/screens/library";
import { editorScreen } from "./ui/screens/editor";
import { quickScreen } from "./ui/screens/quick";
import { trainingScreen } from "./ui/screens/training";
import { privacyScreen } from "./ui/screens/privacy";
import { mountJukebox } from "./ui/jukebox";
import { showPostGame } from "./ui/postgame";
import { prefs } from "./prefs";
import { music } from "./music";
import type { XpAward } from "./protocol";
import { h } from "./ui/dom";
import { closeModalsAbove, modalPopPending, openModal, takeModalPop } from "./ui/kit";
import { needsServer, offlinePage } from "./ui/offline-page";
import { showToast } from "./ui/toast";
import { playScreenTransition } from "./ui/transition";

const SCREEN_FACTORIES: Record<Exclude<Screen, "match">, ScreenFactory> = {
  menu: menuScreen,
  about: aboutScreen,
  privacy: privacyScreen,
  browse: browserScreen,
  quick: quickScreen,
  room: roomScreen,
  replay: replayScreen,
  settings: settingsScreen,
  practice: practiceScreen,
  training: trainingScreen,
  account: accountScreen,
  friends: friendsScreen,
  library: libraryScreen,
  editor: editorScreen,
};

/** Screens without menu music. */
const GAME_SCREENS: Partial<Record<Screen, true>> = { room: true, match: true, training: true, practice: true, replay: true, editor: true };

/** The game view hides after this long without a drawn frame. */
const VIEW_IDLE_MS = 250;

/** Room codes: 6 characters from the server's alphabet (no I, O, 0 or 1). */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
/** Delays before each reconnect attempt after an unexpected drop; the last one repeats. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
/** Stop retrying this long after the first drop. */
const RECONNECT_GIVE_UP_MS = 60_000;

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

/** A room code given as `/CODE` or `?room=CODE` (invite links), or null. */
function inviteFromUrl(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("room");
  const fromPath = location.pathname.replace(/^\/+|\/+$/g, "");
  const code = (fromQuery ?? fromPath).trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** A history entry: the screen it shows, the screen it was entered from, and the modal it opened, if any. */
interface NavState {
  screen: Screen;
  prev: Screen | null;
  modal?: string;
}

/** The room's screens: the room, its match, and the map editor the host opened from the room. */
function inRoomScreen(screen: Screen, editorForRoom: boolean): boolean {
  return screen === "room" || screen === "match" || (screen === "editor" && editorForRoom);
}

export function start(): Store<AppState> {
  const store = new Store<AppState>(initialState());
  const input = new Input();
  const overlay = new Overlay(byId<HTMLCanvasElement>("overlay"));
  const glHost = byId("gl-host");
  const uiRoot = byId("ui");
  const toastHost = byId("toasts");

  let engine: Engine | null = null;
  let renderer: Renderer | null = null;
  let rendererP: Promise<void> | null = null;
  /** Set once the game could not be drawn: no further attempts. The dialog says so once; game screens entered later toast it. */
  let rendererFailed = false;
  /** The failure has been said on the current screen (ensureRenderer); reset on every screen change. */
  let failureSaid = false;
  let mapsP: Promise<BuiltinMap[]> | null = null;
  let pendingName: string | null = null;
  /** Room to join once the server has welcomed us (invite links, friends). */
  let pendingJoin: string | null = null;
  /** The room we are in and its resume token (from `joined`); kept across a dropped connection. */
  let roomCode: string | null = null;
  let resumeToken: string | null = null;
  /** The room of the last join_room we sent: a refused join names the room that needs a password. */
  let joinAttempt: string | null = null;
  /**
   * Quick-play rooms this page has been in, never offered again (the original's `excludeaddresses`),
   * and the mode being matched while quick play looks for a room.
   */
  const quickVisited = new Set<string>();
  let matching: string | null = null;
  /** A resume join is in flight after a reconnect. */
  let resuming = false;
  /** Base URL of the game server this connection is on; null = the home server (the page's own origin). */
  let server: string | null = null;
  /** Message to send once the server we were redirected to has welcomed us (the redirect's `then`). */
  let pendingThen: ClientMsg | null = null;
  /** Bumped whenever the connection changes, so an async hello from the old connection is dropped. */
  let linkSeq = 0;
  /** Set while the app itself closes and reopens the socket: that close is not a lost connection. */
  let switching = false;
  /** Callers of ctx.roomMap() waiting for the server's `map_code`. */
  const mapWaiters: ((map: { code: string; name: string }) => void)[] = [];
  let reconnectTimer: number | null = null;
  let reconnectSince = 0;
  let reconnectAttempt = 0;
  let mounted: Screen | null = null;
  /** The shown page is the offline page in place of a server screen. */
  let offlineShown = false;
  let current: ScreenHandle | null = null;
  let hud: HudHandle | null = null;
  let loop: MatchLoop | null = null;
  /** A match whose start arrived while the engine still loads (a reload resumes its match during the download). */
  let pendingMatch: { match: MatchStart; you: number | null; snap: SnapshotBytes | null; frames: Uint8Array[] } | null = null;
  /** Binary frames kept for a pending match; past this cap the gap they leave makes the engine ask for a resync. */
  const PENDING_FRAMES_MAX = 600;
  let namesRoom: RoomState | null = null;
  let namesMap = new Map<number, string>();

  const toast = (text: string, kind: "info" | "error" = "info"): void => showToast(toastHost, text, kind);

  function needEngine(): Engine {
    if (!engine) throw new Error("engine not loaded");
    return engine;
  }

  // The menu mounts immediately; the engine loads in the background and screens that need it show its progress.
  engineLoader.subscribe((state) => {
    if (state.status !== "ready") return;
    engine = state.engine;
    const pending = pendingMatch;
    if (pending === null) return;
    pendingMatch = null;
    startMatch(pending.match, pending.you, pending.snap);
    for (const frame of pending.frames) loop?.onServer(frame);
  });
  // Screens that need the engine show its failure inline with Retry, so the background load reports nothing itself.
  engineLoader.get().catch(() => {});

  /** When the game view was last drawn; the view hides once nothing has drawn it for a moment. */
  let lastPresent = 0;
  let viewShown = true;
  /** The main menu's clip covers the whole window (its square is turned); game screens use the view rect. */
  let backdrop = false;
  const overlayCanvas = byId("overlay");
  const setViewShown = (shown: boolean): void => {
    if (shown === viewShown) return;
    viewShown = shown;
    glHost.style.visibility = shown ? "" : "hidden";
    overlayCanvas.style.visibility = shown ? "" : "hidden";
  };
  // Screens that stop drawing (a match ends, a menu clip is unmounted) must not leave
  // their last frame behind the next screen.
  window.setInterval(() => {
    if (performance.now() - lastPresent > VIEW_IDLE_MS) setViewShown(false);
  }, VIEW_IDLE_MS);

  /** Draw the engine's current frame buffer (built by a match, replay or local game). */
  const present: Present = (names, tickHz, chrome = true) => {
    const fb = engine?.framebuffer();
    if (!fb) return null;
    ensureRenderer();
    const scene = readScene(fb);
    scene.localKeys = input.mask();
    const local = computeCamera(scene, findLocal(scene));
    const cam = backdrop ? coverCamera(scene, local, window.innerWidth / window.innerHeight) : local;
    renderer?.draw(scene, cam);
    overlay.draw(scene, cam, names, tickHz, chrome);
    lastPresent = performance.now();
    setViewShown(true);
    for (const s of scene.sounds) sfx.play(s.kind, s.volume, (s.x - cam.cx) / (cam.w / 2));
    return scene;
  };

  const wasm: WasmTools = {
    mapPreview: (code) => needEngine().mapPreview(code),
    mapEncode: (json) => needEngine().mapEncode(json),
  };

  const net = new Net({
    onMessage: (msg) => handleServer(msg),
    onBinary: (bytes) => {
      if (pendingMatch === null) loop?.onServer(bytes);
      else if (pendingMatch.frames.length < PENDING_FRAMES_MAX) pendingMatch.frames.push(bytes);
    },
    onStatus: (status, notice, unexpected) => onStatus(status, notice, unexpected ?? false),
  });

  const ctx: AppCtx = {
    store,
    net,
    input,
    sfx,
    wasm,
    engine: () => engineLoader.get(),
    present,
    send: (msg) => {
      if (msg.t === "join_room") joinAttempt = msg.room;
      net.send(msg);
    },
    toast,
    play,
    joinRoom,
    quickPlay,
    disconnect,
    roomMap: () => {
      const { promise, resolve, reject } = Promise.withResolvers<{ code: string; name: string }>();
      if (store.state.room === null || net.status !== "open") {
        reject(new Error("not in a room"));
        return promise;
      }
      const waiter = (map: { code: string; name: string }): void => {
        window.clearTimeout(timer);
        resolve(map);
      };
      const timer = window.setTimeout(() => {
        const i = mapWaiters.indexOf(waiter);
        if (i >= 0) mapWaiters.splice(i, 1);
        reject(new Error("the server did not send the map"));
      }, 5000);
      mapWaiters.push(waiter);
      net.send({ t: "get_map" });
      return promise;
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
    reserveTop: (bar) => {
      const update = (): void => {
        overlay.topInset = bar.getBoundingClientRect().bottom;
      };
      const ro = new ResizeObserver(update);
      ro.observe(bar);
      window.addEventListener("resize", update);
      update();
      const releaseBar = overlay.reserve(bar);
      return () => {
        releaseBar();
        ro.disconnect();
        window.removeEventListener("resize", update);
        overlay.topInset = 0;
      };
    },
    reserveChrome: (bar) => overlay.reserve(bar),
  };

  // A signed-in player joins under the account's name, so the invite waits for the account lookup.
  const invite = inviteFromUrl();
  startAccountSync(ctx, () => {
    if (invite !== null) joinRoom(invite);
  });
  mountJukebox(ctx);

  // The appearance colour follows the preference into the room.
  prefs.subscribe((next, prev) => {
    if (next.color !== prev.color && next.color !== null && net.status === "open" && store.state.serverName !== "") {
      net.send({ t: "set_color", color: next.color });
    }
  });

  /** Mount a screen factory's output, replacing whatever is shown. */
  function mount(screen: Screen): void {
    current?.destroy();
    hud = null;
    offlineShown = needsServer(screen) && !navigator.onLine;
    let handle: ScreenHandle;
    if (screen === "match") {
      const hudHandle = hudScreen(ctx);
      hud = hudHandle;
      handle = hudHandle;
    } else {
      handle = offlineShown ? offlinePage(ctx, screen) : SCREEN_FACTORIES[screen](ctx);
    }
    const from = mounted;
    const leaving = current?.el ?? null;
    const scrollTop = uiRoot.scrollTop;
    current = handle;
    mounted = screen;
    const wasBackdrop = backdrop;
    backdrop = screen === "menu";
    if (backdrop !== wasBackdrop) resizeAll();
    uiRoot.replaceChildren(handle.el);
    // Pages never draw the game view: hide it now, not after the idle timeout, so the
    // last frame does not show through the page sliding in.
    if (!GAME_SCREENS[screen] && screen !== "menu") setViewShown(false);
    if (from !== null) playScreenTransition(uiRoot, leaving, handle.el, scrollTop);
  }

  store.subscribe((state, prev) => {
    if (state.screen !== mounted) mount(state.screen);
    current?.update(state, prev);
  });

  // The main menu plays its track; a match plays the in-match playlist; the other
  // game screens (rooms, training, practice, replays, editor) are silent.
  const syncMusic = (screen: Screen): void => {
    music.setScene(screen === "match" ? "match" : GAME_SCREENS[screen] ? null : "menu");
  };
  syncMusic(store.state.screen);
  store.subscribe((state, prev) => {
    if (state.screen !== prev.screen) syncMusic(state.screen);
  });

  // The post-game panel opens once per custom-match award, over the room
  // (the award arrives just before the match ends). Quick-play awards are
  // shown and cleared by the match HUD.
  let shownAward: XpAward | null = null;
  let closePostGame: (() => void) | null = null;
  store.subscribe((state) => {
    const award = state.xp;
    if (award === null) {
      closePostGame?.();
      closePostGame = null;
      return;
    }
    if (award.quick || award === shownAward || state.screen !== "room") return;
    shownAward = award;
    // Opened once this change settles: a modal pushes a history entry, and the nav subscriber (which runs after this one)
    // must first write this change's screen entry, or it would take the new modal for a takeover and close it at once.
    queueMicrotask(() => {
      if (store.state.xp !== award || store.state.screen !== "room") return;
      closePostGame = showPostGame(ctx, award, store.state.room?.map ?? null);
    });
  });

  // Shown over every screen while the connection to a room is being restored.
  const banner = h(
    "div",
    { class: "reconnect-banner", role: "status", "aria-live": "polite" },
    h("span", null, "Connection lost. Reconnecting…"),
    h("button", { type: "button", onclick: () => disconnect() }, "Leave"),
  );
  banner.hidden = true;
  document.body.prepend(banner);
  store.subscribe((state) => {
    banner.hidden = !state.reconnecting;
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
    if (rendererFailed) {
      // Drawn frames would be empty: say so on the first call on each screen (the dialog covered the first failure).
      if (!failureSaid) {
        failureSaid = true;
        toast("This browser cannot draw the game: WebGPU and WebGL 2 are unavailable.", "error");
      }
      return;
    }
    rendererP = createRenderer(glHost, onRendererLost).then(
      (r) => {
        renderer = r;
        document.documentElement.dataset.renderer = r.kind;
        resizeAll();
      },
      (err: unknown) => {
        rendererP = null;
        graphicsFailed(errText(err));
      },
    );
  }

  /**
   * Neither WebGPU nor WebGL 2 is available, so the game cannot be drawn. Say so once, in a dialog, rather than
   * on every frame. Back leaves the game screen for the nearest one that needs no graphics.
   */
  function graphicsFailed(detail: string): void {
    rendererFailed = true;
    failureSaid = true;
    let m: { close(): void } | null = null;
    const back = h(
      "button",
      {
        type: "button",
        onclick: () => {
          loop?.stop();
          store.set({
            inMatch: false,
            tickHz: 0,
            showScores: false,
            screen: store.state.room ? "room" : store.state.serverName ? "browse" : "menu",
          });
          m?.close();
        },
      },
      "Back",
    );
    m = openModal({
      title: "This browser cannot draw the game",
      body: [
        h("p", null, `Neobox draws with WebGPU or WebGL 2, and this browser offers neither (${detail}).`),
        h("p", null, "Turn on hardware acceleration in the browser's settings and reload, or open the game in another browser."),
      ],
      actions: [back],
    });
  }

  store.subscribe((state, prev) => {
    if (state.screen !== prev.screen) failureSaid = false;
  });

  function onRendererLost(): void {
    renderer?.destroy();
    renderer = null;
    rendererP = null;
    toast("graphics context lost", "error");
    if (store.state.inMatch) ensureRenderer();
  }

  /** Size the game canvases to the view rect (the original's aspect, centred in the window) and publish it. */
  function resizeAll(): void {
    const view = backdrop ? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight } : fitView(window.innerWidth, window.innerHeight);
    publishView(view);
    overlay.setView(view);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(view.w * dpr);
    const hPx = Math.round(view.h * dpr);
    renderer?.resize(w, hPx);
    overlay.resize(w, hPx);
  }

  /** This tab's seat, kept in sessionStorage so a page reload rejoins the same slot on the same server. */
  function saveSeat(): void {
    try {
      if (roomCode !== null && resumeToken !== null) {
        session.setItem(SEAT_STORAGE_KEY, JSON.stringify({ room: roomCode, token: resumeToken, server }));
      } else {
        session.removeItem(SEAT_STORAGE_KEY);
      }
    } catch {
      // Storage blocked: a reload joins as a new player.
    }
  }

  /** This tab's seat in `room` (resume token and the server it is on), if any. */
  function seat(room: string): { token: string; server: string | null } | null {
    try {
      const saved: unknown = JSON.parse(session.getItem(SEAT_STORAGE_KEY) ?? "null");
      if (typeof saved !== "object" || saved === null || !("room" in saved) || !("token" in saved)) return null;
      if (saved.room !== room || typeof saved.token !== "string") return null;
      return { token: saved.token, server: "server" in saved && typeof saved.server === "string" ? saved.server : null };
    } catch {
      return null;
    }
  }

  /** Back to the main menu, forgetting the room and any reconnect in progress. */
  function resetToMenu(): void {
    stopReconnect();
    pendingMatch = null;
    roomCode = null;
    resumeToken = null;
    server = null;
    pendingThen = null;
    saveSeat();
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
      replayReady: false,
      intent: null,
      invite: null,
      xp: null,
      typing: {},
      editorForRoom: false,
    });
  }

  /**
   * Leave the current room (the server said so, or the player did) and show the browser. A room on a game
   * server sends us back to the home server, whose welcome then shows the list.
   */
  function leaveRoom(next: Screen = "browse"): void {
    loop?.stop();
    pendingMatch = null;
    roomCode = null;
    resumeToken = null;
    saveSeat();
    stopReconnect();
    store.set({
      room: null,
      chat: [],
      inMatch: false,
      tickHz: 0,
      showScores: false,
      replayReady: false,
      xp: null,
      typing: {},
      editorForRoom: false,
      screen: next,
    });
    if (server !== null) connectServer(null, null);
    else net.send({ t: "list_rooms" });
  }

  /** The game server we were on is gone: back to the room list on the home server. */
  function serverGone(): void {
    leaveRoom();
    toast("The game server went away", "error");
  }

  function startMatch(match: MatchStart, you: number | null, snap: SnapshotBytes | null): void {
    const eng = engine;
    if (!eng) {
      const state = engineLoader.state;
      if (state.status === "failed") {
        toast(`The game engine failed to load: ${state.error}`, "error");
        return;
      }
      // A reload resumes its match while the engine still downloads: the match is entered once the engine loads.
      pendingMatch = { match, you, snap, frames: [] };
      return;
    }
    ensureRenderer();
    loop ??= new MatchLoop({
      engine: eng,
      input,
      net,
      store,
      present,
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
    store.set({ inMatch: true, tickHz: match.tick_hz, screen: "match", showScores: false, replayReady: false, xp: null });
  }

  function sendJoin(room: string, password: string | null): void {
    joinAttempt = room;
    net.send({ t: "join_room", room, password, resume: seat(room)?.token ?? null });
  }

  /** Point the connection at the server `base` (null = home); `then` is sent once that server welcomes us. */
  function connectServer(base: string | null, then: ClientMsg | null): void {
    linkSeq++;
    server = base;
    pendingThen = then;
    pendingName = store.state.name || null;
    switching = true;
    try {
      net.connect(socketUrl());
    } finally {
      switching = false;
    }
  }

  /** Websocket URL of the server we are on. */
  function socketUrl(): string {
    return server === null ? wsUrl() : wsUrlFor(server);
  }

  /**
   * Say hello on the open socket. A game server needs a ticket from the home server to know the signed-in
   * player; the home server needs none (its session cookie is enough).
   */
  async function sendHello(name: string): Promise<void> {
    const seq = linkSeq;
    // guests have no account to vouch for: no ticket (asking would only get a 401)
    const ticket = server === null || store.state.account === null ? null : await fetchTicket();
    if (seq !== linkSeq || net.status !== "open") return;
    net.send({ t: "hello", version: PROTOCOL_VERSION, name, color: prefs.value.color, ticket });
  }

  function handleServer(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome": {
        // A reconnect rejoins the room with its resume token; the screen stays where it was.
        if (store.state.reconnecting && roomCode !== null && resumeToken !== null) {
          resuming = true;
          net.send({ t: "join_room", room: roomCode, password: null, resume: resumeToken });
          return;
        }
        // A redirected connection: the server we were sent to runs the action we asked for.
        if (pendingThen !== null) {
          const then = pendingThen;
          pendingThen = null;
          store.set({ serverName: msg.server });
          net.send(then);
          return;
        }
        const queue = store.state.intent;
        store.set({ serverName: msg.server, screen: queue === null ? "browse" : "quick", intent: null });
        net.send({ t: "list_rooms" });
        if (pendingJoin !== null) {
          // A join on a game server resumes this tab's seat (see joinRoom): if that fails, the server is gone.
          resuming = server !== null;
          sendJoin(pendingJoin, null);
          pendingJoin = null;
        } else if (queue !== null) {
          quickPlay(queue);
        }
        return;
      }
      case "joined":
        resumeToken = msg.token;
        store.set({ myId: msg.you });
        if (resuming || store.state.reconnecting) {
          resuming = false;
          stopReconnect();
        }
        return;
      case "error": {
        if (resuming) {
          resuming = false;
          if (server !== null) {
            serverGone();
          } else {
            leaveRoom();
            toast(msg.code === "room_not_found" ? "That room has closed, so you cannot rejoin it." : `could not rejoin the room: ${msg.message}`, "error");
          }
          return;
        }
        if (msg.code === "wrong_password" && joinAttempt !== null) store.set({ invite: joinAttempt });
        // Quick play found a room that filled up or closed meanwhile: skip it and look again (from home).
        if (matching !== null && roomCode === null && (msg.code === "room_full" || msg.code === "room_not_found")) {
          if (joinAttempt !== null) quickVisited.add(joinAttempt.toUpperCase());
          const retry: ClientMsg = { t: "quick_play", queue: matching, exclude: [...quickVisited] };
          if (server !== null) connectServer(null, retry);
          else net.send(retry);
          return;
        }
        // A refusal from a game server we only visited (not in a room there): back to the list on home.
        if (server !== null && roomCode === null) leaveRoom();
        if (msg.code === "room_not_found" && roomCode === null && joinAttempt !== null) {
          roomNotFound(joinAttempt);
          return;
        }
        toast(msg.message, "error");
        return;
      }
      case "rooms":
        store.set({ rooms: msg.rooms, country: msg.country });
        return;
      case "redirect":
        // Another server hosts what we asked for: leave our room here and connect there.
        if (roomCode !== null) leaveRoom();
        if (msg.then.t === "join_room") joinAttempt = msg.then.room;
        connectServer(msg.url, msg.then);
        return;
      case "room": {
        const chat = store.state.room?.code === msg.room.code ? store.state.chat : [];
        roomCode = msg.room.code;
        if (msg.room.quick !== null) quickVisited.add(msg.room.code.toUpperCase());
        matching = null;
        saveSeat();
        // a match, or the host's map editor opened from the room, stays on screen
        const keep = store.state.inMatch || (store.state.editorForRoom && store.state.screen === "editor");
        store.set({
          room: msg.room,
          chat,
          invite: null,
          screen: keep ? store.state.screen : "room",
        });
        return;
      }
      case "left":
        if (roomCode !== null) leaveRoom();
        return;
      case "kicked":
        toast(msg.reason, "error");
        leaveRoom();
        return;
      case "chat":
        if (msg.from !== null && msg.from !== store.state.myId) sfx.chatPop();
        store.set({ chat: appendChat(store.state.chat, { from: msg.from, name: msg.name, text: msg.text }) });
        return;
      case "suggest":
        if (msg.from !== store.state.myId) sfx.chatPop();
        store.set({
          chat: appendChat(store.state.chat, {
            from: msg.from,
            name: msg.name,
            text: msg.title,
            suggest: { video: msg.video, title: msg.title },
          }),
        });
        return;
      case "typing":
        store.set({ typing: { ...store.state.typing, [msg.player]: performance.now() } });
        return;
      case "xp": {
        const { t: _t, ...award } = msg;
        const account = store.state.account;
        store.set({ xp: award, account: account !== null && award.xp !== null ? { ...account, xp: award.xp } : account });
        return;
      }
      case "jukebox": {
        const room = store.state.room;
        if (room !== null) store.set({ room: { ...room, jukebox: msg.jukebox } });
        return;
      }
      case "map_code":
        for (const waiter of mapWaiters.splice(0)) waiter({ code: msg.code, name: msg.name });
        return;
      case "match_start":
        startMatch(msg.start, msg.you, null);
        return;
      case "snapshot":
        startMatch(msg.start, msg.you, { tick: msg.tick, bytes: decodeSnapshot(msg.state), held: msg.held });
        return;
      case "match_end":
        loop?.stop();
        pendingMatch = null;
        store.set({ inMatch: false, tickHz: 0, showScores: false, replayReady: true, screen: "room" });
        return;
      case "tick_rate":
        store.set({ tickHz: msg.tick_hz });
        return;
      case "rtc_answer":
        // Consumed by Net before it reaches the app.
        return;
    }
  }

  function stopReconnect(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    resuming = false;
    if (store.state.reconnecting) store.set({ reconnecting: false });
  }

  function connectForResume(): void {
    if (net.status === "closed") net.connect(socketUrl());
  }

  /** Schedule the next attempt, or give up once the deadline has passed. */
  function scheduleReconnect(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (performance.now() - reconnectSince >= RECONNECT_GIVE_UP_MS) {
      if (server !== null) {
        serverGone();
      } else {
        resetToMenu();
        toast("could not reconnect to the room", "error");
      }
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectForResume();
    }, delay);
  }

  /** The socket dropped while in a room: show the banner and retry with the resume token. */
  function beginReconnect(): void {
    if (!store.state.reconnecting) {
      reconnectSince = performance.now();
      reconnectAttempt = 0;
      store.set({ reconnecting: true, inMatch: false, tickHz: 0, showScores: false, screen: "room" });
    }
    scheduleReconnect();
  }

  /** Retry now (instead of waiting out the backoff) when the page is shown again or the network returns. */
  function retryNow(): void {
    if (!store.state.reconnecting || net.status !== "closed") return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connectForResume();
  }

  function onStatus(status: NetStatus, notice: CloseNotice | undefined, unexpected: boolean): void {
    store.set({ connection: status, connectDetail: notice?.label ?? "" });
    if (switching) return;
    if (status === "open") {
      const name = pendingName ?? (store.state.reconnecting ? store.state.name : null);
      pendingName = null;
      if (name !== null) void sendHello(name);
      return;
    }
    if (status !== "closed") return;
    linkSeq++;
    loop?.stop();
    pendingMatch = null;
    if (unexpected && notice?.reconnect) {
      if (roomCode !== null && resumeToken !== null) {
        beginReconnect();
        return;
      }
      // The game server dropped and there is no room to resume: back to the list on home.
      if (server !== null) {
        serverGone();
        return;
      }
    }
    resetToMenu();
    if (notice?.text) toast(notice.text, "error");
  }

  /** Connect if needed, then say hello with `name`. The welcome message moves the app to the browser. */
  function play(name: string): void {
    store.set({ name });
    local.setItem(NAME_STORAGE_KEY, name);
    if (net.status === "open") {
      void sendHello(name);
      return;
    }
    pendingName = name;
    if (net.status === "closed") net.connect(socketUrl());
  }

  /**
   * Join room `code`. A room we hold a seat in lives on that seat's server, any other on the home server
   * (which redirects to the right one). Connects first when needed; the welcome then sends the join.
   */
  function joinRoom(code: string): void {
    if (!navigator.onLine) {
      toast("You are offline: rooms need the server.", "error");
      return;
    }
    const target = seat(code)?.server ?? null;
    if (net.status === "open" && store.state.serverName !== "" && server === target) {
      sendJoin(code, null);
      return;
    }
    pendingJoin = code;
    let name = store.state.account?.name ?? (store.state.name || local.getItem(NAME_STORAGE_KEY) || "");
    // A first visit has no name yet: join as a guest, as the menu offers one.
    if (!NAME_RE.test(name)) name = guestName();
    if (net.status === "closed") server = target;
    if (server === target) {
      play(name);
      return;
    }
    store.set({ name });
    connectServer(target, null);
  }

  /** Find a quick-play room of mode `queue`, skipping the quick-play rooms this page has been in. */
  function quickPlay(queue: string): void {
    matching = queue;
    net.send({ t: "quick_play", queue, exclude: [...quickVisited] });
  }

  /** Close the connection and return to the main menu. */
  function disconnect(): void {
    loop?.stop();
    pendingName = null;
    pendingJoin = null;
    matching = null;
    net.close();
    resetToMenu();
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
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) retryNow();
  });
  // The network came back or went away: check the socket now, and retry a pending reconnect at once.
  window.addEventListener("online", () => {
    net.probe();
    retryNow();
  });
  // A server screen gives way to the offline page while the connection is gone, and comes back with it.
  const onConnectionChange = (): void => {
    if (mounted !== null && needsServer(mounted) && offlineShown !== !navigator.onLine) mount(mounted);
  };
  window.addEventListener("online", onConnectionChange);
  window.addEventListener("offline", () => {
    net.probe();
    onConnectionChange();
  });

  // Screens are history entries, so the browser's Back and Forward move between them. A room's screens
  // (room, match, the host's editor) share one entry; each entry records the screen it was entered from.
  let navigating = false;

  /** The state a screen change was made from while a modal's history pop is in flight: recorded once that pop lands. */
  let deferredFrom: AppState | null = null;

  /** Writes the history entry for the screen change from `prev` to `state`: a screen entry, or the modal entry it takes over. */
  function recordScreen(state: AppState, prev: AppState): void {
    const cur: NavState | null = history.state;
    const url = state.room === null ? "/" : `/${state.room.code}`;
    const wasRoom = inRoomScreen(prev.screen, prev.editorForRoom);
    const isRoom = inRoomScreen(state.screen, state.editorForRoom);
    if (cur?.modal !== undefined) {
      // A modal's entry takes the screen change: the modal closes, and the entry becomes this screen's.
      closeModalsAbove(cur.modal, true);
      history.replaceState({ screen: state.screen, prev: prev.screen }, "", url);
    } else if (cur === null || state.screen === prev.screen || (wasRoom && isRoom)) {
      history.replaceState({ screen: state.screen, prev: cur?.prev ?? null }, "", url);
    } else if (cur.prev === state.screen) {
      // Back to the screen this one was entered from: the entry below is that screen.
      history.back();
    } else if (wasRoom) {
      // Leaving the room's screens for another: the room's entry becomes that screen (no dead room entry).
      history.replaceState({ screen: state.screen, prev: cur.prev }, "", url);
    } else {
      history.pushState({ screen: state.screen, prev: prev.screen }, "", url);
    }
  }

  store.subscribe((state, prev) => {
    if (navigating) return;
    if (state.screen === prev.screen && state.room?.code === prev.room?.code) return;
    if (modalPopPending()) {
      if (deferredFrom === null) deferredFrom = prev;
      return;
    }
    recordScreen(state, prev);
  });

  window.addEventListener("popstate", (e: PopStateEvent) => {
    const nav: NavState | null = e.state;
    navigating = true;
    try {
      // Back past a modal's entry closes the modals opened after it; a plain screen entry closes them all.
      closeModalsAbove(nav?.modal ?? null);
      if (takeModalPop()) {
        // The pop a page-side modal close asked for: the screen stays. Changes made while it was in flight are recorded on this entry.
        if (!modalPopPending() && deferredFrom !== null) {
          const from = deferredFrom;
          deferredFrom = null;
          recordScreen(store.state, from);
        }
        return;
      }
      if (nav === null) return;
      const s = store.state;
      let target: Screen = nav.screen === "match" && !s.inMatch ? "room" : nav.screen;
      if ((target === "room" || target === "match") && s.room === null) target = "browse";
      if ((target === "browse" || target === "quick" || target === "room" || target === "match") && s.serverName === "") target = "menu";
      if (target !== s.screen) {
        // Back out of the room's screens leaves the room, as its Leave button does.
        if (roomCode !== null && !inRoomScreen(target, s.editorForRoom)) {
          net.send({ t: "leave_room" });
          leaveRoom(target);
        } else {
          store.set({ screen: target });
        }
      }
      history.replaceState({ ...nav, screen: store.state.screen }, "", store.state.room === null ? "/" : `/${store.state.room.code}`);
    } finally {
      navigating = false;
    }
  });

  /** A join named a room that is not open: say so, and offer the room list. */
  function roomNotFound(code: string): void {
    let m: { close(): void } | null = null;
    const browse = h(
      "button",
      {
        type: "button",
        onclick: () => {
          store.set({ screen: "browse" });
          m?.close();
        },
      },
      "Browse rooms",
    );
    m = openModal({
      title: "Room not found",
      body: [h("p", null, `No open room has the code ${code.toUpperCase()}. It may have closed, or the link may have a typo.`)],
      actions: [browse],
    });
  }

  // The first history entry is the screen this page opened on, at the URL it opened at.
  history.replaceState({ screen: store.state.screen, prev: null }, "");
  resizeAll();
  mount(store.state.screen);
  const boot = document.getElementById("boot");
  if (boot) {
    boot.classList.add("is-leaving");
    window.setTimeout(() => {
      boot.hidden = true;
    }, 180);
  }
  return store;
}
