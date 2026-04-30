// Pipeline:
//   File -> Mediabunny BlobSource/Input -> VideoSampleSink -> VideoSample
//   -> VideoFrame -> sequential processFrame: schedule, draw to canvas,
//   compare via Analyzer
//
// Mediabunny owns demuxing, decoding, sparse file reads, cache bounds, and
// decoder backpressure. Playback is paced against wall-clock using each
// sample's timestamp.

import {
  ALL_FORMATS,
  BlobSource,
  Input,
  VideoSampleSink,
  type VideoSample,
} from "mediabunny";
import { Analyzer } from "./analyzer";

const FRAME_SNAPSHOT_CACHE_SIZE = 120;

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

export interface StatsEvent {
  historyDelta?: number;
}

interface Options {
  file: File;
  videoCanvas: HTMLCanvasElement;
  diffCanvas: HTMLCanvasElement;
  threshold: number; // per-pixel linearRGB distance threshold
  frameThreshold: number; // ratio of differing pixels to total pixels above which the frame is considered "different"
  onStats: (s: Stats, e?: StatsEvent) => void;
  onDuplicate: (e: DupEvent) => void;
  onEnd?: () => void;
  onPausedChange?: (paused: boolean) => void;
}

interface FrameSnapshot {
  image: ImageBitmap;
  diffImage: ImageBitmap;
}

interface FrameRecord {
  sampleTimestamp: number;
  diffThreshold: number;
  stats: Stats;
}

interface SnapshotCacheEntry {
  recordIndex: number;
  snapshot: FrameSnapshot;
}

export class Player {
  private opts: Options;
  private analyzer: Analyzer | null = null;
  private input: Input | null = null;
  private sampleSink: VideoSampleSink | null = null;
  private threshold: number;
  private frameThreshold: number;
  private totalPixels = 0;
  private stopped = false;

  // playback state
  private vctx: CanvasRenderingContext2D | null = null;
  private startWall = 0;
  private firstTs = 0;
  private frameNumber = 0;
  private paused = false;
  private pauseStarted = 0;
  private stepBudget = 0;
  private stepChain: Promise<void> = Promise.resolve();
  private activeFrameDone: Promise<void> | null = null;
  private resolveActiveFrameDone: (() => void) | null = null;
  private pauseWaiters: (() => void)[] = [];
  private frameRecords: FrameRecord[] = [];
  private snapshotSlots: (SnapshotCacheEntry | null)[] = new Array(
    FRAME_SNAPSHOT_CACHE_SIZE,
  ).fill(null);
  private snapshotMap = new Map<number, FrameSnapshot>();
  private nextSnapshotSlot = 0;
  private historyIndex = -1;

