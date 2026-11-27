// Home: the first screen. The wordmark, the name field, the destinations as a drum (Quick play and
// Browse rooms first, then every other place), and the recorded match clips playing in a panel (the GL view is masked to its
// rounded corners). With no clip the panel is a flat field with the mark. Signed-in accounts play under their account name.

import { lastAccountName, listMakers, refreshAccount } from "../../account";
import { fetchStats } from "../../api";
import type { ScreenFactory } from "../../ctx";
import { levelOf } from "../../levels";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { prefs } from "../../prefs";
import { type Account, type AppState, type Screen } from "../../state";
import { local } from "../../storage";
import { NAME_STORAGE_KEY, TRAINING_SEEN_KEY } from "../../storage-keys";
import { h } from "../dom";
import { reducedMotion } from "../a11y";
import { type IconName, icon } from "../icons";
import { mountMenuClips } from "../menu-clips";
import { hasUnreadNews, openNews } from "../news";
import { REPO_URL } from "./about";
import { type DrumItem, mountDrum } from "./menu-drum";

const STATS_REFRESH_MS = 10_000;

/** The view's mask while a clip plays: the card's rounded corners (menu.css .menu-square's radius). */
const CARD_CLIP = "inset(0 round 18px)";

/** The destinations, in drum order. The description is the hint shown while the option is centred. */
const DESTINATIONS: { label: string; screen: Screen; icon: IconName; desc: string }[] = [
  { label: "Training", screen: "training", icon: "dumbbell", desc: "Learn the moves against dummies that never attack." },
  { label: "Practice", screen: "practice", icon: "swords", desc: "Play alone on a built-in or pasted map, offline." },
  { label: "Library", screen: "library", icon: "library-big", desc: "Browse maps, your own maps and your favourites." },
  { label: "Friends", screen: "friends", icon: "users", desc: "Your friends and friend requests." },
  { label: "Replay", screen: "replay", icon: "film", desc: "Watch saved matches again." },
  { label: "Map editor", screen: "editor", icon: "pencil-ruler", desc: "Draw your own floating maps and try them." },
  { label: "Settings", screen: "settings", icon: "settings", desc: "Controls, sound and display." },
  { label: "About", screen: "about", icon: "info", desc: "What neobox is, credits and the licence." },
];

/** The rule every name follows (the server applies the same one). */
const NAME_RULE = "Names are 1 to 15 letters, numbers, spaces or _.";

/** Why `raw` cannot be a name, naming the characters not allowed, or null when it can. Names are never rewritten. */
export function nameProblem(raw: string): string | null {
  const name = raw.trim();
  if (NAME_RE.test(name)) return null;
  const bad = Array.from(new Set(name.replace(/[A-Za-z0-9 _]/g, "")));
  if (bad.length === 0) return NAME_RULE;
  return `Names can't use ${bad.map((c) => `"${c}"`).join(" ")}. ${NAME_RULE}`;
}

