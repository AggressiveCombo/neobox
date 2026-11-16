// Home: the first screen. The wordmark, the name field, the two ways in (Quick play for a
// match now, Browse rooms for everything else), the destinations as an icon index, and the
// recorded match clips playing inside a giant turned square (the GL view is masked to the
// square). With no clip the square is a flat field with the mark. Signed-in accounts play
// under their account name.

import { listMakers } from "../../account";
import { fetchStats } from "../../api";
import type { ScreenFactory } from "../../ctx";
import { levelOf } from "../../levels";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { prefs } from "../../prefs";
import { type Account, type AppState, NAME_STORAGE_KEY, type Screen } from "../../state";
import { type Child, h } from "../dom";
import { type IconName, icon } from "../icons";
import { avatar } from "../kit";
import { mountMenuClips } from "../menu-clips";
import { hasUnreadNews, openNews } from "../news";
import { REPO_URL } from "./about";

const STATS_REFRESH_MS = 10_000;
/** Tilt of the home square, degrees. */
const SQUARE_ANGLE = -18;
/** localStorage flag: the first-visit "Start here" badge on Training was dismissed. */
const TRAINING_SEEN_KEY = "neobox.hintSeen";

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

/** Keep only allowed characters, cut to the server limit, trim. */
export function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _]/g, "").slice(0, MAX_NAME_LEN).trim();
}

export function readStoredName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeStoredName(name: string): void {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Storage blocked (private mode, quota): the name still applies to this session.
  }
}

/** A guest name for a first visit: "Box" and four digits. */
function guestName(): string {
  return `Box${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
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
  let liveClip = false;
  let shownAccount: Account | null | undefined;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const onlineLine = h("p", { class: "menu-online" });
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
      sync();
    },
  });

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
      const swatch = avatar(acc.name, null, false);
      swatch.setAttribute("aria-hidden", "true");
      accountBtn.setAttribute("aria-label", `Account, Level ${levelOf(acc.xp)}`);
      accountBtn.replaceChildren(swatch, h("span", { class: "home-level" }, `Level ${levelOf(acc.xp)}`));
    } else {
      accountBtn.removeAttribute("aria-label");
      accountBtn.replaceChildren(icon("user", 20), h("span", null, "Sign in"));
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

  /** Enable Browse rooms only when the name is valid. */
  function sync(): void {
    browseBtn.disabled = !NAME_RE.test(sanitizeName(nameInput.value));
  }

  /** Connect with the name and show the room browser once the server welcomes us. */
  function go(): void {
    const name = sanitizeName(nameInput.value);
    if (!NAME_RE.test(name)) return;
    nameInput.value = name;
    writeStoredName(name);
    attempted = true;
    store.set({ name, intent: null });
    ctx.play(name);
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

  async function refreshStats(): Promise<void> {
    try {
      const s = await fetchStats();
      onlineLine.textContent = `${s.online} ${s.online === 1 ? "player" : "players"} online`;
    } catch {
      // Keep the last number; the next tick retries.
    }
  }

  async function loadMakers(): Promise<void> {
    try {
      const makers = await listMakers();
      makersLine.textContent = `Top map makers this week: ${makers.map((m) => m.name).join(" · ")}`;
      makersLine.hidden = makers.length === 0;
    } catch {
      makersLine.hidden = true;
    }
  }

  // The clip square: the GL view behind the UI shows only inside it while a clip plays.
  const square = h("div", { class: "menu-square", "aria-hidden": "true" }, h("span", { class: "mark" }));
  square.style.setProperty("--angle", `${SQUARE_ANGLE}deg`);
  const creditSlot = h("div", { class: "menu-credit" });
  const art = h("div", { class: "menu-art" }, square, creditSlot);

  /** Mask the game view and its overlay to the square's corners while a clip plays; otherwise show nothing of them. */
  function fitView(): void {
    if (!glHost) return;
    if (!liveClip) {
      setMask("");
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
      h("span", { class: "home-name-lead" }, account ? "Signed in as" : "Playing as"),
      nameInput,
      account ? null : icon("pencil", 16),
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
  void refreshStats();
  void loadMakers();
  const statsTimer = window.setInterval(() => void refreshStats(), STATS_REFRESH_MS);
  const unsubPrefs = prefs.subscribe(() => syncMute());
  document.addEventListener("fullscreenchange", syncFullscreen);

  const el = h(
    "main",
    { class: "page home" },
    h("header", { class: "home-top" }, h("div", { class: "home-tools" }, accountBtn, newsBtn, muteBtn, fullscreenBtn)),
    h(
      "div",
      { class: "home-copy enter" },
      h("h1", { class: "home-title" }, h("span", { class: "mark", "aria-hidden": "true" }), "neobox"),
      form,
      onlineLine,
      status,
    ),
    art,
    h("nav", { class: "home-index", "aria-label": "more" }, ...rows),
    h(
      "footer",
      { class: "home-foot" },
      makersLine,
      h(
        "p",
        { class: "home-links" },
        "Fan-made successor to Hitbox.io · ",
        h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "Source"),
        " · ",
        h("button", { type: "button", class: "quiet home-privacy", onclick: () => store.set({ screen: "privacy" }) }, "Privacy"),
      ),
    ),
  );

  setAccount(account);
  shownAccount = account;

  return {
    el,
    update(state) {
      status.textContent = attempted ? statusText(state) : "";
      if (state.account !== shownAccount) {
        shownAccount = state.account;
        setAccount(state.account);
      }
      if (state.account) {
        nameInput.value = state.account.name;
        nameInput.readOnly = true;
        sync();
      }
    },
    destroy() {
      window.clearInterval(statsTimer);
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
