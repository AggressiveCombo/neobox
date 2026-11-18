// Home: the first screen. The wordmark, the name field, the two ways in (Quick play for a
// match now, Browse rooms for everything else), the destinations as an icon index, and the
// recorded match clips playing inside a giant turned square (the GL view is masked to the
// square). With no clip the square is a flat field with the mark. Signed-in accounts play
// under their account name.

import { lastAccountName, listMakers, refreshAccount } from "../../account";
import { fetchStats } from "../../api";
import type { ScreenFactory } from "../../ctx";
import { levelOf } from "../../levels";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { prefs } from "../../prefs";
import { type Account, type AppState, type Screen } from "../../state";
import { local } from "../../storage";
import { NAME_STORAGE_KEY, TRAINING_SEEN_KEY } from "../../storage-keys";
import { type Child, h } from "../dom";
import { type IconName, icon } from "../icons";
import { avatar } from "../kit";
import { mountMenuClips } from "../menu-clips";
import { hasUnreadNews, openNews } from "../news";
import { REPO_URL } from "./about";

const STATS_REFRESH_MS = 10_000;
/** Tilt of the home square, degrees. */
const SQUARE_ANGLE = -18;

/** The destinations, in index order. The description is the button's tooltip. */
const DESTINATIONS: { label: string; screen: Screen; icon: IconName; desc: string }[] = [
  { label: "Training", screen: "training", icon: "dumbbell", desc: "Learn the moves against a dummy that cannot hurt you." },
  { label: "Practice", screen: "practice", icon: "swords", desc: "Play against bots on any map, offline." },
  { label: "Library", screen: "library", icon: "library-big", desc: "Maps you saved for later." },
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
  let liveClip = false;
  let shownAccount: Account | null | undefined;
  let statsDown = false;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const nameError = h("p", { class: "field-error", role: "alert", hidden: true });
  // Server lines with no data say so and offer Try again; the chip in the top bar says the connection is down.
  const onlineText = h("span");
  const statsRetry = h("button", { type: "button", class: "quiet menu-retry", hidden: true, "aria-label": "Try again: players online", onclick: () => retryConnection() }, "Try again");
  const onlineLine = h("p", { class: "menu-online" }, onlineText, statsRetry);
  const accountRetry = h("button", { type: "button", class: "quiet menu-retry", "aria-label": "Try again: account", onclick: () => retryConnection() }, "Try again");
  const accountLine = h("p", { class: "menu-account-line", hidden: true }, h("span", null, "Account unavailable offline"), accountRetry);
  const offlineChip = h("p", { class: "home-offline", role: "status", hidden: true }, "Offline: online play, accounts and the library need a connection");
  const makersLine = h("p", { class: "menu-makers", hidden: true });

  // Signed-in accounts play under their account name, which cannot be edited here.
  const account = store.state.account;
  // A first visit gets a suggested guest name, so Browse rooms works straight away; it can be changed.
  const initialName = account?.name ?? (store.state.name || readStoredName() || guestName());

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

  const quickBtn = h(
    "button",
    { type: "button", class: "primary big home-quick", onclick: () => store.set({ screen: "quick" }) },
    icon("zap", 22),
    "Quick play",
  );
  const browseBtn = h("button", { type: "submit", class: "big home-browse" }, icon("door-open", 22), "Browse rooms");

  const accountBtn = h("button", {
    type: "button",
    class: "home-tool home-account quiet",
    onclick: () => store.set({ screen: "account" }),
  });

  /** Guests see "Sign in"; signed-in players see their avatar and level under one label. */
  function setAccount(acc: Account | null): void {
    if (acc) {
      // No letter: the button's visible text must match its label (axe label-content-name-mismatch).
      const swatch = avatar(acc.name, null, true);
      swatch.setAttribute("aria-hidden", "true");
      accountBtn.setAttribute("aria-label", `Account, Level ${levelOf(acc.xp)}`);
      accountBtn.replaceChildren(swatch, h("span", { class: "home-level" }, `Level ${levelOf(acc.xp)}`));
    } else {
      accountBtn.removeAttribute("aria-label");
      accountBtn.replaceChildren(icon("user", 20), h("span", null, navigator.onLine ? "Sign in" : "Account"));
    }
  }

  const unreadMark = h("span", { class: "home-unread", "aria-hidden": "true", hidden: !hasUnreadNews() });
  const newsBtn = toolButton("newspaper", "News", () => {
    openNews();
    unreadMark.hidden = !hasUnreadNews();
  });
  newsBtn.append(unreadMark);
  const muteBtn = toolButton("volume-2", "Mute music", () => prefs.set({ musicMuted: !prefs.value.musicMuted }));
  const fullscreenBtn = toolButton("maximize", "Fullscreen", () => toggleFullscreen());
  fullscreenBtn.hidden = !document.fullscreenEnabled;

  /** Enable Browse rooms only when the name is valid; say why once the player has typed or left the field. */
  function sync(): void {
    const problem = nameProblem(nameInput.value);
    const shown = nameTouched ? problem : null;
    browseBtn.disabled = problem !== null;
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
    if (navigator.onLine) ctx.play(name);
    else store.set({ screen: "browse" });
  }

  function syncMute(): void {
    const muted = prefs.value.musicMuted;
    setToolIcon(muteBtn, muted ? "volume-x" : "volume-2", muted ? "Unmute music" : "Mute music");
  }

  function toggleFullscreen(): void {
    const request =
      document.fullscreenElement !== null ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    // The browser refuses without a user gesture or when the page is already in the state asked for.
    request.catch(() => undefined);
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
    if (down) onlineText.textContent = "Players online unavailable";
    accountLine.hidden = navigator.onLine || Boolean(shownAccount);
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

  // The clip square: the GL view behind the UI shows only inside it while a clip plays.
  const square = h("div", { class: "menu-square", "aria-hidden": "true" }, h("span", { class: "mark" }));
  square.style.setProperty("--angle", `${SQUARE_ANGLE}deg`);
  const creditSlot = h("div", { class: "menu-credit" });
  const art = h("div", { class: "menu-art" }, square, creditSlot);

  /**
   * Mask the game view and its overlay to the square's corners while a clip plays. Otherwise
   * mask all of it: a frame left on the canvas (the clip that just ended, the match before)
   * must not flash over the whole window.
   */
  function fitView(): void {
    if (!glHost) return;
    if (!liveClip) {
      setMask("inset(50%)");
      return;
    }
    const r = square.getBoundingClientRect();
    const base = glHost.getBoundingClientRect();
    const cx = r.left + r.width / 2 - base.left;
    const cy = r.top + r.height / 2 - base.top;
    const radius = (square.offsetWidth / 2) * Math.SQRT2;
    const points: string[] = [];
    for (let k = 0; k < 4; k += 1) {
      const a = ((SQUARE_ANGLE + 45 + k * 90) * Math.PI) / 180;
      points.push(`${(cx + radius * Math.cos(a)).toFixed(1)}px ${(cy + radius * Math.sin(a)).toFixed(1)}px`);
    }
    setMask(`polygon(${points.join(", ")})`);
  }

  function setMask(clipPath: string): void {
    if (glHost) glHost.style.clipPath = clipPath;
    if (overlay) overlay.style.clipPath = clipPath;
  }

  const unmountClips = mountMenuClips(ctx, creditSlot, (on) => {
    liveClip = on;
    square.classList.toggle("is-live", on);
    fitView();
  });
  const resizeObserver = new ResizeObserver(() => fitView());
  resizeObserver.observe(square);
  fitView();
  window.addEventListener("resize", fitView);
  window.addEventListener("scroll", fitView, { capture: true, passive: true });

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
    h("div", { class: "home-actions" }, quickBtn, browseBtn),
  );

  // The training badge marks the first visit only; choosing Training dismisses it for good.
  const trainingBadge = h("span", { class: "home-badge", "aria-hidden": "true", hidden: readFlag(TRAINING_SEEN_KEY) }, "Start here");
  const rows = DESTINATIONS.map((d) => {
    const children: Child[] = [icon(d.icon, 22), h("span", { class: "home-row-label" }, d.label)];
    if (d.screen === "training") children.push(trainingBadge);
    return h(
      "button",
      {
        type: "button",
        class: "home-row-btn",
        title: d.desc,
        onclick: () => {
          if (d.screen === "training") {
            writeFlag(TRAINING_SEEN_KEY);
            trainingBadge.hidden = true;
          }
          store.set({ screen: d.screen });
        },
      },
      ...children,
    );
  });

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
    h("header", { class: "home-top" }, offlineChip, h("div", { class: "home-tools" }, accountBtn, newsBtn, muteBtn, fullscreenBtn)),
    h(
      "div",
      { class: "home-copy enter" },
      h("h1", { class: "home-title" }, h("span", { class: "mark", "aria-hidden": "true" }), "neobox"),
      form,
      nameError,
      onlineLine,
      accountLine,
      status,
    ),
    h("nav", { class: "home-index", "aria-label": "more" }, ...rows),
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
      window.removeEventListener("resize", fitView);
      window.removeEventListener("scroll", fitView, { capture: true });
      resizeObserver.disconnect();
      unmountClips();
      setMask("");
      el.remove();
    },
  };
};
