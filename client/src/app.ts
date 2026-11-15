// Application shell: owns the services, the connection state machine and screen
// mounting. Screens render from the store; this file reacts to server messages.

import { fetchBuiltinMaps, fetchTicket, wsUrl, wsUrlFor, type BuiltinMap } from "./api";
import { Sfx } from "./audio";
import { computeCamera, findLocal } from "./camera";
import type { AppCtx, HudHandle, Present, ScreenFactory, ScreenHandle, WasmTools } from "./ctx";
import { Engine, loadWasmEngine } from "./engine";
import { readScene } from "./frame";
import { MatchLoop, type SnapshotBytes } from "./game";
import { Input } from "./input";
import { Net, type NetStatus } from "./net";
import { NAME_RE, PROTOCOL_VERSION, type ClientMsg, type MatchStart, type RoomState, type ServerMsg } from "./protocol";
import { createRenderer, type Renderer } from "./render";
import { Overlay } from "./render/overlay";
import { CHAT_LIMIT, NAME_STORAGE_KEY, SEAT_STORAGE_KEY, Store, initialState, type AppState, type ChatLine, type Screen } from "./state";
import { aboutScreen } from "./ui/screens/about";
import { browserScreen } from "./ui/screens/browser";
import { hudScreen } from "./ui/screens/hud";
import { menuScreen } from "./ui/screens/menu";
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
import { mountJukebox } from "./ui/jukebox";
import { showPostGame } from "./ui/postgame";
import { prefs } from "./prefs";
import { music } from "./music";
import type { XpAward } from "./protocol";
import { h } from "./ui/dom";
import { showToast } from "./ui/toast";

const SCREEN_FACTORIES: Record<Exclude<Screen, "match">, ScreenFactory> = {
  menu: menuScreen,
  about: aboutScreen,
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
/** Close reasons the server sends when it removes us from the room; the kick message already says so. */
const REMOVED_REASONS = new Set(["kicked", "banned"]);

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

/** Keep the address bar on `/CODE` while in a room (shareable, reload rejoins), `/` otherwise. */
function syncUrl(code: string | null): void {
  const want = code === null ? "/" : `/${code}`;
  if (location.pathname !== want || location.search !== "") history.replaceState(null, "", want);
}

export function start(): void {
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

  // The menu mounts immediately; the engine loads in the background.
  const engineP: Promise<Engine> = loadWasmEngine().then((raw) => {
    engine = new Engine(raw);
    return engine;
  });
  engineP.catch((err: unknown) => toast(`engine failed to load: ${errText(err)}`, "error"));

  /** When the game view was last drawn; the view hides once nothing has drawn it for a moment. */
  let lastPresent = 0;
  let viewShown = true;
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
  const present: Present = (names, tickHz) => {
    const fb = engine?.framebuffer();
    if (!fb) return null;
    ensureRenderer();
    const scene = readScene(fb);
    scene.localKeys = input.mask();
    const cam = computeCamera(scene, window.innerWidth, window.innerHeight, findLocal(scene));
    renderer?.draw(scene, cam);
    overlay.draw(scene, cam, names, tickHz);
    lastPresent = performance.now();
    setViewShown(true);
    for (const s of scene.sounds) sfx.play(s.kind, s.volume);
    return scene;
  };

  const wasm: WasmTools = {
    mapPreview: (code) => needEngine().mapPreview(code),
    mapEncode: (json) => needEngine().mapEncode(json),
  };

  const net = new Net({
    onMessage: (msg) => handleServer(msg),
    onBinary: (bytes) => loop?.onServer(bytes),
    onStatus: (status, detail, unexpected) => onStatus(status, detail, unexpected ?? false),
  });

  const ctx: AppCtx = {
    store,
    net,
    input,
    sfx,
    wasm,
    engine: () => engineP,
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
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", update);
        overlay.topInset = 0;
      };
    },
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
    let handle: ScreenHandle;
    if (screen === "match") {
      const hudHandle = hudScreen(ctx);
      hud = hudHandle;
      handle = hudHandle;
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

  // Menu music plays on the menu screens and stops (fading) in rooms,
  // matches, training, practice, replays and the editor, like the original.
  const syncMusic = (screen: Screen): void => {
    if (GAME_SCREENS[screen]) music.stop();
    else music.start();
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
    closePostGame = showPostGame(ctx, award, state.room?.map ?? null);
  });

  // Shown over every screen while the connection to a room is being restored.
  const banner = h(
    "div",
    { class: "reconnect-banner", role: "status", "aria-live": "polite" },
    h("span", null, "Connection lost. Reconnecting…"),
    h("button", { type: "button", onclick: () => disconnect() }, "Leave"),
  );
  banner.hidden = true;
  document.body.append(banner);
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
    const hPx = Math.round(window.innerHeight * dpr);
    renderer?.resize(w, hPx);
    overlay.resize(w, hPx);
  }

  /** This tab's seat, kept in sessionStorage so a page reload rejoins the same slot on the same server. */
  function saveSeat(): void {
    try {
      if (roomCode !== null && resumeToken !== null) {
        window.sessionStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ room: roomCode, token: resumeToken, server }));
      } else {
        window.sessionStorage.removeItem(SEAT_STORAGE_KEY);
      }
    } catch {
      // Storage blocked: a reload joins as a new player.
    }
  }

  /** This tab's seat in `room` (resume token and the server it is on), if any. */
  function seat(room: string): { token: string; server: string | null } | null {
    try {
      const saved: unknown = JSON.parse(window.sessionStorage.getItem(SEAT_STORAGE_KEY) ?? "null");
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
    syncUrl(null);
  }

  /**
   * Leave the current room (the server said so, or the player did) and show the browser. A room on a game
   * server sends us back to the home server, whose welcome then shows the list.
   */
  function leaveRoom(): void {
    loop?.stop();
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
      screen: "browse",
    });
    syncUrl(null);
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
      toast("engine not loaded", "error");
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
            toast(`could not rejoin the room: ${msg.message}`, "error");
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
        syncUrl(roomCode);
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
        leaveRoom();
        return;
      case "kicked":
        toast(`kicked: ${msg.reason}`, "error");
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

  function onStatus(status: NetStatus, detail: string | undefined, unexpected: boolean): void {
    store.set({ connection: status, connectDetail: detail ?? "" });
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
    if (unexpected && roomCode !== null && resumeToken !== null) {
      beginReconnect();
      return;
    }
    // The game server dropped and there is no room to resume: back to the list on home.
    if (unexpected && server !== null) {
      serverGone();
      return;
    }
    resetToMenu();
    if (detail && !REMOVED_REASONS.has(detail)) toast(detail, "error");
  }

  /** Connect if needed, then say hello with `name`. The welcome message moves the app to the browser. */
  function play(name: string): void {
    store.set({ name });
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
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
    const target = seat(code)?.server ?? null;
    if (net.status === "open" && store.state.serverName !== "" && server === target) {
      sendJoin(code, null);
      return;
    }
    pendingJoin = code;
    const name = store.state.account?.name ?? (store.state.name || window.localStorage.getItem(NAME_STORAGE_KEY) || "");
    if (!NAME_RE.test(name)) {
      store.set({ screen: "menu" });
      return;
    }
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
  window.addEventListener("online", retryNow);

  mount(store.state.screen);
  const boot = document.getElementById("boot");
  if (boot) boot.hidden = true;
}
