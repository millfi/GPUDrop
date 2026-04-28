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

// How many decoded VideoFrames may be alive simultaneously waiting for
// processFrame. Each open VideoFrame keeps a slot in the decoder's DPB / GPU
// memory pinned, and Chrome will start corrupting reference frames if too
// many pile up. processFrame paces against wall-clock, so without this cap
// the decoder runs hundreds of frames ahead of playback.
const MAX_OUTSTANDING_FRAMES = 8;

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
  onPausedChange?: (paused: boolean) => void;
}

interface FrameSnapshot {
  image: ImageBitmap;
  stats: Stats;
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
  private paused = false;
  private pauseStarted = 0;
  private stepBudget = 0;
  private pauseWaiters: (() => void)[] = [];
  private frameHistory: FrameSnapshot[] = [];
  private historyIndex = -1;

  // FPS estimation state. frameTime is the interval between consecutive
  // unique frames. fps is the count of unique frames in the last 1 second.
  private prevUniqueT = 0; // timestamp (s) of the most recent unique frame
  private lastFt = 0; // most recent inter-unique interval (s)
  private uniqueTs: number[] = [];

  // Sequential processing chain for decoded frames.
  private chain: Promise<void> = Promise.resolve();
  // Sequence the encoded-sample feeder. mp4box.onSamples is a synchronous
  // callback and we used to fire feedDecoder() with `void`, which let two
  // feedDecoder() invocations run concurrently and race on decoder.decode()
  // — that submits encoded chunks out of order and trashes the decoder.
  private feedChain: Promise<void> = Promise.resolve();
  // Decoded frames the decoder has emitted but processFrame hasn't closed yet.
  private outstandingFrames = 0;

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

  pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.pauseStarted = performance.now();
    this.opts.onPausedChange?.(true);
  }

  resume() {
    if (this.stopped || !this.paused) return;
    this.shiftPlaybackClock();
    this.paused = false;
    this.pauseStarted = 0;
    this.resolvePauseWaiters();
    this.opts.onPausedChange?.(false);
  }

  stepForward() {
    if (this.stopped) return;
    if (!this.paused) this.pause();

    if (this.historyIndex >= 0 && this.historyIndex < this.frameHistory.length - 1) {
      this.historyIndex++;
      this.renderSnapshot(this.frameHistory[this.historyIndex]);
      return;
    }

    this.shiftPlaybackClock();
    this.pauseStarted = performance.now();
    this.stepBudget++;
    this.resolvePauseWaiters();
  }

  stepBackward() {
    if (this.stopped || this.frameHistory.length < 2) return;
    if (!this.paused) this.pause();
    if (this.historyIndex < 0) this.historyIndex = this.frameHistory.length - 1;
    if (this.historyIndex === 0) return;
    this.historyIndex--;
    this.renderSnapshot(this.frameHistory[this.historyIndex]);
  }

  async start() {
    this.mp4 = MP4Box.createFile();

    this.mp4.onError = (e) => console.error("[mp4box]", e);

    this.mp4.onReady = (info) => {
      void this.handleReady(info);
    };

    this.mp4.onSamples = (id, _user, samples) => {
      if (id !== this.trackId || !this.decoder) return;
      // Serialise feed calls so concurrent invocations can't reorder
      // decoder.decode() submissions.
      this.feedChain = this.feedChain.then(() => this.feedDecoder(samples));
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
      // Back-pressure on both encoded queue depth (memory) and decoded-frame
      // backlog (DPB / GPU buffers). The second check is the important one:
      // processFrame paces against wall-clock and the decoder runs ahead, so
      // without this the decoder's reference frames eventually get clobbered.
      while (
        this.decoder.decodeQueueSize > 30 ||
        this.outstandingFrames > MAX_OUTSTANDING_FRAMES
      ) {
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
    this.outstandingFrames++;
    this.chain = this.chain
      .then(() => this.processFrame(frame))
      .catch((e) => {
        console.error(e);
        try {
          frame.close();
        } catch {
          /* already closed */
        }
      })
      .finally(() => {
        this.outstandingFrames--;
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

    const stepping = await this.waitForPlaybackPermission();
    if (this.stopped) {
      frame.close();
      return;
    }

    const tSec = (frame.timestamp - this.firstTs) / 1_000_000;
    const target = this.startWall + tSec * 1000;
    const delay = target - performance.now();
    if (!stepping && delay > 0) await new Promise((r) => setTimeout(r, delay));

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
    const snapshotImage = await createImageBitmap(
      frame as unknown as ImageBitmapSource,
    );

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

    // 3. FPS / duplicate logic.
    // frameTime updates on unique frames. fps is the number of unique frames
    // observed in the rolling 1-second window ending at this frame.
    if (isFirst) {
      this.prevUniqueT = tSec;
      this.uniqueTs.push(tSec);
    } else {
      const ratio = this.totalPixels > 0 ? diffCount / this.totalPixels : 0;
      if (ratio <= this.frameThreshold) {
        this.opts.onDuplicate({
          timestamp: tSec,
          frameNumber: this.frameNumber,
        });
      } else {
        this.lastFt = tSec - this.prevUniqueT;
        this.prevUniqueT = tSec;
        this.uniqueTs.push(tSec);
      }
    }
    while (this.uniqueTs.length > 0 && this.uniqueTs[0] <= tSec - 1) {
      this.uniqueTs.shift();
    }

    const frameTime = this.lastFt; // seconds
    const fps = this.uniqueTs.length;

    const stats = {
      fps,
      frameTime,
      timestamp: tSec,
      frameNumber: this.frameNumber,
    };

    this.pushHistory({ image: snapshotImage, stats });
    this.opts.onStats(stats);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.resolvePauseWaiters();
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
    this.frameHistory.forEach((s) => s.image.close());
    this.frameHistory = [];
    this.opts.onEnd?.();
  }

  private async waitForPlaybackPermission() {
    while (this.paused && this.stepBudget === 0 && !this.stopped) {
      await new Promise<void>((resolve) => {
        this.pauseWaiters.push(resolve);
      });
    }
    if (this.stepBudget > 0) {
      this.stepBudget--;
      return true;
    }
    return false;
  }

  private shiftPlaybackClock() {
    if (this.pauseStarted === 0) return;
    this.startWall += performance.now() - this.pauseStarted;
  }

  private resolvePauseWaiters() {
    const waiters = this.pauseWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  private pushHistory(snapshot: FrameSnapshot) {
    if (this.historyIndex >= 0 && this.historyIndex < this.frameHistory.length - 1) {
      for (const old of this.frameHistory.splice(this.historyIndex + 1)) {
        old.image.close();
      }
    }
    this.frameHistory.push(snapshot);
    while (this.frameHistory.length > 3) {
      this.frameHistory.shift()?.image.close();
    }
    this.historyIndex = this.frameHistory.length - 1;
  }

  private renderSnapshot(snapshot: FrameSnapshot) {
    if (this.vctx) {
      this.vctx.drawImage(
        snapshot.image,
        0,
        0,
        this.opts.videoCanvas.width,
        this.opts.videoCanvas.height,
      );
    }
    this.opts.onStats(snapshot.stats);
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
