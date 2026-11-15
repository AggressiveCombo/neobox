// Home: the first screen. The wordmark and one sentence, the name field, Play and Quick
// play, the destinations as an index with previews, and the recorded match clips playing
// inside a giant turned square (the GL view is masked to the square). With no clip the
// square is a flat field with the mark. Signed-in accounts play under their account name.

import { listMakers } from "../../account";
import { fetchStats } from "../../api";
import type { ScreenFactory } from "../../ctx";
import { levelOf } from "../../levels";
import { MAX_NAME_LEN, NAME_RE } from "../../protocol";
import { prefs } from "../../prefs";
import type { Account, AppState, Screen } from "../../state";
import { NAME_STORAGE_KEY } from "../../state";
import { h } from "../dom";
import { avatar, uid } from "../kit";
import { mountMenuClips } from "../menu-clips";
import { hasUnreadNews, openNews } from "../news";
import { CREDIT_LINE, LICENSE_URL, REPO_URL } from "./about";
import { privacyLink } from "./privacy";

const STATS_REFRESH_MS = 10_000;
/** Tilt of the home square, degrees. */
const SQUARE_ANGLE = -18;
/** localStorage flag: the first-visit hint was dismissed. */
const HINT_KEY = "neobox.hintSeen";

/** The destinations, in index order. Each description shows on hover or focus (inline on phones). */
const DESTINATIONS: { label: string; screen: Screen; desc: string }[] = [
  { label: "Training", screen: "training", desc: "Learn the moves against a dummy that cannot hurt you." },
  { label: "Practice", screen: "practice", desc: "Play against bots on any map, offline." },
  { label: "Library", screen: "library", desc: "Maps you saved for later." },
  { label: "Friends", screen: "friends", desc: "Your friends and friend requests." },
  { label: "Replay", screen: "replay", desc: "Watch saved matches again." },
  { label: "Map editor", screen: "editor", desc: "Draw your own floating maps and try them." },
  { label: "Settings", screen: "settings", desc: "Controls, sound and display." },
  { label: "About", screen: "about", desc: "What neobox is, credits and the licence." },
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
    // Storage blocked: the hint simply shows again next visit.
  }
}

