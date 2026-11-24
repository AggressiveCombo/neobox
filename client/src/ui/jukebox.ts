// Jukebox: a YouTube video the whole room hears together. A small panel shows while the room has one:
// the title, who suggested it, and the transport. The host plays a link, pauses, resumes or stops it.
// Everyone hears it at the jukebox volume: the master volume times the jukebox slider.
// The video plays through YouTube's IFrame player API, loaded on first use.
// Audio first by default: the owner chose this over YouTube's embed rules. The player stays in the page
// (clipped out of view) so the audio keeps playing; "Show video" turns on the 16:9 picture.

import type { AppCtx } from "../ctx";
import { music } from "../music";
import { prefs } from "../prefs";
import type { JukeboxState } from "../protocol";
import type { AppState } from "../state";
import { local } from "../storage";
import { JUKEBOX_VIDEO_KEY } from "../storage-keys";
import { h } from "./dom";
import { icon } from "./icons";

const API_SRC = "https://www.youtube.com/iframe_api";
/** Seconds a player may drift from the room's position before it seeks. */
const DRIFT_S = 2;
/** Seconds to wait for the player to report ready before the jukebox is marked unavailable. */
const PLAYER_READY_MS = 15000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** YouTube player states that mean "not playing yet": unstarted, paused, cued. */
const NOT_PLAYING = new Set([-1, 2, 5]);

interface YtPlayer {
  cueVideoById(id: string, start: number): void;
  loadVideoById(id: string, start: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
}

interface YtApi {
  Player: new (
    el: HTMLElement,
    options: {
      width: string;
      height: string;
      playerVars: { origin: string };
      events: { onReady: () => void; onError: () => void; onStateChange: (e: { data: number }) => void };
    },
  ) => YtPlayer;
}

const ytWindow = window as unknown as { YT?: YtApi; onYouTubeIframeAPIReady?: () => void };

let apiLoad: Promise<YtApi> | null = null;

/** The YouTube IFrame API, loaded once. A failed load is retried on the next use. */
function loadApi(): Promise<YtApi> {
  if (apiLoad !== null) return apiLoad;
  const { promise, resolve, reject } = Promise.withResolvers<YtApi>();
  apiLoad = promise;
  ytWindow.onYouTubeIframeAPIReady = () => {
    if (ytWindow.YT) resolve(ytWindow.YT);
  };
  const script: HTMLScriptElement = h("script", {
    src: API_SRC,
    onerror: () => {
      script.remove();
      apiLoad = null;
      reject(new Error("The video player could not load."));
    },
  });
  document.head.append(script);
  return promise;
}

/** A YouTube video id from a bare id or a watch, short, embed or youtu.be link; null otherwise. */
export function parseYouTubeId(text: string): string | null {
  const s = text.trim();
  if (VIDEO_ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1);
  } else if (host === "youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = /^\/(?:embed|shorts)\/([^/]+)$/.exec(url.pathname)?.[1] ?? null;
  }
  return id !== null && VIDEO_ID_RE.test(id) ? id : null;
}

function isHost(state: AppState): boolean {
  const room = state.room;
  return room !== null && room.quick === null && room.players.some((p) => p.id === state.myId && p.host);
}

