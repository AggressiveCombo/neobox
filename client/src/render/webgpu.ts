// WebGPU backend: growable vertex buffer, one uniform slot per draw selected by dynamic
// offset (256-byte stride), alpha blending, MSAA 4 with fallback to 1.
// The DOM lib in use has no WebGPU typings, so the subset used here is declared locally.

import type { Camera } from "../camera";
import { worldXf } from "../camera";
import type { Scene } from "../frame";
import type { Renderer } from "./index";
import { Geometry, IDENTITY_XF, VERTEX_BYTES, type Span } from "./geometry";

const SLOT_BYTES = 256;
const SLOT_FLOATS = SLOT_BYTES / 4;
/** Slots: background, world, players. */
const SLOTS = 3;
const UNIFORM_BYTES = SLOTS * SLOT_BYTES;
const UNIFORM_VEC4_BYTES = 16;
const INITIAL_VERTEX_BYTES = 4096;
const WORD_BYTES = 4;
const MSAA_SAMPLES = 4;

const BUFFER_VERTEX = 0x0020;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_COPY_DST = 0x0008;
const TEXTURE_RENDER_ATTACHMENT = 0x0010;
const SHADER_STAGE_VERTEX = 0x0001;

const CLEAR = { r: 0, g: 0, b: 0, a: 1 };

const BLEND: GpuBlendState = {
  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

const SHADER = `
@group(0) @binding(0) var<uniform> xf: vec4<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) colour: vec4<f32>,
};

@vertex
fn vs(@location(0) pos: vec2<f32>, @location(1) colour: vec4<f32>) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(pos.x * xf.x + xf.z, pos.y * xf.y + xf.w, 0.0, 1.0);
  out.colour = colour;
  return out;
}

@fragment
fn fs(input: VertexOut) -> @location(0) vec4<f32> {
  return input.colour;
}
`;

interface GpuApi {
  requestAdapter(): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat(): string;
}

interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}

interface GpuDevice {
  readonly queue: GpuQueue;
  readonly lost: Promise<{ reason: string }>;
  createBuffer(desc: { size: number; usage: number }): GpuBuffer;
  createTexture(desc: {
    size: { width: number; height: number };
    format: string;
    sampleCount: number;
    usage: number;
  }): GpuTexture;
  createShaderModule(desc: { code: string }): object;
  createBindGroupLayout(desc: { entries: GpuBindGroupLayoutEntry[] }): object;
  createPipelineLayout(desc: { bindGroupLayouts: object[] }): object;
  createBindGroup(desc: {
    layout: object;
    entries: { binding: number; resource: { buffer: GpuBuffer; offset: number; size: number } }[];
  }): object;
  createRenderPipeline(desc: GpuRenderPipelineDescriptor): object;
  createCommandEncoder(): GpuCommandEncoder;
  pushErrorScope(filter: "validation"): void;
  popErrorScope(): Promise<object | null>;
  destroy(): void;
}

interface GpuQueue {
  writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView, dataOffset?: number, size?: number): void;
  submit(commands: object[]): void;
}

interface GpuBuffer {
  destroy(): void;
}

interface GpuTexture {
  createView(): object;
  destroy(): void;
}

interface GpuCanvasContext {
  configure(config: { device: GpuDevice; format: string; alphaMode: string }): void;
  unconfigure(): void;
  getCurrentTexture(): GpuTexture;
}

interface GpuCommandEncoder {
  beginRenderPass(desc: { colorAttachments: GpuColourAttachment[] }): GpuRenderPass;
  finish(): object;
}

interface GpuColourAttachment {
  view: object;
  resolveTarget?: object;
  clearValue: { r: number; g: number; b: number; a: number };
  loadOp: "clear";
  storeOp: "store" | "discard";
}

interface GpuRenderPass {
  setPipeline(pipeline: object): void;
  setVertexBuffer(slot: number, buffer: GpuBuffer): void;
  setBindGroup(index: number, group: object, dynamicOffsets: readonly number[]): void;
  draw(vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number): void;
  end(): void;
}

interface GpuBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer: { type: string; hasDynamicOffset: boolean; minBindingSize: number };
}

interface GpuBlendComponent {
  srcFactor: string;
  dstFactor: string;
  operation: string;
}

interface GpuBlendState {
  color: GpuBlendComponent;
  alpha: GpuBlendComponent;
}

interface GpuRenderPipelineDescriptor {
  layout: object;
  vertex: {
    module: object;
    entryPoint: string;
    buffers: {
      arrayStride: number;
      attributes: { shaderLocation: number; offset: number; format: string }[];
    }[];
  };
  fragment: {
    module: object;
    entryPoint: string;
    targets: { format: string; blend: GpuBlendState }[];
  };
  primitive: { topology: string };
  multisample: { count: number };
}

/** Create a WebGPU renderer on `canvas`. Throws (and releases the device) on any failure. MSAA follows `antialias` when the device allows it. */
export async function createWebGpuRenderer(canvas: HTMLCanvasElement, onLost: () => void, antialias: boolean): Promise<Renderer> {
  const api = gpuApi();
  if (!api) throw new Error("WebGPU not available");
  const adapter = await api.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  try {
    const context = canvas.getContext("webgpu");
    if (!isCanvasContext(context)) throw new Error("no WebGPU canvas context");
    const format = api.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const sampleCount = antialias ? await pickSampleCount(device, format) : 1;

    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE_VERTEX,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_VEC4_BYTES },
        },
      ],
    });
    const ubo = device.createBuffer({ size: UNIFORM_BYTES, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
    const bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: ubo, offset: 0, size: UNIFORM_VEC4_BYTES } }],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: VERTEX_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "unorm8x4" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format, blend: BLEND }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: sampleCount },
    });
    return new WebGpuRenderer(canvas, device, context, format, sampleCount, pipeline, bindGroup, ubo, onLost);
  } catch (err) {
    device.destroy();
    throw err;
  }
}

