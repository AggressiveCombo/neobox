// Scoreboard table and kill/hit event log, shared by the in-match HUD and the replay viewer.
// The table is the DOM view of a scene's score rows; the log is the DOM view of the scene's
// confirmed kills and bat hits (logHits; the canvas feed draws kills too; this copy is for screen readers and QA).

import { HIT_KIND_PLAYER, type Scene, type ScoreRow } from "../frame";
import { TEAM_BLUE, TEAM_FFA, TEAM_RED, TEAM_SPECTATOR } from "../protocol";
import { h } from "./dom";

/** Log entries kept in the DOM; older ones drop off. */
const EVENTS_MAX = 512;

export interface Scoreboard {
  /** The score table (`.hud-scores`). */
  readonly el: HTMLElement;
  /** Kill and hit log (`.hud-events` list in a role "log" region); screen-reader only. */
  readonly events: HTMLElement;
  /** Redraw the table from the scene's score rows. `myId` is highlighted (-1 for none). */
  render(scene: Scene, names: ReadonlyMap<number, string>, myId: number, tickHz: number): void;
  /** Append the confirmed kills and bat hits this scene adds (each present reports only new events). */
  record(scene: Scene, names: ReadonlyMap<number, string>): void;
  /** Empty the log (a replay seek starts a new run of events). */
  clear(): void;
}

/** Display order of scoreboard teams; unknown teams sort last. */
const TEAM_ORDER: readonly number[] = [TEAM_RED, TEAM_BLUE, TEAM_FFA, TEAM_SPECTATOR];

function teamRank(team: number): number {
  const i = TEAM_ORDER.indexOf(team);
  return i === -1 ? TEAM_ORDER.length : i;
}

function teamInfo(team: number): { label: string; cls: string } {
  switch (team) {
    case TEAM_RED:
      return { label: "Red", cls: "hud-team-red" };
    case TEAM_BLUE:
      return { label: "Blue", cls: "hud-team-blue" };
    case TEAM_FFA:
      return { label: "FFA", cls: "hud-team-ffa" };
    default:
      return { label: "spectator", cls: "hud-team-spec" };
  }
}

function statusText(row: ScoreRow, tickHz: number): string {
  if (row.alive) return "alive";
  if (row.eliminated !== 0) return "eliminated";
  if (row.respawn <= 0) return "dead";
  return tickHz > 0 ? `respawn ${(row.respawn / tickHz).toFixed(1)}s` : `respawn ${Math.ceil(row.respawn)} ticks`;
}

function scoreRow(row: ScoreRow, name: string, self: boolean, tickHz: number): HTMLTableRowElement {
  const team = teamInfo(row.team);
  return h(
    "tr",
    { class: self ? "hud-row hud-row-self" : "hud-row", "data-id": row.id },
    h("td", { class: "hud-name" }, name),
    h("td", { class: team.cls }, team.label),
    h("td", { class: "hud-num" }, String(Math.round(row.kills))),
    h("td", { class: "hud-num" }, String(Math.round(row.wins))),
    h("td", { class: "hud-num" }, String(Math.round(row.lives))),
    h("td", null, statusText(row, tickHz)),
  );
}

export function createScoreboard(): Scoreboard {
  const tbody = h("tbody");
  const el = h(
    "section",
    { class: "hud-scores", "aria-label": "Scoreboard" },
    h(
      "table",
      { class: "hud-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "Player"),
          h("th", null, "Team"),
          h("th", { class: "hud-num" }, "Kills"),
          h("th", { class: "hud-num" }, "Wins"),
          h("th", { class: "hud-num" }, "Lives"),
          h("th", null, "Status"),
        ),
      ),
      tbody,
    ),
  );
  const list = h("ol", { class: "hud-events" });
  const events = h("div", { role: "log", "aria-label": "Kills and hits" }, list);
  let lastKey = "";

  function render(scene: Scene, names: ReadonlyMap<number, string>, myId: number, tickHz: number): void {
    const rows = [...scene.scores].sort((a, b) => teamRank(a.team) - teamRank(b.team) || a.id - b.id);
    // Rebuild only when a shown value changed: the table would otherwise be redrawn every frame.
    const key = `${myId}|${tickHz}|${rows.map((r) => [r.id, r.team, r.kills, r.wins, r.lives, r.alive, r.respawn, r.eliminated].join(",")).join(";")}`;
    if (key === lastKey) return;
    lastKey = key;
    tbody.replaceChildren(
      ...rows.map((row) => scoreRow(row, names.get(row.id) ?? `#${row.id}`, row.id === myId, tickHz)),
    );
  }

  // Each present's frame feed holds only the events new since the previous frame, so each is logged once.
  function record(scene: Scene, names: ReadonlyMap<number, string>): void {
    const who = (id: number): string => (id < 0 ? "nobody" : (names.get(id) ?? `#${id}`));
    const lines = [
      ...scene.kills.map((k) => ({ text: `${who(k.killer)} KO ${who(k.victim)}`, kind: "ko" as const, tick: k.tick })),
      ...scene.logHits.map((hit) => {
        const target = hit.kind === HIT_KIND_PLAYER ? who(hit.index) : hit.kind === 0 ? "a body" : "a projectile";
        return { text: `${who(hit.swinger)} hit ${target}`, kind: "hit" as const, tick: hit.tick };
      }),
    ];
    if (lines.length === 0) return;
    list.append(
      ...lines.map((l) =>
        h("li", { class: `hud-event hud-event-${l.kind}`, "data-tick": l.tick, "data-kind": l.kind }, l.text),
      ),
    );
    while (list.childElementCount > EVENTS_MAX) list.firstElementChild?.remove();
  }

  function clear(): void {
    list.replaceChildren();
  }

  return { el, events, render, record, clear };
}
