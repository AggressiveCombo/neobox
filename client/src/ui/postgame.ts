// Post-game panel for a finished custom-room match: placement, the experience gained (counted
// up), the level bar and a map vote for the library map that was played. Quick-play rotation
// awards are shown by the HUD instead, so this panel only receives custom-room awards.

import { errorText, voteMap } from "../account";
import type { AppCtx } from "../ctx";
import { addGuestXp, GUEST_XP_CAP, guestXp, levelOf, xpForLevel } from "../levels";
import { isTeamMode, type MapMeta, type RoomState, type XpAward } from "../protocol";
import { h } from "./dom";

/** Wait before the count starts, so the panel is read before it moves. */
const START_DELAY_MS = 500;
/** One experience point per 1000/60 ms. */
const STEP_MS = 1000 / 60;
/** Sound kinds (audio.ts): a soft blip per point, the rising chord on a level-up. */
const TICK_SOUND = 10;
const LEVEL_SOUND = 20;
const LEVELUP_FLASH_MS = 900;

type Vote = -1 | 0 | 1;

const VOTES: readonly { vote: Vote; label: string }[] = [
  { vote: -1, label: "Bad" },
  { vote: 0, label: "Meh" },
  { vote: 1, label: "Good" },
];

/** Library map ids the viewer has voted on this session; those maps are not offered again. */
const votedMaps = new Set<number>();

/** Guest totals before and after an award, so the award is added to this browser's total once. */
const guestCredit = new WeakMap<XpAward, { before: number; total: number }>();

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** The headline: team modes report won or lost, other modes the player's place. */
function placeText(award: XpAward, room: RoomState | null): string {
  const mode = room?.settings["game_mode"];
  const teams = typeof mode === "number" && isTeamMode(mode);
  if (award.placement < 1) return "Game over";
  if (teams) return award.placement === 1 ? "Your team won" : "Your team lost";
  return `Placed ${ordinal(award.placement)}`;
}

function limitText(limit: XpAward["limit"]): string | null {
  if (limit === "short") return "Hourly XP limit reached, so this game gave less.";
  if (limit === "long") return "Daily XP limit reached, so this game gave less.";
  return null;
}

/** A guest's total before and after the award. The award is added to the local total only once. */
function guestGain(award: XpAward): { before: number; total: number } {
  let credit = guestCredit.get(award);
  if (credit === undefined) {
    const before = guestXp();
    credit = { before, total: addGuestXp(award.gained) };
    guestCredit.set(award, credit);
  }
  return credit;
}

/**
 * Open the post-game panel. `map` is the room's library map (the vote needs it); null hides the vote.
 * Guests' experience lives in this browser, so their gain is added to the local total here.
 * The count starts from the total before the award and adds one point per step, rolling the
 * level bar over as levels are passed. Returns a function that closes the panel.
 */
export function showPostGame(ctx: AppCtx, award: XpAward, map: MapMeta | null): () => void {
  const xp = award.xp;
  const guest = xp === null;
  const { before, total } = xp === null ? guestGain(award) : { before: Math.max(0, xp - award.gained), total: xp };

  const gainEl = h("p", { class: "postgame-gain", role: "status" }, "+0 xp");
  const levelLabel = h("span", null, "");
  const levelRange = h("span", { class: "row-sub" }, "");
  const levelHead = h("div", { class: "postgame-level-head" }, levelLabel, levelRange);
  const bar = h("span", { class: "postgame-bar-fill" });
  // The count moves the bar itself; the CSS width transition would lag behind it.
  bar.style.transition = "none";
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const limit = limitText(award.limit);

  let shownLevel = levelOf(before);
  let steps = 0;
  let raf = 0;
  let levelFlash = 0;
  const start = performance.now();

  function paint(value: number): void {
    const level = levelOf(value);
    const from = xpForLevel(level);
    const span = xpForLevel(level + 1) - from;
    levelLabel.textContent = guest ? "Guest" : `Level ${level}`;
    levelRange.textContent = `${value - from} / ${span} xp`;
    bar.style.width = `${(100 * (value - from)) / span}%`;
  }

  function flashLevel(level: number): void {
    shownLevel = level;
    levelHead.classList.add("is-levelup");
    ctx.sfx.play(LEVEL_SOUND, 0.5);
    clearTimeout(levelFlash);
    levelFlash = window.setTimeout(() => levelHead.classList.remove("is-levelup"), LEVELUP_FLASH_MS);
  }

  function frame(now: number): void {
    const next = Math.min(award.gained, Math.max(0, Math.floor((now - start - START_DELAY_MS) / STEP_MS)));
    if (next !== steps) {
      steps = next;
      const value = before + steps;
      gainEl.textContent = `+${steps} xp`;
      paint(value);
      if (levelOf(value) > shownLevel) flashLevel(levelOf(value));
      ctx.sfx.play(TICK_SOUND, 0.4);
    }
    if (steps < award.gained) raf = requestAnimationFrame(frame);
  }

  paint(before);
  const startTimer = window.setTimeout(() => {
    raf = requestAnimationFrame(frame);
  }, START_DELAY_MS);

  // The vote is for signed-in viewers, on a library map they did not write, once per session.
  const account = ctx.store.state.account;
  const voteTarget =
    xp !== null && map !== null && account !== null && account.name !== map.author && !votedMaps.has(map.id) ? map : null;

  const voteButtons = VOTES.map(({ vote, label }) => {
    const btn: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        "aria-pressed": "false",
        onclick: () => {
          if (voteTarget === null) return;
          void voteMap(voteTarget.id, vote).then(
            () => {
              votedMaps.add(voteTarget.id);
              for (const b of voteButtons) b.setAttribute("aria-pressed", String(b === btn));
              status.textContent = "Thanks for voting.";
            },
            (err: unknown) => {
              status.textContent = errorText(err);
            },
          );
        },
      },
      label,
    );
    return btn;
  });

  const closeBtn = h("button", { type: "button", class: "primary", onclick: () => dismiss() }, "Back to room");
  const sheet = h(
    "section",
    { class: "picker-sheet postgame-sheet" },
    h("header", { class: "picker-head" }, h("h2", null, "Game over")),
    h("p", { class: "postgame-place" }, placeText(award, ctx.store.state.room)),
    gainEl,
    h("div", { class: "postgame-level" }, levelHead, h("div", { class: "postgame-bar" }, bar)),
    guest
      ? h(
          "p",
          { class: "credit" },
          total >= GUEST_XP_CAP ? "Create an account to level up!" : "Your experience is kept in this browser.",
        )
      : null,
    limit ? h("p", { class: "status" }, limit) : null,
    voteTarget === null
      ? null
      : h(
          "div",
          { class: "postgame-vote" },
          h("span", { class: "row-sub" }, `How was ${voteTarget.name}?`),
          h("div", { class: "actions" }, voteButtons),
        ),
    status,
    h("div", { class: "actions" }, closeBtn),
  );
  const overlay: HTMLDivElement = h(
    "div",
    {
      class: "picker-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Game over",
      onclick: (e: Event) => {
        if (e.target === overlay) dismiss();
      },
    },
    sheet,
  );

  function dismiss(): void {
    clearTimeout(startTimer);
    cancelAnimationFrame(raf);
    clearTimeout(levelFlash);
    window.removeEventListener("keydown", onKey);
    overlay.remove();
    if (ctx.store.state.xp === award) ctx.store.set({ xp: null });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") dismiss();
  }

  window.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return dismiss;
}
