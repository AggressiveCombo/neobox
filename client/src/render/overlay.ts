// Canvas2D overlay above the renderer canvas: player names (with the local
// stamina bar), intro countdown, round/match banners, the local player's
// kill line, the kill feed and the objective bar. Drawn in CSS pixels; resize() takes
// device pixels.

import type { Camera, ViewRect } from "../camera";
import { findLocal, worldXf } from "../camera";
import type { Scene } from "../frame";
import { FLAG_AIR_JUMP, FLAG_FROZEN, FLAG_LOCAL, HIT_KIND_PLAYER } from "../frame";
import { TEAM_BLUE, TEAM_FFA, TEAM_RED, TEAM_SPECTATOR, isTeamMode } from "../protocol";
import { reducedMotion } from "../ui/a11y";
import { AWAY_RING_BELOW_LUM, cssHex, playerRgb, relLuminance } from "./geometry";

const NAME_FONT = "500 12px system-ui, sans-serif";
const LOCAL_NAME_FONT = "700 13px system-ui, sans-serif";
const INTRO_FONT = "700 72px system-ui, sans-serif";
/** Countdown numbers: start this many times their size and settle over INTRO_IN_S seconds. */
const INTRO_FROM = 1.35;
const INTRO_IN_S = 0.25;
const BANNER_TITLE_FONT = "700 22px system-ui, sans-serif";
const BANNER_SUB_FONT = "500 13px system-ui, sans-serif";
const CARD_LOWER_FONT = "700 110px system-ui, sans-serif";
const CARD_UPPER_FONT = "600 90px system-ui, sans-serif";
/** Winner card: a 35% black veil, #dddddd text, a 130 px box with a 10 px border (CSS content-box), rotated -28 degrees. */
const CARD_VEIL = "rgba(0, 0, 0, 0.35)";
const CARD_TEXT = "#dddddd";
const CARD_BOX = 130;
const CARD_BORDER = 10;
const CARD_ANGLE = (-28 * Math.PI) / 180;
/** The card waits CARD_DELAY_S after the round ends, fades in over CARD_FADE_S, then slides in over CARD_SLIDE_S after CARD_SLIDE_DELAY_S. */
const CARD_DELAY_S = 0.5;
const CARD_FADE_S = 0.3;
const CARD_SLIDE_DELAY_S = 0.2;
const CARD_SLIDE_S = 0.6;
const BAR_FONT = "500 13px system-ui, sans-serif";
const PERSONAL_FONT = "700 15px system-ui, sans-serif";
const FEED_FONT = "600 12px system-ui, sans-serif";
const OUTLINE = "rgba(0, 0, 0, 0.7)";
const PANEL = "rgba(0, 0, 0, 0.5)";
const TEXT = "#ffffff";
/** Stamina bar above the local name: the original's green fill on a black track, one CSS px tall like the label's fixed-size text. */
const STAMINA_FILL = "#34ba56";
const STAMINA_TRACK = "#000000";
const STAMINA_H = 1; // CSS px
/** Damage bar: black border (CSS px, centred on the body) and the white fill inside its 1 px rim. */
const BAR_BORDER_W = 32;
const BAR_BORDER_H = 6;
const BAR_FILL_W = 30;
const BAR_FILL_H = 4;
/** Local kill line: top edge and height, CSS px (under the objective bar). */
const PERSONAL_TOP = 42;
const PERSONAL_H = 28;
/** Kill feed, top right: top edge (below the Leave, Chat and End buttons), row height and gap. */
const FEED_TOP = 150;
const FEED_ROW_H = 20;
const FEED_GAP = 2;
/** Kill feed: lifetime in ms and the number of rows kept. */
const FEED_MS = 4000;
const FEED_MAX = 4;
/** Bat hit flash (ring around the hit player): lifetime in ms. */
const HIT_FLASH_MS = 160;
/** Objective bar: height, and its width limits (CSS px). */
const OBJECTIVE_H = 30;
const OBJECTIVE_MIN_W = 160;
const OBJECTIVE_MAX_W = 480;
/** Objective bar: the HUD chip ink (--hud-solid), the progress rule in the accent blue (lifted for the ink ground) and its height. */
const CHIP = "#0a0a0a";
const PROGRESS = "#3d94ff";
const RULE_H = 3;
/** Objective bar: its row sits this far below the view's top edge; it keeps CHIP_GAP from reserved bars. */
const BAR_ROW_INSET = 8;
const CHIP_GAP = 8;
/** Edge indicators (off-screen opponents): inset of the arrow from the view edge, arrow length, chip height, padding and gap. */
const AWAY_EDGE = 16;
const AWAY_ARROW = 9;
const AWAY_CHIP_H = 18;
const AWAY_CHIP_PAD = 5;
const AWAY_CHIP_GAP = 4;
/** Name chip: the player colour is a 6 px swatch on the panel (a non-text mark); the name is white. */
const AWAY_SWATCH = 6;
/** One drawn edge chip, in window CSS px (QA hook). */
interface AwayChip { id: number; x: number; y: number; w: number; h: number }
/** Name box, as the original's: 60% black, 18 CSS px tall, 3 px above the body, 3 px padding each side; white 80% text, no outline. */
const NAME_BOX_H = 18;
const NAME_BOX_GAP = 3;
const NAME_BOX_PAD = 3;
const NAME_BOX_FILL = "rgba(0, 0, 0, 0.6)";
const NAME_TEXT = "rgba(255, 255, 255, 0.8)";
/** Name labels: px gap between stacked labels, and the most upward shifts tried before a label stays overlapped. */
const NAME_GAP = 2;
const NAME_STACK_MAX = 4;
/** The followed player's marker (the original's jump emblem) above the box: tip gap in CSS px, height and half width in player sides, and its 1 px outline. */
const MARKER_GAP = 4; // box top to marker tip, CSS px (the original: about 4 device rows)
const MARKER_HEIGHT = 0.38; // of the body side
const MARKER_HALF_WIDTH = 0.31; // of the body side
/** The original's marker fill by body state (client bundle, marker draw): frozen blue, air jump ready yellow, air jump spent grey. */
const MARKER_FROZEN_FILL = "#6b8aff";
const MARKER_READY_FILL = "#ffd440";
const MARKER_SPENT_FILL = "#bbbbbb";
function markerFill(flags: number): string {
  if ((flags & FLAG_FROZEN) !== 0) return MARKER_FROZEN_FILL;
  return (flags & FLAG_AIR_JUMP) !== 0 ? MARKER_READY_FILL : MARKER_SPENT_FILL;
}
const MARKER_OUTLINE = "#000222";
/** A name label for this frame: anchor (box bottom-centre, CSS px) and its draw data. */
interface NameLabel {
  player: Scene["players"][number];
  name: string;
  x: number;
  y: number;
  local: boolean;
  /** The followed player: its marker sits above the box. */
  marked: boolean;
  font: string;
  /** Box width: the text plus NAME_BOX_PAD each side. */
  w: number;
  /** CSS px per player side at this zoom: the marker's scale. */
  unit: number;
}
/** Axis-aligned box of a placed name label, in CSS px. */
interface Box { left: number; right: number; top: number; bottom: number }
/** A drawn rect for the QA draw-order hook, in window CSS px. z: 0 = the GL layer (drawn first), 1 = the overlay canvas (drawn over GL). */
interface DrawRect { kind: "label" | "marker"; id: number; z: number; box: Box }

