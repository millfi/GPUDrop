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

const COMPUTE_SHADER = /* wgsl */ `
struct Params { threshold: f32 };

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
    if (!navigator.gpu) throw new Error("このブラウザは WebGPU 非対応です");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("GPU アダプタを取得できません");
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
      size: 16,
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
  ): Promise<{ diffCount: number; isFirst: boolean }> {
    return this.enqueueWork(() => this.compareImpl(frame, threshold));
  }

  async renderDiffImage(image: ImageBitmap) {
    await this.enqueueWork(() => this.renderDiffImageImpl(image));
  }

  async renderDiffBetween(
    prevImage: ImageBitmap,
    currImage: ImageBitmap,
    threshold: number,
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
        false,
      );
    });
  }

  async renderBlankDiff() {
    await this.enqueueWork(() => this.renderBlankDiffImpl());
  }

  private async compareImpl(
    frame: VideoFrame,
    threshold: number,
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
      true,
    );

    [this.prevTex, this.currTex] = [this.currTex, this.prevTex];

    return { diffCount: count, isFirst: false };
  }

  private async computeAndRenderDiff(
    prevTex: GPUTexture,
    currTex: GPUTexture,
    threshold: number,
    readCount: boolean,
  ) {
    this.device.queue.writeBuffer(
      this.uniBuf,
      0,
      new Float32Array([threshold, 0, 0, 0]),
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

  private async renderDiffImageImpl(image: ImageBitmap) {
    this.device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this.diffTex },
      [this.w, this.h],
    );

    const enc = this.device.createCommandEncoder();
    this.encodeDiffRender(enc);
    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();
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
