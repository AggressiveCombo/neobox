// Canvas2D overlay above the renderer canvas: player names, intro countdown, round/game
// banners and the objective bar. Drawn in CSS pixels; resize() takes device pixels.

import type { Camera } from "../camera";
import { worldXf } from "../camera";
import type { Scene } from "../frame";
import { FLAG_LOCAL } from "../frame";
import { GAME_MODES, TEAM_BLUE, TEAM_RED, TEAM_SPECTATOR, isTeamMode } from "../protocol";
import { cssHex, playerRgb } from "./geometry";

const NAME_FONT = "500 12px system-ui, sans-serif";
const LOCAL_NAME_FONT = "700 13px system-ui, sans-serif";
const INTRO_FONT = "700 72px system-ui, sans-serif";
const BANNER_TITLE_FONT = "700 22px system-ui, sans-serif";
const BANNER_SUB_FONT = "500 13px system-ui, sans-serif";
const BAR_FONT = "600 12px system-ui, sans-serif";
const OUTLINE = "rgba(0, 0, 0, 0.7)";
const PANEL = "rgba(0, 0, 0, 0.5)";
const TEXT = "#ffffff";

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cssCache = new Map<number, string>();

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
    this.drawNames(scene, cam, names, cssW, cssH);
    this.drawIntro(scene, tickHz, cssW, cssH);
    this.drawBanner(scene, names, cssW, cssH);
    this.drawObjectiveBar(scene, cssW);
  }

  private drawNames(scene: Scene, cam: Camera, names: ReadonlyMap<number, string>, cssW: number, cssH: number): void {
    const ctx = this.ctx;
    const [sx, sy, ox, oy] = worldXf(cam);
    const pxPerUnit = cssW / cam.w;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    for (const p of scene.players) {
      if (p.team === TEAM_SPECTATOR) continue;
      const name = names.get(p.id);
      if (name === undefined) continue;
      const x = ((p.x * sx + ox) + 1) * cssW / 2;
      const y = (1 - (p.y * sy + oy)) * cssH / 2 - (p.size / 2) * pxPerUnit - 4;
      const local = (p.flags & FLAG_LOCAL) !== 0;
      ctx.font = local ? LOCAL_NAME_FONT : NAME_FONT;
      ctx.lineWidth = 3;
      ctx.strokeStyle = OUTLINE;
      ctx.strokeText(name, x, y);
      ctx.fillStyle = this.colourCss(playerRgb(p.team, p.id));
      ctx.fillText(name, x, y);
    }
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
    let title: string;
    if (scene.gameOver >= 0) title = "game over";
    else if (scene.roundOver >= 0) title = "round over";
    else return;
    const ctx = this.ctx;
    const sub = winnerText(scene.winner, names);
    const width = Math.min(cssW - 16, 360);
    const height = sub ? 72 : 48;
    const left = (cssW - width) / 2;
    const top = cssH * 0.25 - height / 2;
    ctx.fillStyle = PANEL;
    ctx.fillRect(left, top, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = TEXT;
    ctx.font = BANNER_TITLE_FONT;
    ctx.fillText(title, cssW / 2, top + (sub ? 24 : height / 2));
    if (sub) {
      ctx.font = BANNER_SUB_FONT;
      ctx.fillText(sub, cssW / 2, top + 52);
    }
  }

  private drawObjectiveBar(scene: Scene, cssW: number): void {
    const ctx = this.ctx;
    // keep clear of the Leave button at the top right (hud.css .hud-leave)
    const reserve = 112;
    const width = Math.min(480, Math.max(160, cssW - 2 * reserve));
    const left = cssW - 2 * reserve >= width ? (cssW - width) / 2 : Math.max(8, cssW - reserve - width);
    const top = 8;
    const height = 26;
    const mid = top + height / 2;
    ctx.fillStyle = PANEL;
    ctx.fillRect(left, top, width, height);
    ctx.font = BAR_FONT;
    ctx.textBaseline = "middle";

    const modeName = GAME_MODES.find((m) => m.id === scene.mode)?.name ?? "";
    const limit = Math.round(scene.objectiveLimit);
    ctx.textAlign = "left";
    ctx.fillStyle = TEXT;
    ctx.fillText(limit > 0 ? `${modeName} · limit ${limit}` : modeName, left + 10, mid);

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

/** Banner subtitle: winner name, "draw" for -1, nothing for -2. */
function winnerText(winner: number, names: ReadonlyMap<number, string>): string {
  if (winner === -1) return "draw";
  if (winner < 0) return "";
  return `${names.get(winner) ?? `player ${winner}`} wins`;
}