interface KillEntry {
  killer: number;
  victim: number;
  /** performance.now() when the kill was drawn first. */
  at: number;
}

const METRIC_CACHE_MAX = 512;
/** Name label sprites: room past the ink box for antialiasing; and the entries kept. */
const LABEL_PAD = 3;
const LABEL_SPRITE_MAX = 64;
/** A name label rendered once in device px; (ax, ay) is the text centre in it, CSS px. */
interface LabelSprite { canvas: HTMLCanvasElement; w: number; h: number; ax: number; ay: number }

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cssCache = new Map<number, string>();
  private readonly metricCache = new Map<string, { w: number; h: number }>();
  /** Name text is the overlay's costliest draw, so each label is drawn once into a sprite and blitted per frame. */
  private readonly labelSprites = new Map<string, LabelSprite>();
  private readonly feed: KillEntry[] = [];
  private readonly hitFlashes: { id: number; at: number }[] = [];
  /** Tick the round-end winner card began (its delay and animation count from here); null while no card is due. */
  private cardFrom: number | null = null;
  /** CSS px at the top taken by a screen's own controls (AppCtx.reserveTop); the top bars go below. */
  topInset = 0;
  /** The game view's rect in window CSS px (the canvas covers it). */
  private view: ViewRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Reserved DOM bars (see reserve) and their window rects. */
  private readonly reserved = new Set<HTMLElement>();
  private rects: DOMRect[] = [];
  private readonly observer = new ResizeObserver(() => this.measure());

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
  }

  /** Backing-store size in device pixels. */
  resize(widthPx: number, heightPx: number): void {
    const w = Math.max(1, Math.round(widthPx));
    const h = Math.max(1, Math.round(heightPx));
    // Assigning width or height resets the 2D backing store even to the same value: resizeAll runs on every mount and every
    // screen-in end, so only a real change may reallocate it.
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** The game view's rect in window CSS px (the canvas covers it). */
  setView(view: ViewRect): void {
    this.view = view;
    this.measure();
  }

  /** Keep the objective bar clear of `bar` (a HUD chip row or screen top strip) until the returned function is called. */
  reserve(bar: HTMLElement): () => void {
    this.reserved.add(bar);
    this.observer.observe(bar);
    this.measure();
    return () => {
      this.reserved.delete(bar);
      this.observer.unobserve(bar);
      this.measure();
    };
  }

  /** Window rects of the reserved bars, re-read on resize and when a bar changes size. */
  private measure(): void {
    this.rects = [...this.reserved].map((bar) => bar.getBoundingClientRect());
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Draw the labels and bars over the view. `chrome: false` leaves only names and damage bars
   * (menu clips): no intro, banners, kill lines, kill feed or objective bar.
   */
  draw(scene: Scene, cam: Camera, names: ReadonlyMap<number, string>, tickHz: number, chrome = true): void {
    this.clear();
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = this.canvas.width / dpr;
    const cssH = this.canvas.height / dpr;
    if (chrome) this.recordEvents(scene);
    this.drawDamageBars(scene, cam, cssW, cssH);
    this.drawTurrets(scene, cam, cssW, cssH);
    if (chrome) this.drawIntro(scene, tickHz, cssW, cssH);
    this.publishDraw(scene.tick, this.drawNames(scene, cam, names, cssW, cssH));
    if (chrome) this.drawHitFlashes(scene, cam, cssW, cssH);
    if (!chrome) return;
    this.publishAway(scene.tick, this.drawAway(scene, cam, names, cssW, cssH));
    this.drawWinnerCard(scene, names, tickHz, cssW, cssH);
    this.drawBanner(scene, names, cssW, cssH);
    this.drawPersonal(scene, names, cssW);
    this.drawFeed(names, cssW);
    this.drawObjectiveBar(scene, cssW);
  }

  /**
   * Each present consumes the frame feed's new events once (the feed holds only the ticks new since
   * the previous frame). Kills are confirmed, so the KO feed never shows a rolled-back kill; hit
   * flashes come from the predicted hits, so they show at once.
   */
  private recordEvents(scene: Scene): void {
    const now = performance.now();
    for (const k of scene.kills) this.feed.push({ killer: k.killer, victim: k.victim, at: now });
    for (const h of scene.hits) if (h.kind === HIT_KIND_PLAYER) this.hitFlashes.push({ id: h.index, at: now });
    while (this.feed.length > FEED_MAX) this.feed.shift();
    while (this.feed.length > 0 && now - (this.feed[0]?.at ?? 0) > FEED_MS) this.feed.shift();
  }

  /** A ring around each player hit by a bat recently (predicted hits; bodies and projectiles have no flash). */
  private drawHitFlashes(scene: Scene, cam: Camera, cssW: number, cssH: number): void {
    const now = performance.now();
    while (this.hitFlashes.length > 0 && now - (this.hitFlashes[0]?.at ?? 0) > HIT_FLASH_MS) this.hitFlashes.shift();
    if (this.hitFlashes.length === 0) return;
    const ctx = this.ctx;
    const [sx, sy, ox, oy] = worldXf(cam);
    const pxPerUnit = cssW / cam.w;
    ctx.lineWidth = 3;
    ctx.strokeStyle = TEXT;
    for (const f of this.hitFlashes) {
      const p = scene.players.find((q) => q.id === f.id);
      if (!p) continue;
      // Reduced motion: the same ring, held at full strength for the flash's lifetime, without growing or fading.
      const still = reducedMotion();
      const t = still ? 0 : (now - f.at) / HIT_FLASH_MS;
      const x = ((p.x * sx + ox) + 1) * cssW / 2;
      const y = (1 - (p.y * sy + oy)) * cssH / 2;
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(x, y, (p.size / 2) * pxPerUnit + 4 + 10 * t, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Width and ink height of `text` in `font`. Both are independent of the text baseline, so one entry serves
   * every frame; the cache is cleared when it fills (names change with the players in the match).
   */
  private textSize(font: string, text: string): { w: number; h: number } {
    const key = `${font}\u0000${text}`;
    let m = this.metricCache.get(key);
    if (m === undefined) {
      this.ctx.font = font;
      const t = this.ctx.measureText(text);
      m = { w: t.width, h: t.actualBoundingBoxAscent + t.actualBoundingBoxDescent };
      if (this.metricCache.size >= METRIC_CACHE_MAX) this.metricCache.clear();
      this.metricCache.set(key, m);
    }
    return m;
  }

  /** The sprite for `name` in `font` at `dpr`, made on first use: white name text centred on its anchor, no outline. */
  private labelSprite(font: string, name: string, dpr: number): LabelSprite {
    const key = `${font}\u0000${dpr}\u0000${name}`;
    let s = this.labelSprites.get(key);
    if (s !== undefined) return s;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    const setup = (): void => {
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    };
    // The ink box around the anchor, measured as drawn: engines place descenders and overhangs differently
    // relative to the baseline, so neither the advance nor the font box holds it.
    setup();
    const t = ctx.measureText(name);
    const ax = Math.ceil(t.actualBoundingBoxLeft) + LABEL_PAD;
    const ay = Math.ceil(t.actualBoundingBoxAscent) + LABEL_PAD;
    canvas.width = Math.ceil((ax + Math.ceil(t.actualBoundingBoxRight) + LABEL_PAD) * dpr);
    canvas.height = Math.ceil((ay + Math.max(0, Math.ceil(t.actualBoundingBoxDescent)) + LABEL_PAD) * dpr);
    // Resizing reset the context state.
    setup();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = NAME_TEXT;
    ctx.fillText(name, ax, ay);
    s = { canvas, w: canvas.width / dpr, h: canvas.height / dpr, ax, ay };
    if (this.labelSprites.size >= LABEL_SPRITE_MAX) this.labelSprites.clear();
    this.labelSprites.set(key, s);
    return s;
  }

  private drawNames(scene: Scene, cam: Camera, names: ReadonlyMap<number, string>, cssW: number, cssH: number): DrawRect[] {
    const ctx = this.ctx;
    const [sx, sy, ox, oy] = worldXf(cam);
    const pxPerUnit = cssW / cam.w;
    const followed = findLocal(scene);
    const dpr = window.devicePixelRatio || 1;
    // Device px, so the box, bar and marker edges sit on the pixel grid.
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    ctx.lineJoin = "round";
    const labels: NameLabel[] = [];
    for (const p of scene.players) {
      if (p.team === TEAM_SPECTATOR) continue;
      const name = names.get(p.id);
      if (name === undefined) continue;
      const x = ((p.x * sx + ox) + 1) * cssW / 2;
      // The box sits NAME_BOX_GAP above the body's top edge.
      const bodyTop = (1 - (p.y * sy + oy)) * cssH / 2 - (p.size / 2) * pxPerUnit;
      const local = (p.flags & FLAG_LOCAL) !== 0;
      const font = local ? LOCAL_NAME_FONT : NAME_FONT;
      labels.push({
        player: p,
        name,
        x,
        y: bodyTop - NAME_BOX_GAP,
        local,
        marked: followed?.id === p.id,
        font,
        w: this.textSize(font, name).w + 2 * NAME_BOX_PAD,
        unit: p.size * pxPerUnit,
      });
    }
    // The marker stands above the box (the bar is on its top row): a label's extent includes the marker.
    const hasBar = (l: NameLabel): boolean => l.local && scene.maxStamina > 0;
    const extent = (l: NameLabel): Box => {
      const above = l.marked ? MARKER_GAP + MARKER_HEIGHT * l.unit : 0;
      return { left: l.x - l.w / 2, right: l.x + l.w / 2, top: l.y - NAME_BOX_H - above, bottom: l.y };
    };
    // The local player's label keeps its place and is drawn last, on top. Others stack upward off it and off each other.
    const placed: Box[] = [];
    const drawn: DrawRect[] = [];
    for (const l of [...labels].sort((a, b) => Number(b.local) - Number(a.local))) {
      if (!l.local) {
        for (let step = 0; step < NAME_STACK_MAX; step++) {
          const e = extent(l);
          const hit = placed.some((b) => b.left < e.right && e.left < b.right && b.top < e.bottom && e.top < b.bottom);
          if (!hit) break;
          l.y -= NAME_BOX_H + NAME_GAP;
        }
      }
      // A label past the view's edge moves in (the view clips what it leaves out): on small cards the name stays whole.
      const e = extent(l);
      const dx = e.left < 0 ? -e.left : e.right > cssW ? cssW - e.right : 0;
      const dy = e.top < 0 ? -e.top : e.bottom > cssH ? cssH - e.bottom : 0;
      l.x += dx;
      l.y += dy;
      placed.push(extent(l));
      drawn.push({ kind: "label", id: l.player.id, z: 1, box: { left: l.x - l.w / 2, right: l.x + l.w / 2, top: l.y - NAME_BOX_H, bottom: l.y } });
    }
    for (const l of labels.sort((a, b) => Number(a.local) - Number(b.local))) {
      const left = snap(l.x - l.w / 2);
      const right = snap(l.x + l.w / 2);
      const top = snap(l.y - NAME_BOX_H);
      const bottom = snap(l.y);
      ctx.fillStyle = NAME_BOX_FILL;
      ctx.fillRect(left, top, right - left, bottom - top);
      // The text is centred on the box and blitted at device px so the copy is 1:1.
      const s = this.labelSprite(l.font, l.name, dpr);
      ctx.drawImage(s.canvas, snap(l.x - s.ax), snap((top + bottom) / 2 - s.ay), s.w, s.h);
      // The local player's status: the stamina bar, one CSS px tall, on the box's top row at the box width.
      if (hasBar(l)) this.drawStamina(l.player.stamina / scene.maxStamina, left, right - left, top);
      if (l.marked) {
        const tipY = top - MARKER_GAP;
        const h = MARKER_HEIGHT * l.unit;
        const hw = MARKER_HALF_WIDTH * l.unit;
        ctx.beginPath();
        ctx.moveTo(l.x, tipY);
        ctx.lineTo(l.x - hw, tipY - h);
        ctx.lineTo(l.x + hw, tipY - h);
        ctx.closePath();
        ctx.fillStyle = markerFill(l.player.flags);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = MARKER_OUTLINE;
        ctx.stroke();
        drawn.push({ kind: "marker", id: l.player.id, z: 1, box: { left: l.x - hw, right: l.x + hw, top: tipY - h, bottom: tipY } });
      }
    }
    return drawn;
  }

  /**
   * Edge indicators for the live opponents outside the view (`cam.away`): an arrow on the view's edge
   * in the direction of the opponent, with its name chip just inside it. Drawn with the chrome only.
   */
  private drawAway(scene: Scene, cam: Camera, names: ReadonlyMap<number, string>, cssW: number, cssH: number): AwayChip[] {
    if (cam.away.length === 0) return [];
    const ctx = this.ctx;
    const [sx, sy, ox, oy] = worldXf(cam);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = NAME_FONT;
    const chips: AwayChip[] = [];
    const rect = this.canvas.getBoundingClientRect();
    for (const id of cam.away) {
      const p = scene.players.find((q) => q.id === id);
      if (!p) continue;
      const dx = ((p.x * sx + ox) + 1) * cssW / 2 - cssW / 2;
      const dy = (1 - (p.y * sy + oy)) * cssH / 2 - cssH / 2;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      // Scale the ray from the view centre onto the edge rect inset by AWAY_EDGE.
      const hx = cssW / 2 - AWAY_EDGE;
      const hy = cssH / 2 - AWAY_EDGE;
      const t = Math.min(ux !== 0 ? hx / Math.abs(ux) : Infinity, uy !== 0 ? hy / Math.abs(uy) : Infinity);
      const ex = cssW / 2 + ux * t;
      const ey = cssH / 2 + uy * t;
      const rgb = playerRgb(p.team, p.id);
      const colour = this.colourCss(rgb);
      // Arrow: tip outward from the edge point, base just inside it.
      const px = -uy;
      const py = ux;
      ctx.beginPath();
      ctx.moveTo(ex + ux * AWAY_ARROW, ey + uy * AWAY_ARROW);
      ctx.lineTo(ex + px * AWAY_ARROW * 0.6, ey + py * AWAY_ARROW * 0.6);
      ctx.lineTo(ex - px * AWAY_ARROW * 0.6, ey - py * AWAY_ARROW * 0.6);
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
      const name = names.get(id);
      if (name === undefined) continue;
      const textW = ctx.measureText(name).width;
      const width = AWAY_CHIP_PAD + AWAY_SWATCH + AWAY_CHIP_GAP + textW + AWAY_CHIP_PAD;
      const height = AWAY_CHIP_H;
      const inward = AWAY_ARROW + AWAY_CHIP_GAP + height / 2;
      const chipX = Math.min(Math.max(ex - ux * inward, width / 2 + 2), cssW - width / 2 - 2);
      const chipY = Math.min(Math.max(ey - uy * inward, height / 2 + 2), cssH - height / 2 - 2);
      const left = chipX - width / 2;
      ctx.fillStyle = PANEL;
      ctx.fillRect(left, chipY - height / 2, width, height);
      // The colour is a swatch (a non-text mark); darker colours get a white ring so the swatch meets 3:1 on the panel. The name stays white.
      if (relLuminance(rgb) < AWAY_RING_BELOW_LUM) {
        ctx.fillStyle = TEXT;
        ctx.fillRect(left + AWAY_CHIP_PAD - 1, chipY - AWAY_SWATCH / 2 - 1, AWAY_SWATCH + 2, AWAY_SWATCH + 2);
      }
      ctx.fillStyle = colour;
      ctx.fillRect(left + AWAY_CHIP_PAD, chipY - AWAY_SWATCH / 2, AWAY_SWATCH, AWAY_SWATCH);
      ctx.fillStyle = TEXT;
      ctx.fillText(name, left + AWAY_CHIP_PAD + AWAY_SWATCH + AWAY_CHIP_GAP + textW / 2, chipY + 0.5);
      chips.push({ id, x: rect.left + left, y: rect.top + chipY - height / 2, w: width, h: height });
    }
    return chips;
  }

  /** QA hook (like __qaCam): this frame's edge chips in window CSS px, keyed by the scene tick. */
  private publishAway(tick: number, chips: AwayChip[]): void {
    Object.assign(globalThis, { __qaAway: { tick, chips } });
  }

  /** QA hook (like __qaCam): this frame's name labels and the followed player's marker, in window CSS px, with their z order. */
  private publishDraw(tick: number, rects: DrawRect[]): void {
    Object.assign(globalThis, { __qaDraw: { tick, rects } });
  }

  /**
   * Damage bars of the bodies that have a threshold (the original's `x$` bar): drawn upright on
   * the body centre, the fill scaled to the fraction still left before the next threshold.
   */
  private drawDamageBars(scene: Scene, cam: Camera, cssW: number, cssH: number): void {
    const ctx = this.ctx;
    const [sx, sy, ox, oy] = worldXf(cam);
    for (const b of scene.bars) {
      const x = ((b.x * sx + ox) + 1) * cssW / 2;
      const y = (1 - (b.y * sy + oy)) * cssH / 2;
      ctx.fillStyle = "#000000";
      ctx.fillRect(x - BAR_BORDER_W / 2, y - BAR_BORDER_H / 2, BAR_BORDER_W, BAR_BORDER_H);
      ctx.fillStyle = this.colourCss(b.colour);
      ctx.fillRect(x - BAR_FILL_W / 2, y - BAR_FILL_H / 2, BAR_FILL_W * b.fraction, BAR_FILL_H);
    }
  }

  /** Stamina bar of `fraction` (0..1) across `width` at `left`, STAMINA_H CSS px tall with its top edge at `top`. */
  private drawStamina(fraction: number, left: number, width: number, top: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = STAMINA_TRACK;
    ctx.fillRect(left, top, width, STAMINA_H);
    ctx.fillStyle = STAMINA_FILL;
    ctx.fillRect(left, top, width * Math.min(1, Math.max(0, fraction)), STAMINA_H);
  }

  private drawIntro(scene: Scene, tickHz: number, cssW: number, cssH: number): void {
    if (scene.intro < 0) return;
    const remaining = scene.intro / (tickHz > 0 ? tickHz : 1);
    const seconds = Math.ceil(remaining);
    if (seconds < 1) return;
    // The number has shown for `age` seconds: it settles from INTRO_FROM times its size and fades in.
    const age = seconds - remaining;
    const t = Math.min(1, age / INTRO_IN_S);
    const eased = 1 - (1 - t) ** 3;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = eased;
    ctx.translate(cssW / 2, cssH * 0.4);
    const scale = INTRO_FROM + (1 - INTRO_FROM) * eased;
    ctx.scale(scale, scale);
    const text = String(seconds);
    ctx.font = INTRO_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = TEXT;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  private drawBanner(scene: Scene, names: ReadonlyMap<number, string>, cssW: number, cssH: number): void {
    const banner = bannerText(scene, names);
    if (banner === null) return;
    const ctx = this.ctx;
    const sub = banner.sub;
    const width = Math.min(cssW - 16, 360);
    const height = sub !== null ? 72 : 48;
    const left = (cssW - width) / 2;
    const top = cssH * 0.25 - height / 2;
    ctx.fillStyle = PANEL;
    ctx.fillRect(left, top, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = TEXT;
    ctx.font = BANNER_TITLE_FONT;
    ctx.fillText(banner.title, cssW / 2, top + (sub !== null ? 24 : height / 2), width - 24);
    if (sub !== null) {
      ctx.font = BANNER_SUB_FONT;
      ctx.fillText(sub, cssW / 2, top + 52, width - 24);
    }
  }

  /**
   * The round-end winner card (the original's E7) for a non-team round a player won: a rotated box in the winner's colour
   * with a border 85% of that colour, "WINS" and the name, on a 35% black veil. It appears CARD_DELAY_S after the round
   * ends (no text banner meanwhile), fades in, and its contents slide down from two window heights. Reduced motion shows it still.
   */
  private drawWinnerCard(scene: Scene, names: ReadonlyMap<number, string>, tickHz: number, cssW: number, cssH: number): void {
    if (scene.roundOver < 0 || scene.gameOver >= 0 || scene.winner < 0 || isTeamMode(scene.mode)) {
      this.cardFrom = null;
      this.publishCard(null);
      return;
    }
    this.cardFrom ??= scene.tick;
    const hz = tickHz > 0 ? tickHz : 1;
    const age = reducedMotion() ? Infinity : (scene.tick - this.cardFrom) / hz - CARD_DELAY_S;
    if (age < 0) {
      this.publishCard(null);
      return;
    }
    const opacity = Math.min(1, age / CARD_FADE_S);
    const slide = Math.min(1, Math.max(0, age - CARD_SLIDE_DELAY_S) / CARD_SLIDE_S);
    // easeInExpo: the contents start two window heights up and reach their place at the end.
    const eased = slide === 0 ? 0 : 2 ** (10 * slide - 10);
    const offsetY = -2 * cssH * (1 - eased);
    const rgb = playerRgb(TEAM_FFA, scene.winner);
    const name = nameOf(names, scene.winner);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = CARD_VEIL;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.translate(0, offsetY);
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = CARD_TEXT;
    ctx.font = CARD_LOWER_FONT;
    ctx.fillText("WINS", cssW * 0.98, cssH);
    ctx.font = CARD_UPPER_FONT;
    ctx.fillText(name, cssW * 0.98, cssH - 105);
    const outer = CARD_BOX + 2 * CARD_BORDER;
    ctx.translate(cssW - 50 - outer / 2, cssH - 200 - outer / 2);
    ctx.rotate(CARD_ANGLE);
    ctx.fillStyle = cssHex(darken(rgb));
    ctx.fillRect(-outer / 2, -outer / 2, outer, outer);
    ctx.fillStyle = cssHex(rgb);
    ctx.fillRect(-CARD_BOX / 2, -CARD_BOX / 2, CARD_BOX, CARD_BOX);
    ctx.restore();
    this.publishCard({ tick: scene.tick, name, colour: cssHex(rgb), opacity, offsetY });
  }

  /** QA hook (like __qaDraw): the winner card this frame, or null when none is drawn. */
  private publishCard(card: { tick: number; name: string; colour: string; opacity: number; offsetY: number } | null): void {
    Object.assign(globalThis, { __qaCard: card });
  }

  /** The local player's latest kill, death or suicide: the largest active timer in its score row. */
  private drawPersonal(scene: Scene, names: ReadonlyMap<number, string>, cssW: number): void {
    const row = scene.scores.find((r) => r.id === scene.localId);
    if (row === undefined) return;
    let text: string | null = null;
    let best = 0;
    if (row.killTimer > best) {
      best = row.killTimer;
      text = row.lastVictim >= 0 ? `You killed ${nameOf(names, row.lastVictim)}` : "You scored a kill";
    }
    if (row.deathTimer > best) {
      best = row.deathTimer;
      text = row.killedBy >= 0 ? `${nameOf(names, row.killedBy)} killed you` : "You died";
    }
    if (row.suicideTimer > best) text = "Oops!";
    if (text === null) return;
    const ctx = this.ctx;
    ctx.font = PERSONAL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = Math.min(cssW - 16, ctx.measureText(text).width + 24);
    const left = (cssW - width) / 2;
    ctx.fillStyle = PANEL;
    const top = PERSONAL_TOP + this.topInset;
    ctx.fillRect(left, top, width, PERSONAL_H);
    ctx.fillStyle = TEXT;
    ctx.fillText(text, cssW / 2, top + PERSONAL_H / 2, width - 24);
  }

  /** Recent kills, newest first, right-aligned under the buttons. */
  private drawFeed(names: ReadonlyMap<number, string>, cssW: number): void {
    if (this.feed.length === 0) return;
    const ctx = this.ctx;
    ctx.font = FEED_FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const right = cssW - 8;
    let top = FEED_TOP;
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const k = this.feed[i];
      if (k === undefined) continue;
      const text = killText(k, names);
      const width = ctx.measureText(text).width + 16;
      ctx.fillStyle = PANEL;
      ctx.fillRect(right - width, top, width, FEED_ROW_H);
      ctx.fillStyle = TEXT;
      ctx.fillText(text, right - 8, top + FEED_ROW_H / 2);
      top += FEED_ROW_H + FEED_GAP;
    }
  }

  /**
   * Objective bar box in view CSS px. Its row sits at the view's top edge and takes the widest run of
   * that row left between the reserved DOM bars (HUD chips, a screen's top strip), centred in it. When no
   * run is wide enough it goes under those bars, centred in the view. Always kept inside the view.
   */
  private objectiveBox(cssW: number): { left: number; width: number; top: number } {
    const { x, y, w, h } = this.view;
    const rowTop = y + BAR_ROW_INSET;
    const rowBottom = rowTop + OBJECTIVE_H;
    let below = rowTop;
    const blocked: [number, number][] = [];
    for (const r of this.rects) {
      if (r.top >= rowBottom || r.bottom <= rowTop) continue;
      blocked.push([r.left - CHIP_GAP, r.right + CHIP_GAP]);
      below = Math.max(below, r.bottom + CHIP_GAP);
    }
    blocked.sort((a, b) => a[0] - b[0]);
    const viewRight = x + w;
    let runLeft = x;
    let runW = 0;
    let cursor = x;
    for (const [l, r] of [...blocked, [viewRight, viewRight]] as [number, number][]) {
      const end = Math.min(l, viewRight);
      if (end - cursor > runW) {
        runLeft = cursor;
        runW = end - cursor;
      }
      cursor = Math.max(cursor, r);
    }
    if (runW >= OBJECTIVE_MIN_W) {
      const width = Math.min(OBJECTIVE_MAX_W, runW);
      return { left: runLeft + (runW - width) / 2 - x, width, top: BAR_ROW_INSET };
    }
    const width = Math.min(OBJECTIVE_MAX_W, cssW - 16);
    const top = Math.min(below, y + h - OBJECTIVE_H - BAR_ROW_INSET) - y;
    return { left: (cssW - width) / 2, width, top };
  }

  private drawObjectiveBar(scene: Scene, cssW: number): void {
    const ctx = this.ctx;
    const { left, width, top } = this.objectiveBox(cssW);
    const height = OBJECTIVE_H;
    const mid = top + height / 2;
    ctx.fillStyle = CHIP;
    ctx.fillRect(left, top, width, height);
    const progress = objectiveProgress(scene);
    if (progress !== null) {
      ctx.fillStyle = PROGRESS;
      ctx.fillRect(left, top + height - RULE_H, width * progress, RULE_H);
    }
    ctx.font = BAR_FONT;
    ctx.textBaseline = "middle";

    ctx.textAlign = "left";
    ctx.fillStyle = TEXT;
    ctx.fillText(objectiveLabel(scene), left + 10, mid);

    if (scene.round > 0) {
      ctx.textAlign = "right";
      ctx.fillText(`round ${Math.round(scene.round)}`, left + width - 10, mid);
    }

    if (isTeamMode(scene.mode)) {
      const cx = cssW / 2;
      ctx.textAlign = "right";
      ctx.fillStyle = this.colourCss(playerRgb(TEAM_RED, 0));
      ctx.fillText(String(Math.round(scene.red)), cx - 12, mid);
      ctx.textAlign = "center";
      ctx.fillStyle = TEXT;
      ctx.fillText("-", cx, mid);
      ctx.textAlign = "left";
      ctx.fillStyle = this.colourCss(playerRgb(TEAM_BLUE, 0));
      ctx.fillText(String(Math.round(scene.blue)), cx + 12, mid);
    }
  }

  private colourCss(rgb: number): string {
    let css = this.cssCache.get(rgb);
    if (css === undefined) {
      css = cssHex(rgb);
      this.cssCache.set(rgb, css);
    }
    return css;
  }
}

function nameOf(names: ReadonlyMap<number, string>, id: number): string {
  return names.get(id) ?? `player ${id}`;
}

/** `rgb` with each channel at 85%: the winner card's border. */
function darken(rgb: number): number {
  const channel = (shift: number) => Math.round(((rgb >> shift) & 255) * 0.85);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function killText(k: KillEntry, names: ReadonlyMap<number, string>): string {
  const victim = nameOf(names, k.victim);
  if (k.killer < 0 || k.killer === k.victim) return `${victim} died`;
  return `${nameOf(names, k.killer)} killed ${victim}`;
}

interface Banner {
  title: string;
  /** Second line; null when there is none. */
  sub: string | null;
}

/** Round or match end banner; null while neither is running. Match end takes precedence. */
function bannerText(scene: Scene, names: ReadonlyMap<number, string>): Banner | null {
  const matchOver = scene.gameOver >= 0;
  if (!matchOver && scene.roundOver < 0) return null;
  // A round a player wins is the winner card's (drawWinnerCard); only team rounds and match ends read as text.
  if (!matchOver && scene.winner >= 0 && !isTeamMode(scene.mode)) return null;
  const sub = matchOver ? null : "New round incoming…";
  // The original's round-end texts: a team round with no team to score reads "New round incoming" (-1) or "Draw" (-2);
  // a non-team round with nobody left reads "New round incoming..." (-1) or "Draw!" (-2). Neither has a second line.
  if (isTeamMode(scene.mode)) {
    if (scene.objectiveTeam === TEAM_RED) return { title: matchOver ? "Red team wins the match" : "Red team scores", sub };
    if (scene.objectiveTeam === TEAM_BLUE) return { title: matchOver ? "Blue team wins the match" : "Blue team scores", sub };
    if (matchOver) return { title: "Draw!", sub: null };
    return { title: scene.objectiveTeam === -1 ? "New round incoming" : "Draw", sub: null };
  }
  if (scene.winner === -1) return { title: matchOver ? "Draw!" : "New round incoming...", sub: null };
  if (scene.winner < 0) return { title: matchOver ? "Match over" : "Draw!", sub: null };
  const name = nameOf(names, scene.winner);
  return { title: matchOver ? `${name} wins the match` : `${name} wins the round`, sub };
}

/** Left side of the objective bar: what the match is played for, in the mode's terms. */
function objectiveLabel(scene: Scene): string {
  const limit = Math.round(scene.objectiveLimit);
  const local = scene.scores.find((r) => r.id === scene.localId);
  switch (scene.mode) {
    case 0:
      return limit > 0 ? `${limit} kills to win` : "Kills";
    case 1:
      return local !== undefined ? `Lives remaining: ${Math.round(local.lives)}` : "Lives";
    case 2:
    case 3:
      return limit > 0 ? `${limit} rounds to win` : "Rounds";
    case 4:
      return limit > 0 ? `${limit} objectives to win` : "Endless teams";
    case 5:
      return local !== undefined ? `Spawns remaining: ${Math.round(local.lives)}` : "Lives teams";
    case 6:
      return "Just fight!";
    default:
      return "";
  }
}

/** Progress rule of the objective bar, 0..1 of the mode's limit for the local player; null when there is none. */
function objectiveProgress(scene: Scene): number | null {
  if (!(scene.objectiveLimit > 0)) return null;
  const local = scene.scores.find((r) => r.id === scene.localId);
  if (local === undefined) return null;
  let value: number;
  switch (scene.mode) {
    case 0:
      value = local.kills;
      break;
    case 1:
    case 5:
      value = local.lives;
      break;
    case 2:
    case 3:
      value = local.wins;
      break;
    default:
      return null;
  }
  return Math.min(1, Math.max(0, value / scene.objectiveLimit));
}
