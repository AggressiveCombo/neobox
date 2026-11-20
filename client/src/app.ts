// Application shell: owns the services, the connection state machine and screen
// mounting. Screens render from the store; this file reacts to server messages.

import { fetchBuiltinMaps, fetchTicket, wsUrl, wsUrlFor, type BuiltinMap } from "./api";
import { sfx } from "./audio";
import { backdropCamera, computeCamera, fitView, fitViewBetween, findLocal, publishBackdrop, publishView, type ViewRect } from "./camera";
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
import { CHAT_LIMIT, Store, initialState, type AppState, type ChatLine, type Pending, type Screen } from "./state";
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
import { closeModalsAbove, modalPopPending, openModal, pushDeferredModals, takeModalPop } from "./ui/kit";
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
/** Shown when a room is gone because the game server restarted (its rooms do not survive a restart). */
const RESTARTED_TEXT = "The server restarted, so that room is gone.";
/** The server's kick reasons (room.rs) as full sentences. Any other reason is shown as given, ended with a period. */
const KICK_TEXT: Record<string, string> = {
  "You were banned": "You were banned from the room.",
  "You were kicked": "You were kicked from the room.",
  "You were removed from the room for being idle too long": "You were removed from the room for being idle too long.",
  "Room closed by an administrator": "The room was closed by an administrator.",
};

function kickText(reason: string): string {
  return KICK_TEXT[reason] ?? `${reason.replace(/\.?$/, "")}.`;
}

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

/** What the page address asks for: a room code (`/CODE` or `?room=CODE`), an address that names no room, or null for the plain menu. */
type UrlInvite = { code: string } | { error: "malformed" } | null;

