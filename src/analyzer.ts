// WebGPU-based frame comparator.
//
// Two `rgba8unorm` textures (`prevTex`, `currTex`) hold consecutive frames.
// A compute shader converts each pixel from sRGB to linear RGB, computes the
// Euclidean distance, and atomically counts pixels whose distance exceeds the
// user-supplied threshold. It also writes a per-pixel diff visualisation
// (red = above threshold) into a storage texture, which is then blitted to
// the diff canvas via a tiny render pass.
//
// `prevTex` and `currTex` are swapped after each compare() to avoid copying
// the same VideoFrame twice.

import { t } from "./i18n";

export interface RectMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COMPUTE_SHADER = /* wgsl */ `
struct Params {
  threshold: f32,
  maskEnabled: u32,
  maskMin: vec2<u32>,
  maskMax: vec2<u32>,
};

@group(0) @binding(0) var prevTex: texture_2d<f32>;
@group(0) @binding(1) var currTex: texture_2d<f32>;
@group(0) @binding(2) var diffTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(4) var<uniform> params: Params;

fn s2l(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(prevTex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  if (
    params.maskEnabled != 0u &&
    id.x >= params.maskMin.x && id.x < params.maskMax.x &&
    id.y >= params.maskMin.y && id.y < params.maskMax.y
  ) {
    textureStore(
      diffTex,
      vec2<i32>(id.xy),
      vec4<f32>(0.05, 0.16, 0.24, 1.0)
    );
    return;
  }
  let p = textureLoad(prevTex, vec2<i32>(id.xy), 0).rgb;
  let c = textureLoad(currTex, vec2<i32>(id.xy), 0).rgb;
  let pl = vec3<f32>(s2l(p.r), s2l(p.g), s2l(p.b));
  let cl = vec3<f32>(s2l(c.r), s2l(c.g), s2l(c.b));
  let d = distance(pl, cl);
  var col: vec4<f32>;
  if (d > params.threshold) {
    atomicAdd(&counter, 1u);
    col = vec4<f32>(1.0, 0.0, 0.0, 1.0);
  } else {
    col = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  textureStore(diffTex, vec2<i32>(id.xy), col);
}
`;

