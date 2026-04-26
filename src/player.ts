// Pipeline:
//   File -> mp4box demux -> EncodedVideoChunk -> VideoDecoder -> VideoFrame
//   -> sequential processFrame: schedule, draw to canvas, compare via Analyzer
//
// VideoFrames are processed strictly in arrival order via a Promise chain so
// the previous-vs-current comparison stays consistent. Playback is paced
// against wall-clock using each frame's timestamp.

import MP4Box, {
  type MP4ArrayBuffer,
  type MP4File,
  type MP4Sample,
} from "mp4box";
import { Analyzer } from "./analyzer";

export interface Stats {
  fps: number;
  frameTime: number; // seconds
  timestamp: number; // seconds since start
  frameNumber: number;
}

export interface DupEvent {
  timestamp: number;
  frameNumber: number;
}

interface Options {
  file: File;
  videoCanvas: HTMLCanvasElement;
  diffCanvas: HTMLCanvasElement;
  threshold: number; // per-pixel linearRGB distance threshold
  frameThreshold: number; // ratio of differing pixels to total pixels above which the frame is considered "different"
  onStats: (s: Stats) => void;
  onDuplicate: (e: DupEvent) => void;
  onEnd?: () => void;
}

export class Player {
  private opts: Options;
  private analyzer: Analyzer | null = null;
  private decoder: VideoDecoder | null = null;
  private mp4: MP4File | null = null;
  private threshold: number;
  private frameThreshold: number;
  private totalPixels = 0;
  private stopped = false;
  private trackId = 0;

  // playback state
  private vctx: CanvasRenderingContext2D | null = null;
  private startWall = 0;
  private firstTs = 0;
  private frameNumber = 0;

  // FPS estimation state
  private prevUniqueT = 0;
  private lastFt = 0;
  private uniqueTs: number[] = []; // timestamps (s) of unique frames in last window