/** MSAA 4 when the device accepts it, otherwise single-sampled. */
async function pickSampleCount(device: GpuDevice, format: string): Promise<number> {
  device.pushErrorScope("validation");
  const probe = device.createTexture({
    size: { width: 1, height: 1 },
    format,
    sampleCount: MSAA_SAMPLES,
    usage: TEXTURE_RENDER_ATTACHMENT,
  });
  const error = await device.popErrorScope();
  probe.destroy();
  return error === null ? MSAA_SAMPLES : 1;
}

class WebGpuRenderer implements Renderer {
  readonly kind: "webgpu" = "webgpu";
  private readonly geo = new Geometry();
  private readonly xfData = new Float32Array(UNIFORM_BYTES / 4);
  private readonly slotOffsets: number[][] = [0, 1, 2].map((slot) => [slot * SLOT_BYTES]);
  private vbo: GpuBuffer;
  private vboBytes = INITIAL_VERTEX_BYTES;
  private msaa: GpuTexture | null = null;
  private alive = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GpuDevice,
    private readonly ctx: GpuCanvasContext,
    private readonly format: string,
    private readonly sampleCount: number,
    private readonly pipeline: object,
    private readonly bindGroup: object,
    private readonly ubo: GpuBuffer,
    private readonly onLost: () => void,
  ) {
    this.vbo = device.createBuffer({ size: INITIAL_VERTEX_BYTES, usage: BUFFER_VERTEX | BUFFER_COPY_DST });
    this.allocMsaa();
    device.lost.then((info) => {
      if (this.alive && info.reason !== "destroyed") this.onLost();
    });
  }

  draw(scene: Scene, cam: Camera): void {
    const { device, geo } = this;
    geo.build(scene);
    this.uploadVertices();

    const xf = worldXf(cam);
    this.xfData.set(IDENTITY_XF, 0);
    this.xfData.set(xf, SLOT_FLOATS);
    this.xfData.set(xf, 2 * SLOT_FLOATS);
    device.queue.writeBuffer(this.ubo, 0, this.xfData);

    const frame = this.ctx.getCurrentTexture().createView();
    const attachment: GpuColourAttachment = this.msaa
      ? { view: this.msaa.createView(), resolveTarget: frame, clearValue: CLEAR, loadOp: "clear", storeOp: "discard" }
      : { view: frame, clearValue: CLEAR, loadOp: "clear", storeOp: "store" };

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [attachment] });
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.vbo);
    this.drawSpan(pass, geo.background, 0);
    this.drawSpan(pass, geo.world, 1);
    this.drawSpan(pass, geo.players, 2);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  resize(widthPx: number, heightPx: number): void {
    const w = Math.max(1, Math.round(widthPx));
    const h = Math.max(1, Math.round(heightPx));
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.allocMsaa();
  }

  destroy(): void {
    this.alive = false;
    this.ctx.unconfigure();
    this.msaa?.destroy();
    this.vbo.destroy();
    this.ubo.destroy();
    this.device.destroy();
    this.canvas.remove();
  }

  private allocMsaa(): void {
    this.msaa?.destroy();
    this.msaa =
      this.sampleCount > 1
        ? this.device.createTexture({
            size: { width: this.canvas.width, height: this.canvas.height },
            format: this.format,
            sampleCount: this.sampleCount,
            usage: TEXTURE_RENDER_ATTACHMENT,
          })
        : null;
  }

  private uploadVertices(): void {
    const bytes = this.geo.wordCount * WORD_BYTES;
    if (bytes > this.vboBytes) {
      let size = this.vboBytes;
      while (size < bytes) size *= 2;
      this.vbo.destroy();
      this.vbo = this.device.createBuffer({ size, usage: BUFFER_VERTEX | BUFFER_COPY_DST });
      this.vboBytes = size;
    }
    this.device.queue.writeBuffer(this.vbo, 0, this.geo.words, 0, this.geo.wordCount);
  }

  private drawSpan(pass: GpuRenderPass, span: Span, slot: number): void {
    if (span.count === 0) return;
    pass.setBindGroup(0, this.bindGroup, this.slotOffsets[slot]);
    pass.draw(span.count, 1, span.first, 0);
  }
}

function gpuApi(): GpuApi | null {
  if (!("gpu" in navigator)) return null;
  const gpu: unknown = navigator.gpu;
  return isGpuApi(gpu) ? gpu : null;
}

function isGpuApi(value: unknown): value is GpuApi {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestAdapter" in value &&
    typeof value.requestAdapter === "function" &&
    "getPreferredCanvasFormat" in value &&
    typeof value.getPreferredCanvasFormat === "function"
  );
}

function isCanvasContext(value: unknown): value is GpuCanvasContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "configure" in value &&
    typeof value.configure === "function" &&
    "getCurrentTexture" in value &&
    typeof value.getCurrentTexture === "function"
  );
}
