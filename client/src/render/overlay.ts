// Canvas2D overlay above the renderer canvas: player names (with the FFA leader's crown
// and the local stamina bar), intro countdown, round/match banners, the local player's
// kill line, the kill feed and the objective bar. Drawn in CSS pixels; resize() takes
// device pixels.

import type { Camera, ViewRect } from "../camera";
import { worldXf } from "../camera";
import type { Scene } from "../frame";
import { FLAG_LOCAL } from "../frame";
import { TEAM_BLUE, TEAM_RED, TEAM_SPECTATOR, isTeamMode } from "../protocol";
import { cssHex, playerRgb } from "./geometry";

const NAME_FONT = "500 12px system-ui, sans-serif";
const LOCAL_NAME_FONT = "700 13px system-ui, sans-serif";
const INTRO_FONT = "700 72px system-ui, sans-serif";
/** Countdown numbers: start this many times their size and settle over INTRO_IN_S seconds. */
const INTRO_FROM = 1.35;
const INTRO_IN_S = 0.25;
const BANNER_TITLE_FONT = "700 22px system-ui, sans-serif";
const BANNER_SUB_FONT = "500 13px system-ui, sans-serif";
const BAR_FONT = "500 13px system-ui, sans-serif";
const PERSONAL_FONT = "700 15px system-ui, sans-serif";
const FEED_FONT = "600 12px system-ui, sans-serif";
const OUTLINE = "rgba(0, 0, 0, 0.7)";
const PANEL = "rgba(0, 0, 0, 0.5)";
const TEXT = "#ffffff";
const CROWN_FILL = "#ffd24a";
const STAMINA_FILL = "#8fe3ff";
/** Stamina bar under the local player: half width and height, CSS px. */
const STAMINA_HALF_W = 20;
const STAMINA_H = 3;
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

interface KillEntry {
  killer: number;
  victim: number;
  /** performance.now() when the kill was drawn first. */
  at: number;
}

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cssCache = new Map<number, string>();
  private readonly feed: KillEntry[] = [];
  private feedTick = -1;
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
    this.canvas.width = Math.max(1, Math.round(widthPx));
    this.canvas.height = Math.max(1, Math.round(heightPx));
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
    this.recordKills(scene);
    this.drawDamageBars(scene, cam, cssW, cssH);
    this.drawNames(scene, cam, names, cssW, cssH);
    if (!chrome) return;
    this.drawIntro(scene, tickHz, cssW, cssH);
    this.drawBanner(scene, names, cssW, cssH);
    this.drawPersonal(scene, names, cssW);
    this.drawFeed(names, cssW);
    this.drawObjectiveBar(scene, cssW);
  }

  /** Scene kills belong to one tick: keep each tick's once, for FEED_MS, the newest FEED_MAX. */
  private recordKills(scene: Scene): void {
    const now = performance.now();
    if (scene.tick !== this.feedTick) {
      this.feedTick = scene.tick;
      for (const k of scene.kills) this.feed.push({ killer: k.killer, victim: k.victim, at: now });
    }
    while (this.feed.length > FEED_MAX) this.feed.shift();
    while (this.feed.length > 0 && now - (this.feed[0]?.at ?? 0) > FEED_MS) this.feed.shift();
  }

  private drawNames(scene: Scene, cam: Camera, names: ReadonlyMap<number, string>, cssW: number, cssH: number): void {
    const ctx = this.ctx;
    const [sx, sy, ox, oy] = worldXf(cam);
    const pxPerUnit = cssW / cam.w;
    const leader = leaderId(scene);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    for (const p of scene.players) {
      if (p.team === TEAM_SPECTATOR) continue;
      const name = names.get(p.id);
      if (name === undefined) continue;
      const x = ((p.x * sx + ox) + 1) * cssW / 2;
      const centreY = (1 - (p.y * sy + oy)) * cssH / 2;
      const bodyHalf = (p.size / 2) * pxPerUnit;
      const y = centreY - bodyHalf - 4;
      const local = (p.flags & FLAG_LOCAL) !== 0;
      ctx.font = local ? LOCAL_NAME_FONT : NAME_FONT;
      ctx.lineWidth = 3;
      ctx.strokeStyle = OUTLINE;
      ctx.strokeText(name, x, y);
      ctx.fillStyle = this.colourCss(playerRgb(p.team, p.id));
      ctx.fillText(name, x, y);
      // The local player reads its own status from the stamina bar and kill line instead.
      if (p.id === leader && !local) this.drawCrown(x, y - 18);
      if (local && scene.maxStamina > 0) {
        this.drawStamina(p.stamina / scene.maxStamina, x, centreY + bodyHalf + 4);
      }
    }
  }

  /** Small crown centred on (x, y), for the FFA leader. */
  private drawCrown(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 4);
    ctx.lineTo(x - 7, y - 4);
    ctx.lineTo(x - 3, y);
    ctx.lineTo(x, y - 5);
    ctx.lineTo(x + 3, y);
    ctx.lineTo(x + 7, y - 4);
    ctx.lineTo(x + 6, y + 4);
    ctx.closePath();
    ctx.fillStyle = CROWN_FILL;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
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

  /** Thin stamina bar of `fraction` (0..1) centred on x, top edge at `top`. */
  private drawStamina(fraction: number, x: number, top: number): void {
    const ctx = this.ctx;
    const left = x - STAMINA_HALF_W;
    const width = STAMINA_HALF_W * 2;
    ctx.fillStyle = PANEL;
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
  const sub = matchOver ? null : "New round incoming…";
  if (isTeamMode(scene.mode)) {
    if (scene.objectiveTeam === TEAM_RED) return { title: matchOver ? "Red team wins the match" : "Red team scores", sub };
    if (scene.objectiveTeam === TEAM_BLUE) return { title: matchOver ? "Blue team wins the match" : "Blue team scores", sub };
    return { title: "Draw!", sub };
  }
  if (scene.winner === -1) return { title: "Draw!", sub };
  if (scene.winner < 0) return { title: matchOver ? "Match over" : "Round over", sub };
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

/**
 * FFA leader: the unique top scorer above zero (lives, wins or kills by mode); null on a tie,
 * at zero, or in team modes. Spectators are never leaders.
 */
function leaderId(scene: Scene): number | null {
  if (isTeamMode(scene.mode)) return null;
  let id: number | null = null;
  let top = 0;
  let ties = 0;
  for (const r of scene.scores) {
    if (r.team === TEAM_SPECTATOR) continue;
    const v = scene.mode === 1 ? r.lives : scene.mode === 2 ? r.wins : r.kills;
    if (v > top) {
      top = v;
      id = r.id;
      ties = 1;
    } else if (v === top && v > 0) {
      ties++;
    }
  }
  return ties === 1 ? id : null;
}