const RENDER_SHADER = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>(1.0,  1.0)
  );
  let u = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0)
  );
  var o: VOut;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = u[i];
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  return textureSample(t, s, in.uv);
}
`;

export class Analyzer {
  private device!: GPUDevice;
  private cpipe!: GPUComputePipeline;
  private rpipe!: GPURenderPipeline;
  private prevTex!: GPUTexture;
  private currTex!: GPUTexture;
  private scratchPrevTex!: GPUTexture;
  private scratchCurrTex!: GPUTexture;
  private diffTex!: GPUTexture;
  private counterBuf!: GPUBuffer;
  private readBuf!: GPUBuffer;
  private uniBuf!: GPUBuffer;
  private sampler!: GPUSampler;
  private ctx!: GPUCanvasContext;
  private w = 0;
  private h = 0;
  private hasPrev = false;
  private workChain: Promise<void> = Promise.resolve();

  async init(width: number, height: number, diffCanvas: HTMLCanvasElement) {
    if (!navigator.gpu) {
      throw new Error(
        t(
          "このブラウザは WebGPU 非対応です",
          "This browser does not support WebGPU",
        ),
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        t("GPU アダプタを取得できません", "Could not obtain a GPU adapter"),
      );
    }
    this.device = await adapter.requestDevice();
    this.w = width;
    this.h = height;

    const U = GPUTextureUsage;
    const texUsage = U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT;
    this.prevTex = this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: texUsage,
    });
    this.currTex = this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: texUsage,
    });
    this.scratchPrevTex = this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: texUsage,
    });
    this.scratchCurrTex = this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: texUsage,
    });
    this.diffTex = this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage:
        U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT,
    });

    const B = GPUBufferUsage;
    this.counterBuf = this.device.createBuffer({
      size: 4,
      usage: B.STORAGE | B.COPY_SRC | B.COPY_DST,
    });
    this.readBuf = this.device.createBuffer({
      size: 4,
      usage: B.MAP_READ | B.COPY_DST,
    });
    this.uniBuf = this.device.createBuffer({
      size: 24,
      usage: B.UNIFORM | B.COPY_DST,
    });

    const cm = this.device.createShaderModule({ code: COMPUTE_SHADER });
    this.cpipe = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: cm, entryPoint: "main" },
    });

    diffCanvas.width = width;
    diffCanvas.height = height;
    this.ctx = diffCanvas.getContext("webgpu")!;
    const fmt = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({
      device: this.device,
      format: fmt,
      alphaMode: "opaque",
    });

    const rm = this.device.createShaderModule({ code: RENDER_SHADER });
    this.rpipe = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: rm, entryPoint: "vs" },
      fragment: { module: rm, entryPoint: "fs", targets: [{ format: fmt }] },
      primitive: { topology: "triangle-strip" },
    });

    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });
  }

  async compare(
    frame: VideoFrame,
    threshold: number,
    mask: RectMask | null = null,
  ): Promise<{ diffCount: number; isFirst: boolean }> {
    return this.enqueueWork(() => this.compareImpl(frame, threshold, mask));
  }

  async prime(frame: VideoFrame) {
    await this.enqueueWork(() => this.primeImpl(frame));
  }

  async renderDiffBetween(
    prevImage: ImageBitmap,
    currImage: ImageBitmap,
    threshold: number,
    mask: RectMask | null = null,
  ) {
    await this.enqueueWork(async () => {
      this.device.queue.copyExternalImageToTexture(
        { source: prevImage },
        { texture: this.scratchPrevTex },
        [this.w, this.h],
      );
      this.device.queue.copyExternalImageToTexture(
        { source: currImage },
        { texture: this.scratchCurrTex },
        [this.w, this.h],
      );
      await this.computeAndRenderDiff(
        this.scratchPrevTex,
        this.scratchCurrTex,
        threshold,
        mask,
        false,
      );
    });
  }

  async renderBlankDiff() {
    await this.enqueueWork(() => this.renderBlankDiffImpl());
  }

  async reset() {
    await this.enqueueWork(async () => {
      this.hasPrev = false;
      await this.renderBlankDiffImpl();
    });
  }

  private async compareImpl(
    frame: VideoFrame,
    threshold: number,
    mask: RectMask | null,
  ): Promise<{ diffCount: number; isFirst: boolean }> {
    // Always copy the new frame into currTex.
    this.device.queue.copyExternalImageToTexture(
      { source: frame as unknown as ImageBitmap },
      { texture: this.currTex },
      [this.w, this.h],
    );

    if (!this.hasPrev) {
      this.hasPrev = true;
      // Promote the new frame to "previous" for the next call.
      [this.prevTex, this.currTex] = [this.currTex, this.prevTex];
      await this.renderBlankDiffImpl();
      return { diffCount: 0, isFirst: true };
    }

    const count = await this.computeAndRenderDiff(
      this.prevTex,
      this.currTex,
      threshold,
      mask,
      true,
    );

    [this.prevTex, this.currTex] = [this.currTex, this.prevTex];

    return { diffCount: count, isFirst: false };
  }

  private async primeImpl(frame: VideoFrame) {
    this.device.queue.copyExternalImageToTexture(
      { source: frame as unknown as ImageBitmap },
      { texture: this.prevTex },
      [this.w, this.h],
    );
    this.hasPrev = true;
  }

  private async computeAndRenderDiff(
    prevTex: GPUTexture,
    currTex: GPUTexture,
    threshold: number,
    mask: RectMask | null,
    readCount: boolean,
  ) {
    const bounds = getMaskPixelBounds(mask, this.w, this.h);
    const params = new ArrayBuffer(24);
    const paramsView = new DataView(params);
    paramsView.setFloat32(0, threshold, true);
    paramsView.setUint32(4, bounds ? 1 : 0, true);
    paramsView.setUint32(8, bounds?.minX ?? 0, true);
    paramsView.setUint32(12, bounds?.minY ?? 0, true);
    paramsView.setUint32(16, bounds?.maxX ?? 0, true);
    paramsView.setUint32(20, bounds?.maxY ?? 0, true);
    this.device.queue.writeBuffer(
      this.uniBuf,
      0,
      params,
    );
    this.device.queue.writeBuffer(this.counterBuf, 0, new Uint32Array([0]));

    const cBg = this.device.createBindGroup({
      layout: this.cpipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: prevTex.createView() },
        { binding: 1, resource: currTex.createView() },
        { binding: 2, resource: this.diffTex.createView() },
        { binding: 3, resource: { buffer: this.counterBuf } },
        { binding: 4, resource: { buffer: this.uniBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(this.cpipe);
    cp.setBindGroup(0, cBg);
    cp.dispatchWorkgroups(Math.ceil(this.w / 8), Math.ceil(this.h / 8));
    cp.end();
    if (readCount) enc.copyBufferToBuffer(this.counterBuf, 0, this.readBuf, 0, 4);
    this.encodeDiffRender(enc);

    this.device.queue.submit([enc.finish()]);

    if (!readCount) {
      await this.device.queue.onSubmittedWorkDone();
      return 0;
    }

    await Promise.all([
      this.readBuf.mapAsync(GPUMapMode.READ),
      this.device.queue.onSubmittedWorkDone(),
    ]);
    const count = new Uint32Array(this.readBuf.getMappedRange().slice(0))[0];
    this.readBuf.unmap();
    return count;
  }

  private async renderBlankDiffImpl() {
    const enc = this.device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.diffTex.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    rp.end();
    this.encodeDiffRender(enc);
    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();
  }

  private encodeDiffRender(enc: GPUCommandEncoder) {
    const rBg = this.device.createBindGroup({
      layout: this.rpipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.diffTex.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });

    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    rp.setPipeline(this.rpipe);
    rp.setBindGroup(0, rBg);
    rp.draw(4);
    rp.end();
  }

  destroy() {
    this.prevTex?.destroy();
    this.currTex?.destroy();
    this.scratchPrevTex?.destroy();
    this.scratchCurrTex?.destroy();
    this.diffTex?.destroy();
    this.counterBuf?.destroy();
    this.readBuf?.destroy();
    this.uniBuf?.destroy();
    this.device?.destroy();
  }

  private enqueueWork<T>(action: () => Promise<T>) {
    const run = this.workChain.then(action);
    this.workChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function getAnalyzedPixelCount(
  mask: RectMask | null,
  width: number,
  height: number,
) {
  const totalPixels = width * height;
  const bounds = getMaskPixelBounds(mask, width, height);
  if (!bounds) return totalPixels;
  const maskedPixels =
    (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
  return Math.max(0, totalPixels - maskedPixels);
}

function getMaskPixelBounds(
  mask: RectMask | null,
  width: number,
  height: number,
) {
  if (!mask || width <= 0 || height <= 0) return null;
  const x1 = clamp(mask.x, 0, 1);
  const y1 = clamp(mask.y, 0, 1);
  const x2 = clamp(mask.x + mask.width, 0, 1);
  const y2 = clamp(mask.y + mask.height, 0, 1);
  const minX = Math.floor(Math.min(x1, x2) * width);
  const minY = Math.floor(Math.min(y1, y2) * height);
  const maxX = Math.ceil(Math.max(x1, x2) * width);
  const maxY = Math.ceil(Math.max(y1, y2) * height);
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
