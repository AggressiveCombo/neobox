// Canvas2D overlay above the renderer canvas: player names (with the FFA leader's crown
// and the local stamina bar), intro countdown, round/match banners, the local player's
// kill line, the kill feed and the objective bar. Drawn in CSS pixels; resize() takes
// device pixels.

import type { Camera } from "../camera";
import { worldXf } from "../camera";
import type { Scene } from "../frame";
import { FLAG_LOCAL } from "../frame";
import { TEAM_BLUE, TEAM_RED, TEAM_SPECTATOR, isTeamMode } from "../protocol";
import { cssHex, playerRgb } from "./geometry";

const NAME_FONT = "500 12px system-ui, sans-serif";
const LOCAL_NAME_FONT = "700 13px system-ui, sans-serif";
const INTRO_FONT = "700 72px system-ui, sans-serif";
const BANNER_TITLE_FONT = "700 22px system-ui, sans-serif";
const BANNER_SUB_FONT = "500 13px system-ui, sans-serif";
const BAR_FONT = "600 12px system-ui, sans-serif";
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

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(scene: Scene, cam: Camera, names: ReadonlyMap<number, string>, tickHz: number): void {
    this.clear();
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = this.canvas.width / dpr;
    const cssH = this.canvas.height / dpr;
    this.recordKills(scene);
    this.drawNames(scene, cam, names, cssW, cssH);
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
    const seconds = Math.ceil(scene.intro / (tickHz > 0 ? tickHz : 1));
    if (seconds < 1) return;
    const ctx = this.ctx;
    const text = String(seconds);
    ctx.font = INTRO_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(text, cssW / 2, cssH * 0.4);
    ctx.fillStyle = TEXT;
    ctx.fillText(text, cssW / 2, cssH * 0.4);
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

  private drawObjectiveBar(scene: Scene, cssW: number): void {
    const ctx = this.ctx;
    // keep clear of the Menu and Leave buttons at the top right (hud.css)
    const reserve = 208;
    const width = Math.min(480, Math.max(160, cssW - 2 * reserve));
    const left = cssW - 2 * reserve >= width ? (cssW - width) / 2 : Math.max(8, cssW - reserve - width);
    const top = 8 + this.topInset;
    const height = 26;
    const mid = top + height / 2;
    ctx.fillStyle = PANEL;
    ctx.fillRect(left, top, width, height);
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