  // Sequential processing chain
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: Options) {
    this.opts = opts;
    this.threshold = opts.threshold;
    this.frameThreshold = opts.frameThreshold;
  }

  setThreshold(t: number) {
    this.threshold = t;
  }

  setFrameThreshold(t: number) {
    this.frameThreshold = t;
  }

  async start() {
    this.mp4 = MP4Box.createFile();

    this.mp4.onError = (e) => console.error("[mp4box]", e);

    this.mp4.onReady = (info) => {
      void this.handleReady(info);
    };

    this.mp4.onSamples = (id, _user, samples) => {
      if (id !== this.trackId || !this.decoder) return;
      void this.feedDecoder(samples);
    };

    await this.streamFile();
  }

  private async handleReady(info: {
    videoTracks: ReturnType<MP4File["getTrackById"]> extends infer _
      ? any
      : never;
  }) {
    try {
      const track = (info as any).videoTracks[0];
      if (!track) throw new Error("動画トラックがありません");
      this.trackId = track.id;

      const w: number = track.video.width;
      const h: number = track.video.height;
      this.totalPixels = w * h;

      this.opts.videoCanvas.width = w;
      this.opts.videoCanvas.height = h;
      this.vctx = this.opts.videoCanvas.getContext("2d");

      this.analyzer = new Analyzer();
      await this.analyzer.init(w, h, this.opts.diffCanvas);

      const description = getCodecDescription(this.mp4!, this.trackId);

      this.decoder = new VideoDecoder({
        output: (f) => this.queueFrame(f),
        error: (e) => console.error("[decoder]", e),
      });
      this.decoder.configure({
        codec: track.codec,
        codedWidth: w,
        codedHeight: h,
        description,
      });

      this.mp4!.setExtractionOptions(this.trackId, null, { nbSamples: 30 });
      this.mp4!.start();
    } catch (e) {
      console.error(e);
      alert((e as Error).message);
      this.stop();
    }
  }

  private async streamFile() {
    const reader = this.opts.file.stream().getReader();
    let offset = 0;
    while (true) {
      if (this.stopped) return;
      const { done, value } = await reader.read();
      if (done) break;
      const ab = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as MP4ArrayBuffer;
      ab.fileStart = offset;
      this.mp4!.appendBuffer(ab);
      offset += value.byteLength;
    }
    if (!this.stopped) this.mp4!.flush();
  }

  private async feedDecoder(samples: MP4Sample[]) {
    for (const s of samples) {
      if (this.stopped || !this.decoder) return;
      // back-pressure on the decoder so memory doesn't run away
      while (this.decoder.decodeQueueSize > 30) {
        await new Promise((r) => setTimeout(r, 5));
        if (this.stopped) return;
      }
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: (s.cts * 1_000_000) / s.timescale,
          duration: (s.duration * 1_000_000) / s.timescale,
          data: s.data,
        }),
      );
    }
  }

  private queueFrame(frame: VideoFrame) {
    this.chain = this.chain
      .then(() => this.processFrame(frame))
      .catch((e) => {
        console.error(e);
        try {
          frame.close();
        } catch {
          /* already closed */
        }
      });
  }

  private async processFrame(frame: VideoFrame) {
    if (this.stopped) {
      frame.close();
      return;
    }

    if (this.startWall === 0) {
      this.startWall = performance.now();
      this.firstTs = frame.timestamp;
    }

    const tSec = (frame.timestamp - this.firstTs) / 1_000_000;
    const target = this.startWall + tSec * 1000;
    const delay = target - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (this.stopped) {
      frame.close();
      return;
    }

    // 1. Display
    if (this.vctx) {
      this.vctx.drawImage(
        frame as unknown as CanvasImageSource,
        0,
        0,
        this.opts.videoCanvas.width,
        this.opts.videoCanvas.height,
      );
    }

    this.frameNumber++;

    // 2. Compare via WebGPU
    let diffCount = 0;
    let isFirst = true;
    if (this.analyzer) {
      const r = await this.analyzer.compare(frame, this.threshold);
      diffCount = r.diffCount;
      isFirst = r.isFirst;
    }
    frame.close();

    // 3. FPS / duplicate logic
    if (isFirst) {
      this.prevUniqueT = tSec;
      this.uniqueTs.push(tSec);
      this.opts.onStats({
        fps: 0,
        frameTime: 0,
        timestamp: tSec,
        frameNumber: this.frameNumber,
      });
      return;
    }

    const ratio = this.totalPixels > 0 ? diffCount / this.totalPixels : 0;
    if (ratio <= this.frameThreshold) {
      // Considered identical to the previous frame.
      this.opts.onDuplicate({ timestamp: tSec, frameNumber: this.frameNumber });
    } else {
      this.lastFt = tSec - this.prevUniqueT;
      this.prevUniqueT = tSec;
      this.uniqueTs.push(tSec);
    }

    // Trim sliding window of unique frames to the last 1 second.
    while (this.uniqueTs.length > 0 && tSec - this.uniqueTs[0] > 1)
      this.uniqueTs.shift();

    this.opts.onStats({
      fps: this.uniqueTs.length,
      frameTime: this.lastFt,
      timestamp: tSec,
      frameNumber: this.frameNumber,
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.decoder?.close();
    } catch {
      /* */
    }
    try {
      this.mp4?.stop();
    } catch {
      /* */
    }
    this.analyzer?.destroy();
    this.opts.onEnd?.();
  }
}

function getCodecDescription(mp4: MP4File, trackId: number): Uint8Array {
  const track: any = mp4.getTrackById(trackId);
  for (const entry of track.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const ds = new MP4Box.DataStream(
        undefined,
        0,
        MP4Box.DataStream.BIG_ENDIAN,
      );
      box.write(ds);
      // Strip the 8-byte box header (size + type) — the spec wants the
      // configuration record's body only.
      return new Uint8Array(ds.buffer, 8);
    }
  }
  throw new Error("コーデック設定が見つかりません");
}