export function readStoredName(): string {
  try {
    return local.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredName(name: string): void {
  try {
    local.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Storage blocked (private mode, quota): the name still applies to this session.
  }
}

/** Keep a typed guest name for the next visit as soon as it is valid, so every entry path starts with it. */
export function saveTypedName(raw: string): void {
  const name = raw.trim();
  if (nameProblem(name) === null) writeStoredName(name);
}

/** A guest name for a first visit: "Box" and four digits. */
export function guestName(): string {
  return `Box${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

/** The guest name kept on this device; a first visit gets one now, so sign-out can restore it. */
function storedGuestName(): string {
  const stored = readStoredName();
  if (stored !== "") return stored;
  const fresh = guestName();
  writeStoredName(fresh);
  return fresh;
}

function readFlag(key: string): boolean {
  try {
    return local.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    local.setItem(key, "1");
  } catch {
    // Storage blocked: the badge simply shows again next visit.
  }
}

function statusText(state: AppState): string {
  if (state.connection === "connecting") return "Connecting…";
  if (state.connection === "open") return "Connected.";
  return state.connectDetail ? `Disconnected: ${state.connectDetail}` : "Disconnected.";
}

/** A square icon-only button in the top bar; the label is its accessible name and tooltip. */
function toolButton(name: IconName, label: string, onclick: () => void): HTMLButtonElement {
  return h("button", { type: "button", class: "icon quiet home-tool", "aria-label": label, title: label, onclick }, icon(name, 20));
}

/** Swap the glyph and label of a top-bar button (mute, fullscreen). */
function setToolIcon(btn: HTMLElement, name: IconName, label: string): void {
  btn.replaceChildren(icon(name, 20));
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

export const menuScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  const glHost = document.getElementById("gl-host");
  // The overlay canvas (names, kill feed, objective bar) is masked with the game view.
  const overlay = document.getElementById("overlay");
  let attempted = false;
  let nameTouched = false;
  let shownAccount: Account | null | undefined;
  let statsDown = false;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const nameError = h("p", { class: "field-error", role: "alert", hidden: true });
  // Server lines with no data say so and offer Try again; the chip in the top bar says the connection is down.
  const onlineText = h("span");
  const statsRetry = h("button", { type: "button", class: "quiet menu-retry", hidden: true, "aria-label": "Try again", onclick: () => retryConnection() }, icon("refresh-cw", 18), "Try again");
  const onlineLine = h("p", { class: "menu-online" }, onlineText, statsRetry);
  const offlineChip = h("p", { class: "home-offline", role: "status", hidden: true }, "Offline: online play, accounts and the library need a connection");
  const makersLine = h("p", { class: "menu-makers", hidden: true });

  // Signed-in accounts play under their account name, which cannot be edited here.
  const account = store.state.account;
  // A first visit gets a suggested guest name, so Browse rooms works straight away; it can be changed.
  const initialName = account?.name ?? (store.state.name || storedGuestName());

  const nameInput = h("input", {
    type: "text",
    class: "home-name-input",
    placeholder: "name",
    maxlength: MAX_NAME_LEN,
    size: 12,
    autocomplete: "nickname",
    spellcheck: "false",
    "aria-label": "Your name",
    value: initialName,
    readonly: account !== null,
    oninput: () => {
      nameTouched = true;
      sync();
      saveTypedName(nameInput.value);
    },
    onblur: () => {
      nameTouched = true;
      sync();
    },
  });
  const leadEl = h("span", { class: "home-name-lead" }, "Playing as");
  const pencil = icon("pencil", 16);

  const accountBtn = h("button", {
    type: "button",
    class: "home-tool home-account quiet",
    onclick: () => store.set({ screen: "account" }),
  });

  /** Guests see "Sign in"; signed-in players see the account icon and their level under one label. */
  function setAccount(acc: Account | null): void {
    if (acc) {
      accountBtn.setAttribute("aria-label", `Account, Level ${levelOf(acc.xp)}`);
      accountBtn.replaceChildren(icon("user", 20), h("span", { class: "home-level" }, `Level ${levelOf(acc.xp)}`));
    } else {
      accountBtn.removeAttribute("aria-label");
      accountBtn.replaceChildren(icon("user", 20), h("span", null, navigator.onLine ? "Sign in" : "Account"));
    }
  }

  const unreadMark = h("span", { class: "home-unread", "aria-hidden": "true", hidden: !hasUnreadNews() });
  const muteBtn = toolButton("volume-2", "Mute music", () => prefs.set({ musicMuted: !prefs.value.musicMuted }));
  const fullscreenBtn = toolButton("maximize", "Fullscreen", () => toggleFullscreen());
  fullscreenBtn.hidden = !document.fullscreenEnabled;

  /** Enable Browse rooms only when the name is valid; say why once the player has typed or left the field. */
  function sync(): void {
    const problem = nameProblem(nameInput.value);
    const shown = nameTouched ? problem : null;
    drum.setDisabled("browse", problem !== null);
    nameError.textContent = shown ?? "";
    nameError.hidden = shown === null;
    nameInput.setAttribute("aria-invalid", String(shown !== null));
  }

  /** Connect with the name and show the room browser once the server welcomes us. */
  function go(): void {
    if (nameProblem(nameInput.value) !== null) {
      nameTouched = true;
      sync();
      nameInput.focus();
      return;
    }
    const typed = nameInput.value.trim();
    let name = typed;
    // A locked field shows an account name: a signed-in player plays under it; offline it is only remembered, so the guest name plays.
    if (!nameInput.readOnly) {
      nameInput.value = typed;
      writeStoredName(typed);
    } else if (!shownAccount) {
      name = storedGuestName();
    }
    attempted = true;
    store.set({ name, intent: null });
    // Offline there is nothing to connect to: the offline page for Browse takes over, and its Retry connects.
    if (navigator.onLine) {
      // The browser opens at once with its loading state; the server's welcome and room list fill it in.
      store.set({ screen: "browse", pending: { kind: "list", error: null } });
      ctx.play(name);
    } else store.set({ screen: "browse" });
  }

  function syncMute(): void {
    const muted = prefs.value.musicMuted;
    setToolIcon(muteBtn, muted ? "volume-x" : "volume-2", muted ? "Unmute music" : "Mute music");
  }

  function toggleFullscreen(): void {
    const request =
      document.fullscreenElement !== null ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    // The label follows fullscreenchange, which a refused request never fires: say so instead of doing nothing.
    request.catch(() => ctx.toast("The browser did not change fullscreen.", "error"));
  }

  function syncFullscreen(): void {
    const on = document.fullscreenElement !== null;
    setToolIcon(fullscreenBtn, on ? "minimize" : "maximize", on ? "Exit fullscreen" : "Fullscreen");
  }

  /** Players online: a fetch now. A failure marks the server unreachable until a fetch works. */
  async function refreshStats(): Promise<void> {
    try {
      const s = await fetchStats();
      statsDown = false;
      onlineText.textContent = `${s.online} ${s.online === 1 ? "player" : "players"} online`;
    } catch {
      statsDown = true;
    }
    syncConnection();
  }

  /** Timer and connection events: fetch only while the browser is online; offline the lines say so. */
  function pollStats(): void {
    if (navigator.onLine) void refreshStats();
    else syncConnection();
  }

  /** Retry the server lines that have no data: players online, and the account. */
  function retryConnection(): void {
    void refreshStats();
    void refreshAccount(ctx);
  }

  async function loadMakers(): Promise<void> {
    if (!navigator.onLine) {
      makersLine.hidden = true;
      return;
    }
    try {
      const makers = await listMakers();
      makersLine.textContent = `Top map makers this week: ${makers.map((m) => m.name).join(" · ")}`;
      makersLine.hidden = makers.length === 0;
    } catch {
      makersLine.hidden = true;
    }
  }

  /** The connection as the menu shows it: the top-bar chip, and the server lines that have no data. */
  function syncConnection(): void {
    const down = !navigator.onLine || statsDown;
    offlineChip.hidden = !down;
    onlineLine.classList.toggle("is-down", down);
    statsRetry.hidden = !down;
    if (down) onlineText.textContent = "Server unavailable";
    // Offline the account is unknown, not absent: the button says Account and its page says why.
    if (!shownAccount) setAccount(null);
    syncName();
  }

  /**
   * The name field. A signed-in player's name, or on this device the account last seen while offline,
   * is shown read-only; a guest types their own name, restored when the lock lifts.
   */
  function syncName(): void {
    const name = shownAccount ? shownAccount.name : navigator.onLine ? "" : lastAccountName();
    const wasLocked = nameInput.readOnly;
    if (name !== "") nameInput.value = name;
    else if (wasLocked) nameInput.value = storedGuestName();
    nameInput.readOnly = name !== "";
    leadEl.textContent = shownAccount ? "Signed in as" : name !== "" ? "Last signed in as" : "Playing as";
    pencil.style.display = name !== "" ? "none" : "";
    sync();
  }

  // The clip card: the GL view behind the UI shows only inside it while a clip plays. Its shape is the arena's inside its
  // boundary walls (setCardAspect). When cycling between replays, the outgoing frame is snapshotted behind #gl-host while
  // the incoming live replay slides over it with a soft cast shadow.
  const shadowRibbon = h("div", { class: "menu-clip-shadow", hidden: true });
  const square = h("div", { class: "menu-square", "aria-hidden": "true" }, h("span", { class: "mark" }), shadowRibbon);
  const art = h("div", { class: "menu-art" }, square);

  const cardFrame = h("div", { class: "menu-clip-frame", "aria-hidden": "true", hidden: true });
  const outgoingCanvas = h("canvas", { class: "menu-clip-outgoing" });
  const outgoingHost = h("div", { class: "menu-clip-under", "aria-hidden": "true", hidden: true }, outgoingCanvas);
  if (glHost?.parentElement) {
    glHost.parentElement.insertBefore(cardFrame, glHost);
    glHost.parentElement.insertBefore(outgoingHost, glHost);
  }

  const SLIDE_MS = 740;
  let slideRaf = 0;
  let hasOutgoingSnap = false;

  /** The card takes the arena's shape (width / height); CSS fits it generously inside the right column. */
  function setCardAspect(aspect: number): void {
    const safe = Number.isFinite(aspect) && aspect > 0.4 && aspect < 3.5 ? aspect : 1.6;
    square.style.setProperty("--card-aspect", String(safe));
  }

  function setMask(clipPath: string): void {
    if (glHost) glHost.style.clipPath = clipPath;
    if (overlay) overlay.style.clipPath = clipPath;
  }

  function setViewTransform(transform: string): void {
    if (glHost) glHost.style.transform = transform;
    if (overlay) overlay.style.transform = transform;
  }

  function stopSlide(): void {
    if (slideRaf !== 0) {
      cancelAnimationFrame(slideRaf);
      slideRaf = 0;
    }
    hasOutgoingSnap = false;
    outgoingHost.hidden = true;
    outgoingCanvas.style.transform = "";
    outgoingCanvas.style.filter = "";
    shadowRibbon.hidden = true;
    shadowRibbon.style.transform = "";
    shadowRibbon.style.opacity = "";
    setViewTransform("");
  }

  /** Capture the outgoing clip's final rendered frame right before loading the next clip. */
  function captureOutgoingFrame(): void {
    if (reducedMotion() || !glHost) return;
    const srcGl = glHost.querySelector("canvas");
    if (!srcGl || srcGl.width === 0 || srcGl.height === 0) return;
    stopSlide();
    outgoingCanvas.width = srcGl.width;
    outgoingCanvas.height = srcGl.height;
    const outCtx = outgoingCanvas.getContext("2d");
    if (!outCtx) return;
    outCtx.clearRect(0, 0, outgoingCanvas.width, outgoingCanvas.height);
    outCtx.drawImage(srcGl, 0, 0, outgoingCanvas.width, outgoingCanvas.height);
    if (overlay instanceof HTMLCanvasElement && overlay.width > 0 && overlay.height > 0) {
      outCtx.drawImage(overlay, 0, 0, outgoingCanvas.width, outgoingCanvas.height);
    }
    outgoingCanvas.style.transform = "translate3d(0, 0, 0) scale(1)";
    outgoingCanvas.style.filter = "brightness(1)";
    outgoingHost.hidden = false;
    hasOutgoingSnap = true;
    // Hide the live surface until the incoming clip draws its first frame, leaving the outgoing snapshot seamless.
    setMask("inset(0 0 0 100%)");
  }

  /** Pan the outgoing replay subtly left while sliding the live incoming replay over it with a cast shadow. */
  function startSlideIn(): void {
    if (!hasOutgoingSnap || reducedMotion()) {
      stopSlide();
      setMask(CARD_CLIP);
      return;
    }
    const startAt = performance.now();
    shadowRibbon.hidden = false;
    const step = (now: number): void => {
      const t = Math.min(1, Math.max(0, (now - startAt) / SLIDE_MS));
      // Smooth quartic ease-out for a weighty, cinematic card glide.
      const e = 1 - (1 - t) ** 4;
      const w = square.clientWidth || 1;
      const dx = (1 - e) * w;
      const leftR = Math.max(0, Math.min(18, 18 - dx));

      setViewTransform(`translate3d(${dx.toFixed(2)}px, 0, 0)`);
      setMask(`inset(0 ${dx.toFixed(2)}px 0 0 round ${leftR.toFixed(1)}px 18px 18px ${leftR.toFixed(1)}px)`);

      const panX = -0.22 * e * w;
      const scale = 1 - 0.03 * e;
      const dim = 1 - 0.42 * e;
      outgoingCanvas.style.transform = `translate3d(${panX.toFixed(2)}px, 0, 0) scale(${scale.toFixed(4)})`;
      outgoingCanvas.style.filter = `brightness(${dim.toFixed(3)})`;

      shadowRibbon.style.transform = `translate3d(${dx.toFixed(2)}px, 0, 0)`;
      shadowRibbon.style.opacity = String(Math.min(1, (1 - e) * 3.5));

      if (t < 1) {
        slideRaf = requestAnimationFrame(step);
      } else {
        slideRaf = 0;
        stopSlide();
        setMask(CARD_CLIP);
      }
    };
    slideRaf = requestAnimationFrame(step);
  }

  // Whole view masked until a clip draws: a frame left on the canvas (the clip that just ended, the match before) must not
  // flash over the window.
  setMask("inset(50%)");
  const unmountClips = mountMenuClips(
    ctx,
    square,
    (state) => {
      square.classList.toggle("is-live", state === "live");
      square.classList.toggle("is-idle", state === "idle");
      cardFrame.hidden = state !== "live";
      if (state === "idle") {
        stopSlide();
        setCardAspect(1.6);
      }
      if (!hasOutgoingSnap) setMask(state === "live" ? CARD_CLIP : "inset(50%)");
    },
    setCardAspect,
    {
      beforeSwitch: captureOutgoingFrame,
      onReady: startSlideIn,
    },
  );


  const form = h(
    "form",
    {
      class: "home-form",
      onsubmit: (e: Event) => {
        e.preventDefault();
        go();
      },
    },
    h(
      "label",
      { class: "home-name" },
      leadEl,
      nameInput,
      pencil,
    ),
  );

  // The training badge marks the first visit only; choosing Training dismisses it for good.
  const trainingBadge = h("span", { class: "home-badge", "aria-hidden": "true", hidden: readFlag(TRAINING_SEEN_KEY) }, "Start here");
  // Every destination, in drum order: Profile and News above, then Quick play (selected at load, so the window shows
  // options above and below it, not an empty end) and Browse rooms, then the rest.
  const items: DrumItem[] = [
    { id: "account", label: "Profile", icon: "user", hint: "Your account and your level.", run: () => store.set({ screen: "account" }) },
    {
      id: "news",
      label: "News",
      icon: "newspaper",
      hint: "What has changed in neobox.",
      extra: unreadMark,
      run: () => {
        openNews();
        unreadMark.hidden = !hasUnreadNews();
      },
    },
    { id: "quick", label: "Quick play", icon: "zap", hint: "Jump into a match now.", run: () => store.set({ screen: "quick" }) },
    { id: "browse", label: "Browse rooms", icon: "door-open", hint: "Pick a room to join, or start one.", run: () => go() },
    ...DESTINATIONS.map(
      (d): DrumItem => ({
        id: d.screen,
        label: d.label,
        icon: d.icon,
        hint: d.desc,
        extra: d.screen === "training" ? trainingBadge : undefined,
        run: () => {
          if (d.screen === "training") {
            writeFlag(TRAINING_SEEN_KEY);
            trainingBadge.hidden = true;
          }
          store.set({ screen: d.screen });
        },
      }),
    ),
  ];
  const drum = mountDrum(
    items,
    "Destinations",
    items.findIndex((it) => it.id === "quick"),
    () => {
      ctx.sfx.unlock();
      ctx.sfx.ui("scroll");
    },
    () => {
      ctx.sfx.unlock();
      ctx.sfx.ui("click");
    },
  );

  sync();
  syncMute();
  syncFullscreen();
  pollStats();
  void loadMakers();
  const statsTimer = window.setInterval(pollStats, STATS_REFRESH_MS);
  const onConnection = (): void => {
    if (navigator.onLine) {
      pollStats();
      void loadMakers();
    }
    syncConnection();
  };
  window.addEventListener("online", onConnection);
  window.addEventListener("offline", onConnection);
  const unsubPrefs = prefs.subscribe(() => syncMute());
  document.addEventListener("fullscreenchange", syncFullscreen);

  const el = h(
    "main",
    { class: "page home" },
    h("header", { class: "home-top" }, offlineChip, h("div", { class: "home-tools" }, accountBtn, muteBtn, fullscreenBtn)),
    h(
      "div",
      { class: "home-copy enter" },
      h("h1", { class: "home-title" }, h("span", { class: "mark", "aria-hidden": "true" }), "neobox"),
      form,
      nameError,
      onlineLine,
      status,
    ),
    h("nav", { class: "home-index", "aria-label": "more" }, drum.listbox, drum.hint),
    // After the index: the art's clip control is the last stop before the footer, as it is visually on phones (order 3)
    // and in reading order on wide screens (right column). Grid areas and flex order place it, not the DOM.
    art,
    h(
      "footer",
      { class: "home-foot" },
      makersLine,
      h(
        "p",
        { class: "home-links" },
        "Fan-made successor to Hitbox.io · ",
        h("a", { href: REPO_URL, target: "_blank", rel: "noopener", tabindex: "0" }, "Source"),
        " · ",
        h("button", { type: "button", class: "quiet home-privacy", onclick: () => store.set({ screen: "privacy" }) }, "Privacy"),
        " · ",
        h("button", { type: "button", class: "quiet home-privacy", onclick: () => store.set({ screen: "terms" }) }, "Terms"),
      ),
    ),
  );

  setAccount(account);
  shownAccount = account;
  syncConnection();

  return {
    el,
    update(state) {
      status.textContent = attempted ? statusText(state) : "";
      if (state.account !== shownAccount) {
        shownAccount = state.account;
        syncConnection();
        setAccount(state.account);
      }
    },
    destroy() {
      window.clearInterval(statsTimer);
      window.removeEventListener("online", onConnection);
      window.removeEventListener("offline", onConnection);
      unsubPrefs();
      document.removeEventListener("fullscreenchange", syncFullscreen);
      unmountClips();
      stopSlide();
      cardFrame.remove();
      outgoingHost.remove();
      setMask("");
      drum.destroy();
      el.remove();
    },
  };
};
