// Post-game panel for a finished custom-room match: the placement, the experience gained
// (counted up), the level meter with its level-up moment, and a map vote for the library map
// that was played. Quick-play rotation awards are shown by the HUD instead, so this panel only
// receives custom-room awards.

import { errorText, voteMap } from "../account";
import type { AppCtx } from "../ctx";
import { addGuestXp, GUEST_XP_CAP, guestXp, levelOf, xpForLevel } from "../levels";
import { isTeamMode, type MapMeta, type RoomState, TEAM_SPECTATOR, type XpAward } from "../protocol";
import { h } from "./dom";
import { openModal } from "./kit";

/** Wait before the count starts, so the panel is read before it moves. */
const START_DELAY_MS = 500;
/** One experience point per 1000/60 ms. */
const STEP_MS = 1000 / 60;
/** Sound kinds (audio.ts): a soft blip per point, the rising chord on a level-up. */
const TICK_SOUND = 10;
const LEVEL_SOUND = 20;

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

/** The hero line: team modes report won or lost, other modes the placement. Null when nothing was placed. */
function placeLine(award: XpAward, room: RoomState | null): { big: string; of: string | null } | null {
  if (award.placement < 1) return null;
  const mode = room?.settings["game_mode"];
  const teams = typeof mode === "number" && isTeamMode(mode);
  if (teams) return { big: award.placement === 1 ? "You won!" : "You lost", of: null };
  const players = room === null ? 0 : room.players.filter((p) => p.team !== TEAM_SPECTATOR).length;
  return { big: ordinal(award.placement), of: players > 0 ? `of ${players}` : null };
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
 * level meter over as levels are passed. Returns a function that closes the panel.
 */
export function showPostGame(ctx: AppCtx, award: XpAward, map: MapMeta | null): () => void {
  const xp = award.xp;
  const guest = xp === null;
  const { before, total } = xp === null ? guestGain(award) : { before: Math.max(0, xp - award.gained), total: xp };

  const place = placeLine(award, ctx.store.state.room);
  const gainEl = h("p", { class: "postgame-gain num" }, "+0 xp");
  const levelName = h("span", { class: "postgame-level-name" });
  const levelRange = h("span", { class: "postgame-level-range num" });
  const bar = h("span");
  // The count moves the bar itself; the CSS width transition would lag behind it.
  bar.style.transition = "none";
  const levelUpText = h("span");
  const levelUp = h(
    "p",
    { class: "postgame-levelup", role: "status", hidden: true },
    h("span", { class: "mark", "aria-hidden": "true" }),
    levelUpText,
  );
  const status = h("p", { class: "muted small", role: "status", "aria-live": "polite" });
  const limit = limitText(award.limit);

  let shownLevel = levelOf(before);
  let steps = 0;
  let raf = 0;
  // The count begins after the delay; frames before that yield a zero step.
  const start = performance.now() + START_DELAY_MS;

  function paint(value: number): void {
    const level = levelOf(value);
    const from = xpForLevel(level);
    const span = xpForLevel(level + 1) - from;
    levelName.textContent = guest ? "Guest" : `Level ${level}`;
    levelRange.textContent = `${value - from} / ${span} xp`;
    bar.style.width = `${(100 * (value - from)) / span}%`;
  }

  function flashLevel(level: number): void {
    shownLevel = level;
    levelUpText.textContent = `Level ${level}!`;
    levelUp.hidden = false;
    // Restart the entrance animation for each new level.
    levelUp.classList.remove("is-new");
    void levelUp.offsetWidth;
    levelUp.classList.add("is-new");
    ctx.sfx.play(LEVEL_SOUND, 0.5);
  }

  function frame(now: number): void {
    const next = Math.min(award.gained, Math.max(0, Math.floor((now - start) / STEP_MS)));
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
  raf = requestAnimationFrame(frame);

  // The vote is for signed-in viewers, on a library map they did not write, once per session.
  const account = ctx.store.state.account;
  const voteTarget =
    xp !== null && map !== null && account !== null && account.name !== map.author && !votedMaps.has(map.id) ? map : null;

  const voteButtons: HTMLButtonElement[] = VOTES.map(({ vote, label }) => {
    const btn: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        class: "seg-option",
        "aria-pressed": "false",
        onclick: () => {
          if (voteTarget === null) return;
          void voteMap(voteTarget.id, vote).then(
            () => {
              votedMaps.add(voteTarget.id);
              for (const b of voteButtons) b.setAttribute("aria-pressed", String(b === btn));
              status.className = "muted small";
              status.textContent = "Thanks for voting.";
            },
            (err: unknown) => {
              status.className = "field-error";
              status.textContent = errorText(err);
            },
          );
        },
      },
      label,
    );
    return btn;
  });

  const guestNote = guest
    ? h(
        "p",
        { class: "postgame-note" },
        total >= GUEST_XP_CAP ? "Guests stop at level 1. Create an account to keep levelling up." : "Create an account to keep your levels.",
      )
    : null;

  const body = h(
    "div",
    { class: "postgame" },
    place
      ? h(
          "p",
          { class: "postgame-place" },
          place.big,
          place.of ? h("span", { class: "postgame-of" }, place.of) : null,
        )
      : null,
    gainEl,
    h(
      "div",
      { class: "postgame-level" },
      h("div", { class: "postgame-level-head" }, levelName, levelRange),
      h("div", { class: "meter" }, bar),
      levelUp,
    ),
    guestNote,
    limit ? h("p", { class: "muted small" }, limit) : null,
    voteTarget === null
      ? null
      : h(
          "div",
          { class: "postgame-vote" },
          h("span", { class: "postgame-vote-q" }, `How was ${voteTarget.name}?`),
          h("div", { class: "seg", role: "group", "aria-label": `Rate ${voteTarget.name}` }, voteButtons),
        ),
    status,
  );

  const closeBtn = h("button", { type: "button", class: "primary", onclick: () => close() }, "Back to room");
  const { close } = openModal({
    title: "Game over",
    body: [body],
    actions: [closeBtn],
    onclose: () => {
      cancelAnimationFrame(raf);
      if (ctx.store.state.xp === award) ctx.store.set({ xp: null });
    },
  });
  return close;
}