  // FPS estimation state. frameTime is the interval between consecutive
  // unique frames. fps is the count of unique frames in the last 1 second.
  private prevUniqueT = 0; // timestamp (s) of the most recent unique frame
  private lastFt = 0; // most recent inter-unique interval (s)
  private uniqueTs: number[] = [];

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
    return this.enqueueStep(() => this.stepForwardImpl());
  }

  stepBackward() {
    return this.enqueueStep(() => this.stepBackwardImpl());
  }

  private async stepForwardImpl() {
    if (this.stopped) return;
    if (!this.paused) this.pause();
    await this.waitForActiveFrame();
    if (this.stopped) return;

    if (
      this.historyIndex >= 0 &&
      this.historyIndex < this.frameRecords.length - 1
    ) {
      this.historyIndex++;
      await this.renderRecord(this.historyIndex, 1);
      return;
    }

    this.shiftPlaybackClock();
    this.pauseStarted = performance.now();
    this.stepBudget++;
    this.resolvePauseWaiters();
  }

  private async stepBackwardImpl() {
    if (this.stopped || this.frameRecords.length < 2) return;
    if (!this.paused) this.pause();
    await this.waitForActiveFrame();
    if (this.stopped) return;
    if (this.historyIndex < 0) this.historyIndex = this.frameRecords.length - 1;
    if (this.historyIndex === 0) return;
    this.historyIndex--;
    await this.renderRecord(this.historyIndex, -1);
  }

  async start() {
    try {
      const source = new BlobSource(this.opts.file, {
        maxCacheSize: 8 * 1024 * 1024,
      });
      this.input = new Input({
        source,
        formats: ALL_FORMATS,
      });

      const track = await this.input.getPrimaryVideoTrack();
      if (!track) throw new Error("動画トラックがありません");
      if (!(await track.canDecode())) {
        const codec = await track.getCodecParameterString();
        throw new Error(
          `このブラウザでは動画コーデックをデコードできません${codec ? ` (${codec})` : ""}`,
        );
      }
      const w = await track.getCodedWidth();
      const h = await track.getCodedHeight();
      this.totalPixels = w * h;

      this.opts.videoCanvas.width = w;
      this.opts.videoCanvas.height = h;
      this.vctx = this.opts.videoCanvas.getContext("2d");

      this.analyzer = new Analyzer();
      await this.analyzer.init(w, h, this.opts.diffCanvas);

      const sink = new VideoSampleSink(track);
      this.sampleSink = sink;
      for await (const sample of sink.samples()) {
        if (this.stopped) {
          sample.close();
          break;
        }
        await this.processSample(sample);
      }
      if (!this.stopped) this.stop();
    } catch (e) {
      if (this.stopped) return;
      console.error(e);
      alert((e as Error).message);
      this.stop();
    }
  }

  private async processSample(sample: VideoSample) {
    const sampleTimestamp = sample.timestamp;
    const frame = sample.toVideoFrame();
    try {
      await this.processFrame(frame, sampleTimestamp);
    } catch (e) {
      try {
        frame.close();
      } catch {
        /* already closed */
      }
      throw e;
    } finally {
      sample.close();
    }
  }

  private async processFrame(frame: VideoFrame, sampleTimestamp: number) {
    if (this.stopped) {
      frame.close();
      return;
    }

    if (this.startWall === 0) {
      this.startWall = performance.now();
      this.firstTs = frame.timestamp;
    }

    let stepping = await this.waitForPlaybackPermission();
    if (this.stopped) {
      frame.close();
      return;
    }

    const tSec = (frame.timestamp - this.firstTs) / 1_000_000;
    const target = this.startWall + tSec * 1000;
    const delay = target - performance.now();
    if (!stepping && delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (!stepping) {
      stepping = await this.waitForPlaybackPermission();
    }

    if (this.stopped) {
      frame.close();
      return;
    }

    const finishActiveFrame = this.beginActiveFrame();
    try {
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
      const diffSnapshotImage = await createImageBitmap(this.opts.diffCanvas);
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

      const recordIndex = this.pushRecord({
        sampleTimestamp,
        diffThreshold: this.threshold,
        stats,
      });
      this.cacheSnapshot(recordIndex, {
        image: snapshotImage,
        diffImage: diffSnapshotImage,
      });
      this.opts.onStats(stats);
    } finally {
      finishActiveFrame();
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.resolvePauseWaiters();
    this.resolveActiveFrameDone?.();
    this.resolveActiveFrameDone = null;
    this.activeFrameDone = null;
    try {
      this.input?.dispose();
    } catch {
      /* */
    }
    this.input = null;
    this.sampleSink = null;
    this.analyzer?.destroy();
    this.clearSnapshotCache();
    this.frameRecords = [];
    this.historyIndex = -1;
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

  private beginActiveFrame() {
    this.activeFrameDone = new Promise<void>((resolve) => {
      this.resolveActiveFrameDone = resolve;
    });

    return () => {
      this.resolveActiveFrameDone?.();
      this.resolveActiveFrameDone = null;
      this.activeFrameDone = null;
    };
  }

  private async waitForActiveFrame() {
    await this.activeFrameDone;
  }

  private shiftPlaybackClock() {
    if (this.pauseStarted === 0) return;
    this.startWall += performance.now() - this.pauseStarted;
  }

  private resolvePauseWaiters() {
    const waiters = this.pauseWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  private pushRecord(record: FrameRecord) {
    this.frameRecords.push(record);
    this.historyIndex = this.frameRecords.length - 1;
    return this.historyIndex;
  }

  private async renderRecord(recordIndex: number, historyDelta = 0) {
    const record = this.frameRecords[recordIndex];
    if (!record) return;
    const snapshot = await this.getSnapshot(recordIndex);
    if (this.stopped) return;

    if (this.vctx) {
      this.vctx.drawImage(
        snapshot.image,
        0,
        0,
        this.opts.videoCanvas.width,
        this.opts.videoCanvas.height,
      );
    }
    await this.analyzer?.renderDiffImage(snapshot.diffImage);
    if (this.stopped) return;
    this.opts.onStats(record.stats, { historyDelta });
  }

  private async getSnapshot(recordIndex: number) {
    const cached = this.snapshotMap.get(recordIndex);
    if (cached) return cached;

    const record = this.frameRecords[recordIndex];
    if (!record)
      throw new Error(`フレーム履歴が見つかりません: ${recordIndex}`);

    const image = await this.decodeFrameImage(recordIndex);
    try {
      let diffImage: ImageBitmap;

      if (recordIndex === 0) {
        diffImage = await this.createBlankDiffImage();
      } else {
        const prevSnapshot = this.snapshotMap.get(recordIndex - 1);
        if (prevSnapshot) {
          await this.analyzer?.renderDiffBetween(
            prevSnapshot.image,
            image,
            record.diffThreshold,
          );
          diffImage = await createImageBitmap(this.opts.diffCanvas);
        } else {
          const prevImage = await this.decodeFrameImage(recordIndex - 1);
          try {
            await this.analyzer?.renderDiffBetween(
              prevImage,
              image,
              record.diffThreshold,
            );
            diffImage = await createImageBitmap(this.opts.diffCanvas);
          } finally {
            prevImage.close();
          }
        }
      }

      const snapshot = { image, diffImage };
      this.cacheSnapshot(recordIndex, snapshot);
      return snapshot;
    } catch (e) {
      image.close();
      throw e;
    }
  }

  private async decodeFrameImage(recordIndex: number) {
    const sink = this.sampleSink;
    const record = this.frameRecords[recordIndex];
    if (!sink || !record) {
      throw new Error(`フレームを復元できません: ${recordIndex}`);
    }

    const sample = await sink.getSample(record.sampleTimestamp);
    if (!sample) {
      throw new Error(
        `動画サンプルを取得できません: ${record.stats.timestamp.toFixed(3)}s`,
      );
    }

    const frame = sample.toVideoFrame();
    try {
      return await createImageBitmap(frame as unknown as ImageBitmapSource);
    } finally {
      frame.close();
      sample.close();
    }
  }

  private async createBlankDiffImage() {
    const canvas = new OffscreenCanvas(
      this.opts.diffCanvas.width,
      this.opts.diffCanvas.height,
    );
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return createImageBitmap(canvas);
  }

  private cacheSnapshot(recordIndex: number, snapshot: FrameSnapshot) {
    const existing = this.snapshotSlots[this.nextSnapshotSlot];
    if (existing) {
      this.snapshotMap.delete(existing.recordIndex);
      this.closeSnapshot(existing.snapshot);
    }

    this.snapshotSlots[this.nextSnapshotSlot] = { recordIndex, snapshot };
    this.snapshotMap.set(recordIndex, snapshot);
    this.nextSnapshotSlot =
      (this.nextSnapshotSlot + 1) % FRAME_SNAPSHOT_CACHE_SIZE;
  }

  private clearSnapshotCache() {
    for (const entry of this.snapshotSlots) {
      if (entry) this.closeSnapshot(entry.snapshot);
    }
    this.snapshotSlots.fill(null);
    this.snapshotMap.clear();
    this.nextSnapshotSlot = 0;
  }

  private closeSnapshot(snapshot: FrameSnapshot) {
    snapshot.image.close();
    snapshot.diffImage.close();
  }

  private enqueueStep(action: () => Promise<void>) {
    const run = this.stepChain.then(action);
    this.stepChain = run.catch(() => undefined);
    return run;
  }
}
