// WebGL2 backend: one interleaved VBO (position vec2, colour vec4 normalised u8), one
// uniform transform per draw, alpha blending. Draw order: background, world, players.

import type { Camera } from "../camera";
import { worldXf } from "../camera";
import type { Scene } from "../frame";
import type { Renderer } from "./index";
import { prefs } from "../prefs";
import { Geometry, IDENTITY_XF, VERTEX_BYTES, scaledSize, type Span, type Xf } from "./geometry";

const POS_LOCATION = 0;
const COLOUR_LOCATION = 1;
const INITIAL_BYTES = 4096;
const WORD_BYTES = 4;

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec4 a_colour;
uniform vec4 u_xf;
out vec4 v_colour;
void main() {
  gl_Position = vec4(a_pos.x * u_xf.x + u_xf.z, a_pos.y * u_xf.y + u_xf.w, 0.0, 1.0);
  v_colour = a_colour;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_colour;
out vec4 o_colour;
void main() {
  o_colour = v_colour;
}
`;

/** Create a WebGL2 renderer on `canvas`. Throws when WebGL2 or its shaders are unavailable. MSAA follows `antialias` when the browser offers it. */
export function createWebGl2Renderer(canvas: HTMLCanvasElement, onLost: () => void, antialias: boolean): Renderer {
  // Multisampled default framebuffer when the browser offers it (the driver picks the count, typically 4).
  const attrs = { alpha: false, depth: false, stencil: false };
  const gl =
    canvas.getContext("webgl2", { ...attrs, antialias }) ??
    (antialias ? canvas.getContext("webgl2", { ...attrs, antialias: false }) : null);
  if (!gl) throw new Error("WebGL2 not available");
  return new WebGl2Renderer(canvas, gl, onLost);
}

class WebGl2Renderer implements Renderer {
  readonly kind: "webgl2" = "webgl2";
  private readonly geo = new Geometry();
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly uXf: WebGLUniformLocation | null;
  private vboBytes = INITIAL_BYTES;
  private alive = true;
  /** Last requested device-pixel size (before the renderScale pref). */
  private size: [number, number] = [1, 1];
  private readonly unsubPrefs: () => void;

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.alive) this.onLost();
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly onLost: () => void,
  ) {
    this.program = linkProgram(gl);
    this.uXf = gl.getUniformLocation(this.program, "u_xf");
    this.vao = must(gl.createVertexArray(), "createVertexArray failed");
    this.vbo = must(gl.createBuffer(), "createBuffer failed");

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, INITIAL_BYTES, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(POS_LOCATION);
    gl.vertexAttribPointer(POS_LOCATION, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(COLOUR_LOCATION);
    gl.vertexAttribPointer(COLOUR_LOCATION, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 8);
    gl.bindVertexArray(null);

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.unsubPrefs = prefs.subscribe(() => this.applySize());
  }

  draw(scene: Scene, cam: Camera): void {
    const { gl, geo } = this;
    geo.build(scene);
    this.uploadVertices();
    const xf = worldXf(cam);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    this.drawSpan(geo.background, IDENTITY_XF);
    this.drawSpan(geo.world, xf);
    this.drawSpan(geo.players, xf);
  }

  resize(widthPx: number, heightPx: number): void {
    this.size = [widthPx, heightPx];
    this.applySize();
  }

  /** Apply the requested size scaled by renderScale; re-applied live when that pref changes. */
  private applySize(): void {
    const [w, h] = scaledSize(this.size[0], this.size[1]);
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  destroy(): void {
    this.alive = false;
    this.unsubPrefs();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    const { gl } = this;
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }

  private uploadVertices(): void {
    const { gl, geo } = this;
    const bytes = geo.wordCount * WORD_BYTES;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (bytes > this.vboBytes) {
      let size = this.vboBytes;
      while (size < bytes) size *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW);
      this.vboBytes = size;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, geo.words, 0, geo.wordCount);
  }

  private drawSpan(span: Span, xf: Xf): void {
    if (span.count === 0) return;
    this.gl.uniform4f(this.uXf, xf[0], xf[1], xf[2], xf[3]);
    this.gl.drawArrays(this.gl.TRIANGLES, span.first, span.count);
  }
}

function linkProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = must(gl.createProgram(), "createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, POS_LOCATION, "a_pos");
  gl.bindAttribLocation(program, COLOUR_LOCATION, "a_colour");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = must(gl.createShader(type), "createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return shader;
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(what);
  return value;
}