function statusText(state: AppState): string {
  if (state.connection === "connecting") return "Connecting…";
  if (state.connection === "open") return "Connected.";
  return state.connectDetail ? `Disconnected: ${state.connectDetail}` : "Disconnected.";
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
  const preview = h("p", { class: "home-preview", "aria-hidden": "true" });

  // Signed-in accounts play under their account name, which cannot be edited here.
  const account = store.state.account;
  // A first visit gets a suggested guest name, so Play works straight away; it can be changed.
  const initialName = account?.name ?? (store.state.name || readStoredName() || guestName());

  const nameInput = h("input", {
    type: "text",
    placeholder: "name",
    maxlength: MAX_NAME_LEN,
    autocomplete: "nickname",
    spellcheck: "false",
    "aria-label": "name",
    value: initialName,
    readonly: account !== null,
    oninput: () => {
      sync();
    },
  });

  const playBtn = h("button", { type: "submit", class: "primary big" }, "Play");
  const quickBtn = h(
    "button",
    { type: "button", class: "big", onclick: () => store.set({ screen: "quick" }) },
    "Quick play",
  );

  const accountBtn = h("button", {
    type: "button",
    class: "home-tool home-account",
    onclick: () => store.set({ screen: "account" }),
  });
  const levelLine = h("span", { class: "home-level", hidden: true });

  /** Guests see "Sign in"; signed-in players see their avatar, "Account" and their level. */
  function setAccount(acc: Account | null): void {
    if (acc) {
      const swatch = avatar(acc.name, null, false);
      swatch.setAttribute("aria-hidden", "true");
      accountBtn.replaceChildren(swatch, "Account");
      levelLine.textContent = `Level ${levelOf(acc.xp)}`;
      levelLine.hidden = false;
    } else {
      accountBtn.replaceChildren("Sign in");
      levelLine.hidden = true;
    }
  }

  const unreadMark = h("span", { class: "home-unread", "aria-hidden": "true", hidden: !hasUnreadNews() });
  const newsBtn = h(
    "button",
    {
      type: "button",
      class: "home-tool",
      onclick: () => {
        openNews();
        unreadMark.hidden = !hasUnreadNews();
      },
    },
    "News",
    unreadMark,
  );
  const muteBtn = h("button", {
    type: "button",
    class: "home-tool",
    onclick: () => prefs.set({ musicMuted: !prefs.value.musicMuted }),
  });
  const fullscreenBtn = h("button", {
    type: "button",
    class: "home-tool",
    hidden: !document.fullscreenEnabled,
    onclick: () => toggleFullscreen(),
  });

  const hint = h(
    "div",
    { class: "home-hint", hidden: readFlag(HINT_KEY) },
    h("p", null, "New here? Start with Training, below. It teaches the moves before you play anyone."),
    h(
      "button",
      {
        type: "button",
        class: "quiet",
        onclick: () => {
          writeFlag(HINT_KEY);
          hint.hidden = true;
        },
      },
      "Got it",
    ),
  );

  /** Enable the play button only when the name is valid. */
  function sync(): void {
    playBtn.disabled = !NAME_RE.test(sanitizeName(nameInput.value));
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
    muteBtn.textContent = prefs.value.musicMuted ? "Unmute music" : "Mute music";
  }

  function toggleFullscreen(): void {
    const request =
      document.fullscreenElement !== null ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    // The browser refuses without a user gesture or when the page is already in the state asked for.
    request.catch(() => undefined);
  }

  function syncFullscreen(): void {
    fullscreenBtn.textContent = document.fullscreenElement !== null ? "Exit fullscreen" : "Fullscreen";
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
      { class: "field home-name" },
      h("span", { class: "field-label" }, account ? "Signed in as" : "Your name"),
      nameInput,
    ),
    h("div", { class: "actions home-actions" }, playBtn, quickBtn),
  );

  // Each destination: the button's name is the label; its description is linked, not part of the name.
  const rows = DESTINATIONS.map((d) => {
    const descId = uid("home-desc");
    const show = (): void => {
      preview.textContent = d.desc;
    };
    const clear = (): void => {
      preview.textContent = "";
    };
    return h(
      "div",
      { class: "home-row" },
      h(
        "button",
        {
          type: "button",
          class: "home-row-btn",
          "aria-describedby": descId,
          onpointerenter: show,
          onpointerleave: clear,
          onfocus: show,
          onblur: clear,
          onclick: () => store.set({ screen: d.screen }),
        },
        d.label,
      ),
      h("p", { class: "home-row-desc", id: descId }, d.desc),
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
    h(
      "header",
      { class: "home-top" },
      h("div", { class: "home-tools" }, accountBtn, levelLine, newsBtn, muteBtn, fullscreenBtn),
    ),
    h(
      "div",
      { class: "home-copy enter" },
      h("h1", { class: "home-title" }, h("span", { class: "mark", "aria-hidden": "true" }), "neobox"),
      h("p", { class: "home-lead" }, "Square fighters batting each other off floating maps, free to play in your browser with no install."),
      onlineLine,
      form,
      status,
      hint,
    ),
    art,
    h("nav", { class: "home-index", "aria-label": "more" }, ...rows),
    preview,
    h(
      "footer",
      { class: "home-foot" },
      makersLine,
      h("p", { class: "credit" }, CREDIT_LINE),
      h(
        "p",
        { class: "home-links" },
        h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "Source"),
        " · ",
        h("a", { href: LICENSE_URL, target: "_blank", rel: "noopener" }, "AGPL-3.0-or-later"),
        " · ",
        privacyLink(store),
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
