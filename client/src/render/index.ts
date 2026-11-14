// Renderer facade: WebGPU when available, otherwise WebGL2. Each backend owns its canvas
// (a canvas cannot change context type, so a failed WebGPU attempt discards its canvas).

import type { Camera } from "../camera";
import type { Scene } from "../frame";
import { prefs } from "../prefs";
import { h } from "../ui/dom";
import { createWebGl2Renderer } from "./webgl2";
import { createWebGpuRenderer } from "./webgpu";

export interface Renderer {
  readonly kind: "webgpu" | "webgl2";
  /** Build geometry from scene.view and draw background, world, then players. */
  draw(scene: Scene, cam: Camera): void;
  /** Backing-store size in device pixels. */
  resize(widthPx: number, heightPx: number): void;
  /** Release GPU objects and remove the canvas. */
  destroy(): void;
}

/** Create the best available renderer inside `host`. `onLost` fires once when the GPU context is lost. */
export async function createRenderer(host: HTMLElement, onLost: () => void): Promise<Renderer> {
  const gpuCanvas = appendCanvas(host);
  try {
    return await createWebGpuRenderer(gpuCanvas, onLost, prefs.value.antialias);
  } catch (err) {
    console.warn("neobox: WebGPU unavailable, using WebGL2", err);
    gpuCanvas.remove();
  }
  const glCanvas = appendCanvas(host);
  try {
    return createWebGl2Renderer(glCanvas, onLost, prefs.value.antialias);
  } catch (err) {
    glCanvas.remove();
    throw err;
  }
}

function appendCanvas(host: HTMLElement): HTMLCanvasElement {
  const canvas = h("canvas", { class: "game-canvas" });
  host.append(canvas);
  return canvas;
}
