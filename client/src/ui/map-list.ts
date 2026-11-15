// Shared pieces of the map library UI: cached map codes, lazily drawn preview
// thumbnails, map cards and the tab strips. The library screen and the room's map picker use them.

import {
  getMap,
  listFavourites,
  listLibrary,
  listMine,
  type LibraryMap,
  type LibraryQuery,
  type LibrarySort,
  type MapStatus,
  type Visibility,
} from "../account";
import type { AppCtx } from "../ctx";
import { drawMapPreview } from "../render/preview";
import { h, type Child } from "./dom";

export type LibraryTab = "browse" | "mine" | "favourites";

export const SORT_LABELS: Record<LibrarySort, string> = {
  hot: "Hot",
  top: "Top rated",
  new: "New",
  plays: "Most played",
  picks: "Staff picks",
};

export const STATUS_LABELS: Record<MapStatus, string> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
};

/** Map codes by id, fetched once per page load (a map's code never changes). */
const codes = new Map<number, Promise<string>>();

export function mapCode(id: number): Promise<string> {
  let code = codes.get(id);
  if (code === undefined) {
    code = getMap(id).then(
      (map) => map.code,
      (err: unknown) => {
        codes.delete(id);
        throw err;
      },
    );
    codes.set(id, code);
  }
  return code;
}

export function loadTab(tab: LibraryTab, query: LibraryQuery): Promise<LibraryMap[]> {
  if (tab === "browse") return listLibrary(query);
  return tab === "mine" ? listMine() : listFavourites();
}

interface Pending {
  ctx: AppCtx;
  id: number;
}

const waiting = new WeakMap<Element, Pending>();
let observer: IntersectionObserver | undefined;

function onVisible(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const job = waiting.get(entry.target);
    if (job === undefined) continue;
    observer?.unobserve(entry.target);
    waiting.delete(entry.target);
    void drawThumb(entry.target, job.ctx, job.id);
  }
}

async function drawThumb(box: Element, ctx: AppCtx, id: number): Promise<void> {
  const canvas = box.querySelector("canvas");
  if (!canvas) return;
  try {
    const code = await mapCode(id);
    await ctx.engine();
    drawMapPreview(canvas, ctx.wasm.mapPreview(code));
  } catch {
    box.replaceChildren(h("span", { class: "thumb-missing" }, "No preview"));
  }
}

/**
 * A preview thumbnail for map `id`. The code is fetched and drawn only once the
 * thumbnail scrolls near the viewport, so long lists stay cheap.
 */
export function previewThumb(ctx: AppCtx, id: number, class_ = "map-thumb"): HTMLElement {
  const box = h("span", { class: class_ }, h("canvas", { "aria-hidden": "true" }));
  waiting.set(box, { ctx, id });
  observer ??= new IntersectionObserver(onVisible, { rootMargin: "200px" });
  observer.observe(box);
  return box;
}

/** Draw a preview of a code the player is typing; resolves with an error message when it is not a valid map. */
export async function previewCode(ctx: AppCtx, canvas: HTMLCanvasElement, code: string): Promise<string | null> {
  try {
    await ctx.engine();
    drawMapPreview(canvas, ctx.wasm.mapPreview(code));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Visibility and approval state of one of your own maps, e.g. "Public · Awaiting approval". */
export function mapState(map: LibraryMap): string {
  const parts = [VISIBILITY_LABELS[map.visibility]];
  if (map.visibility === "public") parts.push(STATUS_LABELS[map.status]);
  return parts.join(" · ");
}

/** "1 vote", "2 plays": a count with its word. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A row of tabs (`.tabs`): one `tab` is selected. `label` names the tablist. */
export function tabStrip<T extends string>(
  label: string,
  items: readonly (readonly [T, string])[],
  current: T,
  onSelect: (value: T) => void,
): HTMLElement {
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": label },
    items.map(([value, text]) =>
      h(
        "button",
        {
          type: "button",
          class: "tab",
          role: "tab",
          "aria-selected": value === current ? "true" : "false",
          onclick: () => onSelect(value),
        },
        text,
      ),
    ),
  );
}

/** The library's tab strip (browse, mine, favourites). */
export function tabBar(current: LibraryTab, onSelect: (tab: LibraryTab) => void): HTMLElement {
  return tabStrip(
    "Library",
    [
      ["browse", "Browse"],
      ["mine", "Mine"],
      ["favourites", "Favourites"],
    ] as const,
    current,
    onSelect,
  );
}

/**
 * A map as a card: the square preview, then name, author, votes and plays. A staff pick
 * gets a chip; `withState` adds the visibility and approval state (your own maps).
 */
export function mapCard(ctx: AppCtx, map: LibraryMap, onOpen: () => void, withState = false): HTMLElement {
  const lines: Child[] = [
    h("span", { class: "map-name" }, map.name),
    h("span", { class: "map-meta" }, `by ${map.author}`),
    h("span", { class: "map-stats num" }, `${plural(map.votes, "vote")} · ${plural(map.plays, "play")}`),
  ];
  if (map.pick) lines.push(h("span", { class: "chip" }, "Staff pick"));
  if (withState) lines.push(h("span", { class: "map-state" }, mapState(map)));
  return h("li", null, h("button", { type: "button", class: "map-card", onclick: onOpen }, previewThumb(ctx, map.id), h("span", { class: "map-body" }, lines)));
}