/** Whether the video's picture is shown at 16:9 (the "Show video" choice). Off by default; remembered on this device. */
function readLarge(): boolean {
  try {
    return local.getItem(JUKEBOX_VIDEO_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLarge(large: boolean): void {
  try {
    local.setItem(JUKEBOX_VIDEO_KEY, large ? "1" : "0");
  } catch {
    // Storage blocked: the choice simply resets on the next visit.
  }
}

/** Mounts the jukebox panel on the page and keeps the player in step with the room. */
export function mountJukebox(ctx: AppCtx): void {
  let player: YtPlayer | null = null;
  let playerBuild: Promise<YtPlayer> | null = null;
  /** The video the player has loaded, so a new one is loaded only when it changes. */
  let loadedId: string | null = null;
  let current: JukeboxState | null = null;
  /** performance.now() when `current` arrived: the room's position is advanced by the time since. */
  let heardAt = 0;
  /** The player could not load: the panel says so, and the room's music is not silenced for it. */
  let unavailable = false;
  /** The video's picture is shown at 16:9 (the "Show video" choice); otherwise the player runs hidden. */
  let large = readLarge();
  /** The player's YouTube state: -1 unstarted, 1 playing, 2 paused, 3 buffering, 5 cued. */
  let playerState = -1;

  // Persistent clipped audio host on document.body so YouTube keeps playing audio even when the popup is hidden.
  const audioHost = h("div", { class: "jukebox-audio-host", "aria-hidden": "true" });
  // The player frame lives in this mount (ensurePlayer gives YouTube an inner node to replace).
  const playerMount = h("div", { class: "jukebox-screen" });
  audioHost.append(playerMount);
  const title = h("strong", { class: "jukebox-title" });
  const by = h("p", { class: "jukebox-by", hidden: true });
  const note = h("p", { class: "jukebox-note", hidden: true }, "The video player could not load, so the jukebox is silent.");
  const stateChip = h("span", { class: "chip", role: "status", "aria-live": "polite" });
  const sizeBtn = h("button", {
    type: "button",
    class: "jukebox-size",
    onclick: () => {
      large = !large;
      writeLarge(large);
      render(ctx.store.state);
    },
  });
  const tapBtn = h(
    "button",
    { type: "button", class: "jukebox-tap", hidden: true, onclick: () => player?.playVideo() },
    icon("play", 18),
    "Tap to play",
  );

  function applyVolume(): void {
    const p = prefs.value;
    volume.value = String(Math.round(p.jukeboxVolume * 100));
    if (player === null) return;
    player.setVolume(Math.round(100 * p.jukeboxVolume * p.volume));
    if (p.muted) player.mute();
    else player.unMute();
  }

  /** Creates the player once the API has loaded; it applies the room's state when ready. A load that fails, or a
   *  player that never reports ready, makes the jukebox unavailable until a later attempt succeeds. */
  function ensurePlayer(): void {
    if (playerBuild !== null) return;
    const { promise, resolve, reject } = Promise.withResolvers<YtPlayer>();
    playerBuild = promise;
    const readyTimer = setTimeout(() => reject(new Error("The video player did not start.")), PLAYER_READY_MS);
    loadApi().then((yt) => {
      try {
        // YouTube replaces its target with the player frame: a fresh inner node keeps the frame inside the mount,
        // so hiding the mount hides it and clearing the mount removes a frame that becomes ready too late.
        const target = h("div");
        playerMount.replaceChildren(target);
        const created = new yt.Player(target, {
          width: "100%",
          height: "100%",
          // The page origin lets the embed target its postMessage calls; without it the API warns on each message.
          playerVars: { origin: location.origin },
          events: {
            onReady: () => resolve(created),
            // removed, private or not embeddable: like the original, ask for another song
            onError: () => ctx.toast("The jukebox could not play this video. Try another one.", "error"),
            onStateChange: (e) => {
              playerState = e.data;
              render(ctx.store.state);
            },
          },
        });
      } catch (err) {
        reject(err);
      }
    }, reject);
    promise.then(
      (p) => {
        clearTimeout(readyTimer);
        player = p;
        unavailable = false;
        applyVolume();
        apply();
      },
      () => {
        clearTimeout(readyTimer);
        playerBuild = null;
        playerMount.replaceChildren();
        unavailable = true;
        music.setJukebox(false);
        render(ctx.store.state);
      },
    );
  }

  /** Brings the player in line with the room's jukebox: load, play, pause, or seek when it drifted. */
  function apply(): void {
    if (player === null) return;
    const jb = current;
    if (jb === null) {
      loadedId = null;
      player.pauseVideo();
      return;
    }
    const at = jb.position + (jb.playing ? (performance.now() - heardAt) / 1000 : 0);
    if (jb.video !== loadedId) {
      loadedId = jb.video;
      if (jb.playing) player.loadVideoById(jb.video, at);
      else player.cueVideoById(jb.video, at);
      return;
    }
    if (Math.abs(player.getCurrentTime() - at) > DRIFT_S) player.seekTo(at, true);
    if (jb.playing) player.playVideo();
    else player.pauseVideo();
  }

  // A click or key press is a gesture: the browser lets the player start then, so a playing room's video starts.
  function onGesture(): void {
    if (player !== null && current?.playing === true && NOT_PLAYING.has(playerState)) player.playVideo();
  }
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("keydown", onGesture, true);

  function playLink(): void {
    const id = parseYouTubeId(urlInput.value);
    if (id === null) {
      ctx.toast("Paste a YouTube video link.", "error");
      return;
    }
    ctx.send({ t: "jukebox", action: "play", video: id });
    urlInput.value = "";
  }

  const urlInput = h("input", {
    type: "url",
    class: "jukebox-url",
    placeholder: "YouTube link",
    "aria-label": "YouTube link",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 200,
    onkeydown: (e: Event) => {
      if (e instanceof KeyboardEvent && e.key === "Enter") playLink();
    },
  });
  const toggleBtn = h("button", {
    type: "button",
    onclick: () => ctx.send({ t: "jukebox", action: current?.playing ? "pause" : "resume" }),
  });
  const hostRow = h(
    "div",
    { class: "jukebox-host" },
    h("div", { class: "jukebox-add" }, urlInput, h("button", { type: "button", onclick: playLink }, icon("play", 18), "Play")),
    h(
      "div",
      { class: "jukebox-transport" },
      toggleBtn,
      h("button", { type: "button", onclick: () => ctx.send({ t: "jukebox", action: "stop" }) }, icon("square", 18), "Stop"),
    ),
  );
  const volume = h("input", {
    type: "range",
    min: 0,
    max: 100,
    step: 1,
    "aria-label": "jukebox volume",
    value: String(Math.round(prefs.value.jukeboxVolume * 100)),
    oninput: () => prefs.set({ jukeboxVolume: Number(volume.value) / 100 }),
  });
  const topRow = h(
    "div",
    { class: "jukebox-top" },
    h("div", { class: "jukebox-info" }, title, by, h("div", { class: "jukebox-meta" }, stateChip, sizeBtn)),
    note,
  );
  const panel = h(
    "section",
    { class: "jukebox", "aria-label": "Jukebox", hidden: true },
    topRow,
    tapBtn,
    hostRow,
    h("label", { class: "jukebox-volume" }, h("span", { title: "Volume" }, icon("volume-2", 18)), volume),
  );

  function render(state: AppState): void {
    const jb = state.room?.jukebox ?? null;
    const showPanel = jb !== null && prefs.value.jukeboxPopup;
    panel.hidden = !showPanel;
    // Keep the iframe inside the clipped audioHost whenever the popup is hidden or video is off,
    // so display:none on the hidden popup never pauses or blocks audio playback.
    const showVideo = showPanel && large && !unavailable;
    const targetParent = showVideo ? topRow : audioHost;
    if (playerMount.parentElement !== targetParent) {
      if (showVideo) topRow.insertBefore(playerMount, note);
      else audioHost.append(playerMount);
    }
    playerMount.toggleAttribute("inert", !showVideo);
    playerMount.hidden = unavailable;
    if (!showPanel || jb === null) return;
    title.textContent = jb.title;
    // The latest chat line that pasted the room's link names its suggester; the server does not send one.
    const suggests = state.chat.filter((line) => line.suggest?.video === jb.video);
    const suggester = suggests.length > 0 ? suggests[suggests.length - 1].name : null;
    by.hidden = suggester === null;
    by.textContent = suggester === null ? "" : `suggested by ${suggester}`;
    stateChip.replaceChildren(icon(unavailable ? "triangle-alert" : jb.playing ? "play" : "pause", 14), unavailable ? "Unavailable" : jb.playing ? "Playing" : "Paused");
    stateChip.className = jb.playing && !unavailable ? "chip ink" : "chip";
    panel.classList.toggle("is-large", large);
    panel.dataset.playerState = String(playerState);
    sizeBtn.textContent = large ? "Hide video" : "Show video";
    note.hidden = !unavailable;
    tapBtn.hidden = unavailable || !jb.playing || !NOT_PLAYING.has(playerState);
    toggleBtn.replaceChildren(icon(jb.playing ? "pause" : "play", 18), jb.playing ? "Pause" : "Resume");
    hostRow.hidden = !isHost(state);
  }

  document.body.append(audioHost, panel);
  prefs.subscribe(() => {
    applyVolume();
    render(ctx.store.state);
  });
  ctx.store.subscribe((next, prev) => {
    const jb = next.room?.jukebox ?? null;
    if (jb !== (prev.room?.jukebox ?? null)) {
      current = jb;
      heardAt = performance.now();
      if (jb === null) unavailable = false;
      if (jb !== null) ensurePlayer();
      apply();
      music.setJukebox(jb?.playing === true && !unavailable);
    }
    if (next.room !== prev.room || next.myId !== prev.myId || next.chat !== prev.chat) render(next);
  });
  render(ctx.store.state);
}