/** The room code the address names, or why it names none. */
function inviteFromUrl(): UrlInvite {
  const fromQuery = new URLSearchParams(location.search).get("room");
  if (fromQuery !== null) {
    const code = fromQuery.trim().toUpperCase();
    return ROOM_CODE_RE.test(code) ? { code } : { error: "malformed" };
  }
  let path: string;
  try {
    path = decodeURIComponent(location.pathname).replace(/^\/+|\/+$/g, "").trim();
  } catch {
    return { error: "malformed" };
  }
  if (path === "") return null;
  const code = path.toUpperCase();
  return ROOM_CODE_RE.test(code) ? { code } : { error: "malformed" };
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
  /** Room to join once the server has welcomed us (invite links, friends), with the password it was given. */
  let pendingJoin: { room: string; password: string | null } | null = null;
  /** The screen a join was started from: Back or Cancel on its pending state returns there. */
  let joinFrom: Screen = "browse";
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
  let pendingMatch: { match: MatchStart; you: number | null; snap: SnapshotBytes | null; frames: { bytes: Uint8Array; at: number }[] } | null = null;
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
    for (const frame of pending.frames) loop?.onServer(frame.bytes, frame.at);
  });
  // Screens that need the engine show its failure inline with Try again, so the background load reports nothing itself.
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
    ensureRenderer(chrome);
    // The renderer is created asynchronously: until it exists nothing is drawn, so the view stays hidden and the caller
    // is told nothing was shown (a clip's first frame would otherwise go live as an empty page-colour square).
    if (!renderer) return null;
    const scene = readScene(fb);
    scene.localKeys = input.mask();
    const local = computeCamera(scene, findLocal(scene));
    const cam = backdrop ? backdropCamera(scene, menuBox(), window.innerWidth, window.innerHeight) : local;
    if (backdrop) publishBackdrop(cam, scene.arenaW, scene.arenaH);
    renderer?.draw(scene, cam);
    overlay.draw(scene, cam, names, tickHz, chrome);
    lastPresent = performance.now();
    setViewShown(true);
    for (const s of scene.sounds) sfx.play(s.kind, s.volume, (s.x - cam.cx) / (cam.w / 2));
    return scene;
  };

  /** Marks the game view as in use without drawing it; the held frame then stays on screen. */
  const holdView = (): void => {
    lastPresent = performance.now();
  };

  /** The menu clip's window in CSS px: the turned square (ui/screens/menu.ts) with its unturned side and turn, else the whole window. `bar` is the caption bar's top edge below the centre (0 when no bar shows). */
  function menuBox(): { cx: number; cy: number; side: number; angle: number; bar: number } {
    const el = document.querySelector<HTMLElement>(".menu-square");
    if (el && el.offsetWidth > 0) {
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      // The turn is set by ui/screens/menu.ts (SQUARE_ANGLE) as --angle; no turn when it is absent.
      const angle = parseFloat(getComputedStyle(el).getPropertyValue("--angle")) || 0;
      const bar = document.querySelector<HTMLElement>(".menu-clip-bar:not([hidden])");
      const barTop = bar ? bar.getBoundingClientRect().top - cy : 0;
      return { cx: r.left + r.width / 2, cy, side: el.offsetWidth, angle, bar: barTop };
    }
    return { cx: window.innerWidth / 2, cy: window.innerHeight / 2, side: Math.min(window.innerWidth, window.innerHeight), angle: 0, bar: 0 };
  }

  const wasm: WasmTools = {
    mapPreview: (code) => needEngine().mapPreview(code),
    mapEncode: (json) => needEngine().mapEncode(json),
  };

  const net = new Net({
    onMessage: (msg) => handleServer(msg),
    onBinary: (bytes, at) => {
      if (pendingMatch === null) loop?.onServer(bytes, at);
      else if (pendingMatch.frames.length < PENDING_FRAMES_MAX) pendingMatch.frames.push({ bytes, at });
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
    holdView,
    send: (msg) => {
      if (msg.t === "join_room") joinAttempt = msg.room;
      net.send(msg);
    },
    toast,
    play,
    joinRoom,
    cancelJoin: () => abandonJoin(joinFrom),
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
      bar.classList.add("playfield-clear");
      const update = (): void => {
        overlay.topInset = bar.getBoundingClientRect().bottom;
      };
      const ro = new ResizeObserver(() => {
        update();
        scheduleResize();
      });
      ro.observe(bar);
      window.addEventListener("resize", update);
      update();
      const releaseBar = overlay.reserve(bar);
      return () => {
        releaseBar();
        bar.classList.remove("playfield-clear");
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
    if (invite !== null && "code" in invite) joinRoom(invite.code);
  });
  mountJukebox(ctx);

  // The appearance colour follows the preference into the room.
  prefs.subscribe((next, prev) => {
    if (next.color !== prev.color && next.color !== null && net.status === "open" && store.state.serverName !== "") {
      net.send({ t: "set_color", color: next.color });
    }
  });
  prefs.subscribe((next, prev) => {
    if (next.touchScale !== prev.touchScale || next.touchLeftHanded !== prev.touchLeftHanded) scheduleResize();
  });

  /** The offline page's Try again once the server answers: Browse needs its socket (welcome mounts the list); the rest mount. */
  function reopen(screen: Screen): void {
    if (screen !== "browse") mount(screen);
    else if (store.state.name === "") store.set({ screen: "menu" });
    else play(store.state.name);
  }

  /** Mount a screen factory's output, replacing whatever is shown. */
  function mount(screen: Screen): void {
    // Hide the game view before the leaving screen clears its clip mask (the menu's destroy) and the new screen mounts:
    // an unmasked frame (the GL view and its letterbox shadow) would show for a moment. present shows it again on the next frame.
    if (screen !== "menu") setViewShown(false);
    current?.destroy();
    hud = null;
    offlineShown = needsServer(screen) && !navigator.onLine;
    let handle: ScreenHandle;
    if (screen === "match") {
      const hudHandle = hudScreen(ctx);
      hud = hudHandle;
      handle = hudHandle;
    } else {
      handle = offlineShown ? offlinePage(ctx, screen, () => reopen(screen)) : SCREEN_FACTORIES[screen](ctx);
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
    if (from !== null) playScreenTransition(uiRoot, leaving, handle.el, scrollTop);
    // The controls of a new screen (and the transition's motion) set the band the game view fits between.
    scheduleResize();
    handle.el.addEventListener("animationend", scheduleResize);
  }

  store.subscribe((state, prev) => {
    if (state.screen !== mounted) mount(state.screen);
    current?.update(state, prev);
  });
  // The open row's password field belongs to the browser: it closes when another screen shows or a room is entered.
  store.subscribe((state, prev) => {
    if (state.openRoom === null) return;
    if ((state.screen !== "browse" && state.screen !== "room") || (state.room !== null && state.room !== prev.room)) store.set({ openRoom: null });
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
  const bannerText = h("span", null, "Connection lost. Reconnecting…");
  const retry = h("button", { type: "button", onclick: () => retryNow() }, "Try again now");
  const banner = h(
    "div",
    { class: "reconnect-banner", role: "status", "aria-live": "polite" },
    bannerText,
    retry,
    h("button", { type: "button", onclick: () => disconnect() }, "Leave"),
  );
  banner.hidden = true;
  document.body.prepend(banner);
  // An attempt in progress shows as one: the button reads "Retrying…" and is disabled until it settles. Offline, no attempt
  // can succeed, so the button stays off and the banner says why; the online and offline events resync it.
  const syncBanner = (): void => {
    banner.hidden = !store.state.reconnecting;
    const trying = store.state.connection === "connecting";
    const offline = !navigator.onLine;
    retry.disabled = trying || offline;
    retry.textContent = trying ? "Retrying…" : "Try again now";
    bannerText.textContent = offline ? "You are offline. Reconnecting when the network returns…" : "Connection lost. Reconnecting…";
  };
  store.subscribe(syncBanner);
  window.addEventListener("online", syncBanner);
  window.addEventListener("offline", syncBanner);

  function names(): ReadonlyMap<number, string> {
    const room = store.state.room;
    if (room !== namesRoom) {
      namesRoom = room;
      namesMap = new Map((room?.players ?? []).map((p): [number, string] => [p.id, p.name]));
    }
    return namesMap;
  }

  /** Renderer creation is async (WebGPU or WebGL2 init); the loop skips drawing until it is ready. */
  function ensureRenderer(chrome: boolean): void {
    if (renderer || rendererP) return;
    if (rendererFailed) {
      // Drawn frames would be empty: say so on the first call on each screen (the dialog covered the first failure).
      if (chrome && !failureSaid) {
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
    if (store.state.inMatch) ensureRenderer(true);
  }

  /** The game view rect. Landscape touch controls sit at the arena's two ends, so there the view is the largest rect between the two clusters (the arena then stays clear of them at any Control size). Elsewhere the view is the largest rect between the `.playfield-clear` bars and panels that cross the window's centre line (a top bar, the replay scoreboard and dock), or the largest rect of the window when none. */
  function gameView(): ViewRect {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    if (backdrop) return { x: 0, y: 0, w: winW, h: winH };
    if (winW > winH) {
      let left = 0;
      let right = winW;
      for (const el of document.querySelectorAll<HTMLElement>(".hud-touch-layer .hud-stick, .hud-touch-layer .hud-actions")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left + r.width / 2 < winW / 2) left = Math.max(left, r.right);
        else right = Math.min(right, r.left);
      }
      if (right > left && right - left < winW) return fitViewBetween(winH, left, right);
    }
    // Bars and panels over the arena (.playfield-clear) bound the vertical band the view fits in: nothing covers the arena.
    let top = 0;
    let bottom = winH;
    for (const el of document.querySelectorAll<HTMLElement>(".playfield-clear")) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.left > winW / 2 || r.right < winW / 2) continue;
      if (r.top + r.height / 2 < winH / 2) top = Math.max(top, r.bottom);
      else bottom = Math.min(bottom, r.top);
    }
    // A band under 40% of the window is too small to play in (short phone landscape): the arena keeps the whole window and the bars sit over it, as before.
    if (bottom - top >= winH * 0.4 && (top > 0 || bottom < winH)) {
      const v = fitView(winW, bottom - top);
      return { x: v.x, y: top + v.y, w: v.w, h: v.h };
    }
    return fitView(winW, winH);
  }

  /** Size the game canvases to the view rect (the original's aspect, centred in the window) and publish it. */
  function resizeAll(): void {
    const view = gameView();
    publishView(view);
    overlay.setView(view);
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(view.w * dpr);
    const hPx = Math.round(view.h * dpr);
    renderer?.resize(w, hPx);
    overlay.resize(w, hPx);
  }

  /** resizeAll once this frame's layout is applied: prefs and a freshly mounted screen change the controls' rects. */
  let resizePending = 0;
  function scheduleResize(): void {
    if (resizePending === 0) {
      resizePending = requestAnimationFrame(() => {
        resizePending = 0;
        resizeAll();
      });
    }
  }

  // Practice, training, the test play and the replay build their controls after their screen mounts: resize when a layer or a bar or panel over the arena enters or leaves.
  // A panel that grows in place (the replay scoreboard fills its rows after mount) moves the edge the view is fitted to: observe each one's size too.
  const clearSizes = new ResizeObserver((entries) => {
    for (const e of entries) if (!e.target.isConnected) clearSizes.unobserve(e.target);
    scheduleResize();
  });
  new MutationObserver((records) => {
    if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n instanceof Element && (n.matches(".hud-touch-layer, .playfield-clear") || n.querySelector(".hud-touch-layer, .playfield-clear"))))) {
      for (const el of document.querySelectorAll<HTMLElement>(".playfield-clear")) clearSizes.observe(el);
      scheduleResize();
    }
  }).observe(uiRoot, { childList: true, subtree: true });

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

  /** Back to `screen` (the main menu by default), forgetting the room and any reconnect in progress. */
  function resetToMenu(screen: Screen = "menu", pending: Pending = null): void {
    stopReconnect();
    pendingMatch = null;
    roomCode = null;
    resumeToken = null;
    server = null;
    pendingThen = null;
    saveSeat();
    store.set({
      screen,
      pending,
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
      pending: null,
    });
    if (server !== null) connectServer(null, null);
    else net.send({ t: "list_rooms" });
  }

  /** The game server we were on is gone: back to the room list on the home server. */
  function serverGone(text = "The game server went away"): void {
    leaveRoom();
    toast(text, "error");
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
    ensureRenderer(true);
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
        // A join in progress keeps its screen: the room screen shows its pending state until the room answers.
        const joining = store.state.pending?.kind === "room";
        store.set({ serverName: msg.server, screen: queue !== null ? "quick" : joining ? store.state.screen : "browse", intent: null });
        // The offline page for Browse waits on this welcome: mount the list now that the socket is open.
        if (offlineShown) mount(store.state.screen);
        net.send({ t: "list_rooms" });
        if (pendingJoin !== null) {
          // A join on a game server resumes this tab's seat (see joinRoom): if that fails, the server is gone.
          resuming = server !== null;
          const join = pendingJoin;
          pendingJoin = null;
          sendJoin(join.room, join.password);
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
            serverGone(msg.code === "server_restarted" ? RESTARTED_TEXT : undefined);
          } else {
            leaveRoom();
            if (msg.code === "server_restarted") store.set({ notice: RESTARTED_TEXT });
            else if (msg.code === "room_not_found") store.set({ notice: "That room has closed, so you cannot rejoin it." });
            else toast(`could not rejoin the room: ${msg.message}`, "error");
          }
          return;
        }
        // A list still loading shows the refusal on the browser (with Try again); a join leaves the room screen for the browser.
        const waiting = store.state.pending;
        if (waiting?.kind === "list") {
          store.set({ pending: { kind: "list", error: msg.message } });
          return;
        }
        if (waiting?.kind === "room") store.set({ pending: null, screen: "browse" });
        // A refused join from a locked row keeps the row's field open; any other refused join asks for the password in the invite slot.
        if (msg.code === "wrong_password" && joinAttempt !== null && store.state.openRoom !== joinAttempt) store.set({ invite: joinAttempt });
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
        // A join from the list was refused: the browser keeps the cause on screen until it is dismissed.
        if (msg.code === "room_full" && roomCode === null) {
          const full = "The room is full. Pick another room from the list.";
          // The panel already shows this text after a repeat refusal: a toast shows the click was answered.
          if (store.state.notice === full) toast(full, "error");
          store.set({ notice: full, screen: "browse" });
          return;
        }
        toast(msg.message, "error");
        return;
      }
      case "rooms":
        store.set({ rooms: msg.rooms, country: msg.country, pending: store.state.pending?.kind === "room" ? store.state.pending : null });
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
          pending: null,
          screen: keep ? store.state.screen : "room",
        });
        return;
      }
      case "left":
        if (roomCode !== null) leaveRoom();
        return;
      case "kicked":
        // Leaves the room in place: a history.back() here would land after any navigation the player started
        // since the kick, and its popstate moves the screen on past the lobby.
        leavingInPlace = true;
        try {
          leaveRoom();
        } finally {
          leavingInPlace = false;
        }
        store.set({ notice: kickText(msg.reason) });
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
        // A host or admin stop awards nothing, so no results panel opens: say why on the room screen.
        if (msg.reason === "ended by the host") toast("The host ended the match. No experience was awarded.");
        else if (msg.reason === "ended by an administrator") toast("An administrator ended the match. No experience was awarded.");
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

  /** Open a fresh socket for the resume. A stalled attempt is replaced; nothing happens while the link is up. */
  function connectForResume(): void {
    if (net.status === "open" || !navigator.onLine) return;
    switching = true;
    try {
      net.connect(socketUrl());
    } finally {
      switching = false;
    }
  }

  /** Schedule the next attempt, or give up once the deadline has passed. */
  function scheduleReconnect(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    // Offline, a socket fails at once and only fills the console: wait for the online event (retryNow), which resumes.
    if (!navigator.onLine) return;
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

  /** Retry now, from the start of the backoff and replacing a stalled attempt, when the page is shown again or the network returns. */
  function retryNow(): void {
    if (!store.state.reconnecting) return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
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
    // A list still loading, or a join in progress, cannot finish now: back to the browser, which says why the list did not load.
    const waiting = store.state.pending;
    if (waiting !== null) {
      pendingJoin = null;
      const error = waiting.kind === "list" && waiting.error !== null ? waiting.error : notice?.text || "Could not reach the server.";
      resetToMenu("browse", { kind: "list", error });
      return;
    }
    // Offline, Browse stays where it is: its offline page says so, and Retry reconnects. Other screens go to the menu.
    const offlineBrowse = !navigator.onLine && store.state.screen === "browse";
    // The browser draws its notice panel only on its own screen. A notice still pending here (the kick that the
    // server sent just before this close) goes out as a toast instead of being lost with the screen change.
    const pending = offlineBrowse ? null : store.state.notice;
    resetToMenu(offlineBrowse ? "browse" : "menu");
    if (pending !== null) {
      store.set({ notice: null });
      toast(pending, "error");
    } else if (notice?.text && !offlineBrowse) toast(notice.text, "error");
  }

  /** Connect if needed, then say hello with `name`. The welcome message moves the app to the browser. */
  function play(name: string): void {
    store.set({ name });
    // Signed in, the name is the account's: the guest name key keeps this device's own guest name.
    if (store.state.account === null) local.setItem(NAME_STORAGE_KEY, name);
    if (net.status === "open") {
      void sendHello(name);
      return;
    }
    pendingName = name;
    if (net.status === "closed") net.connect(socketUrl());
  }

  /**
   * Join room `code` (with `password` if it needs one). The screen moves to the room's pending state at once; the
   * server answers later. A room we hold a seat in lives on that seat's server, any other on the home server (which
   * redirects to the right one). Connects first when needed; the welcome then sends the join.
   */
  function joinRoom(code: string, password: string | null = null): void {
    if (!navigator.onLine) {
      toast("You are offline: rooms need the server.", "error");
      return;
    }
    if (store.state.room === null) joinFrom = store.state.screen === "browse" ? "browse" : "menu";
    store.set({ pending: { kind: "room", code }, screen: "room", invite: null });
    const target = seat(code)?.server ?? null;
    if (net.status === "open" && store.state.serverName !== "" && server === target) {
      sendJoin(code, password);
      return;
    }
    pendingJoin = { room: code, password };
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

  /**
   * Give up the pending join or list (Back, or Cancel): the connection is replaced, so the server forgets the join,
   * and the screen moves to `next`. Browse reconnects home for its list; any other screen disconnects.
   */
  function abandonJoin(next: Screen): void {
    pendingJoin = null;
    resuming = false;
    if (next === "browse") {
      store.set({ screen: "browse", pending: { kind: "list", error: null }, openRoom: null });
      connectServer(null, null);
      return;
    }
    disconnect();
    if (next !== "menu") store.set({ screen: next });
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
    store.set({ pending: null });
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
  // A server screen gives way to the offline page while the connection is gone. Coming back is the page's own Retry.
  const onConnectionChange = (): void => {
    if (mounted !== null && needsServer(mounted) && !offlineShown && !navigator.onLine) mount(mounted);
  };
  window.addEventListener("offline", () => {
    net.probe();
    onConnectionChange();
  });

  // Screens are history entries, so the browser's Back and Forward move between them. A room's screens
  // (room, match, the host's editor) share one entry; each entry records the screen it was entered from.
  let navigating = false;

  /** The state a screen change was made from while a modal's history pop is in flight: recorded once that pop lands. */
  let deferredFrom: AppState | null = null;

  /** Set while a kick leaves the room: the room's entry is replaced in place, never traversed. */
  let leavingInPlace = false;

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
    } else if (cur.prev === state.screen && !leavingInPlace) {
      // Back to the screen this one was entered from: the entry below is that screen.
      history.back();
    } else if (wasRoom) {
      // Leaving the room's screens for another: the room's entry becomes that screen (no dead room entry). A kick leaves
      // in place, so the entry keeps no back link: a close that follows the kick pushes its screen, never traverses.
      history.replaceState({ screen: state.screen, prev: leavingInPlace ? null : cur.prev }, "", url);
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
        // Modals opened while the pop was in flight take their entries now that it has landed.
        pushDeferredModals();
        return;
      }
      if (nav === null) return;
      const s = store.state;
      let target: Screen = nav.screen === "match" && !s.inMatch ? "room" : nav.screen;
      if ((target === "room" || target === "match") && s.room === null) target = "browse";
      if ((target === "browse" || target === "quick" || target === "room" || target === "match") && s.serverName === "" && target !== s.screen) target = "menu";
      if (target !== s.screen) {
        // A join or list still pending is abandoned on Back: its answer must not land on the screen Back went to.
        if (s.pending !== null) {
          abandonJoin(target);
        } else if (roomCode !== null && !inRoomScreen(target, s.editorForRoom)) {
          // Back out of the room's screens leaves the room, as its Leave button does.
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
    const menu = h(
      "button",
      {
        type: "button",
        onclick: () => {
          store.set({ screen: "menu" });
          m?.close();
        },
      },
      "Back to menu",
    );
    m = openModal({
      title: "Room not found",
      body: [h("p", null, `No open room has the code ${code.toUpperCase()}. It may have closed, or the link may have a typo.`)],
      actions: [browse, menu],
    });
  }

  /** An address that names no room: say so, with a way back to the menu. */
  function badLink(): void {
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
    const menu = h("button", { type: "button", onclick: () => m?.close() }, "Back to menu");
    m = openModal({
      title: "Link not recognised",
      body: [h("p", null, "This link is not valid, so it does not open a room. Check the address, or browse the open rooms.")],
      actions: [browse, menu],
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
  if (invite !== null && "error" in invite) badLink();
  return store;
}
