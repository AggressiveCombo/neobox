// Shared pieces of the map library UI: cached map codes, lazily drawn preview
// thumbnails and the per-tab queries. The library screen and the room's map picker use them.

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
import { h } from "./dom";

export type LibraryTab = "browse" | "mine" | "favourites";

export const SORT_LABELS: Record<LibrarySort, string> = {
  new: "Newest",
  hot: "Hot",
  top: "Top rated",
  plays: "Most played",
  picks: "Staff picks",
};

export const STATUS_LABELS: Record<MapStatus, string> = {
  pending: "awaiting approval",
  approved: "approved",
  rejected: "rejected",
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: "public",
  unlisted: "unlisted",
  private: "private",
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
    box.replaceChildren(h("span", { class: "thumb-missing" }, "no preview"));
  }
}

/**
 * A preview thumbnail for map `id`. The code is fetched and drawn only once the
 * thumbnail scrolls near the viewport, so long lists stay cheap.
 */
export function previewThumb(ctx: AppCtx, id: number): HTMLElement {
  const box = h("div", { class: "map-thumb" }, h("canvas", { "aria-hidden": "true" }));
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

/** Status line for a map: visibility, plus approval state for public maps. */
export function mapState(map: LibraryMap): string {
  const parts = [VISIBILITY_LABELS[map.visibility]];
  if (map.visibility === "public") parts.push(STATUS_LABELS[map.status]);
  return parts.join(" · ");
}

/** The library's tab strip (browse, mine, favourites). */
export function tabBar(current: LibraryTab, onSelect: (tab: LibraryTab) => void): HTMLElement {
  const tabs: [LibraryTab, string][] = [
    ["browse", "Browse"],
    ["mine", "Mine"],
    ["favourites", "Favourites"],
  ];
  return h(
    "div",
    { class: "library-tabs", role: "tablist" },
    tabs.map(([tab, label]) =>
      h(
        "button",
        { type: "button", class: "tab", role: "tab", "aria-selected": tab === current ? "true" : "false", onclick: () => onSelect(tab) },
        label,
      ),
    ),
  );
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 || n === -1 ? "" : "s"}`;
}

/** The text lines of a map card: name, then author and counts, then visibility state. */
export function mapLines(map: LibraryMap): HTMLElement[] {
  const lines: HTMLElement[] = [
    h("span", { class: "map-name" }, map.name),
    h("span", { class: "map-meta" }, `by ${map.author} · ${count(map.votes, "vote")} · ${count(map.plays, "play")}`),
    h("span", { class: "map-meta" }, mapState(map)),
  ];
  if (map.pick) lines.push(h("span", { class: "map-pick" }, "Staff pick"));
  if (map.description !== "") lines.push(h("span", { class: "map-desc" }, map.description));
  return lines;
}
