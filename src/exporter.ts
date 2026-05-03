import {
  ALL_FORMATS,
  BlobSource,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  canEncodeVideo,
  type StreamTargetChunk,
  type VideoCodec,
  type VideoEncodingConfig,
} from "mediabunny";
import { Analyzer } from "./analyzer";
import type { DupEvent, Stats } from "./player";

const HISTORY_CAP = 600;
const EXPORT_QUALITY_FACTOR = 4;
const DEFAULT_FRAME_DURATION = 1 / 60;
const EXPORT_CHUNK_SIZE = 16 * 1024 * 1024;

const AVC_LEVEL_TABLE = [
  { maxMacroblocks: 99, maxBitrate: 64000, level: 0x0a },
  { maxMacroblocks: 396, maxBitrate: 192000, level: 0x0b },
  { maxMacroblocks: 396, maxBitrate: 384000, level: 0x0c },
  { maxMacroblocks: 396, maxBitrate: 768000, level: 0x0d },
  { maxMacroblocks: 396, maxBitrate: 2_000_000, level: 0x14 },
  { maxMacroblocks: 792, maxBitrate: 4_000_000, level: 0x15 },
  { maxMacroblocks: 1620, maxBitrate: 4_000_000, level: 0x16 },
  { maxMacroblocks: 1620, maxBitrate: 10_000_000, level: 0x1e },
  { maxMacroblocks: 3600, maxBitrate: 14_000_000, level: 0x1f },
  { maxMacroblocks: 5120, maxBitrate: 20_000_000, level: 0x20 },
  { maxMacroblocks: 8192, maxBitrate: 20_000_000, level: 0x28 },
  { maxMacroblocks: 8192, maxBitrate: 50_000_000, level: 0x29 },
  { maxMacroblocks: 8704, maxBitrate: 50_000_000, level: 0x2a },
  { maxMacroblocks: 22080, maxBitrate: 135_000_000, level: 0x32 },
  { maxMacroblocks: 36864, maxBitrate: 240_000_000, level: 0x33 },
  { maxMacroblocks: 36864, maxBitrate: 240_000_000, level: 0x34 },
  { maxMacroblocks: 139264, maxBitrate: 240_000_000, level: 0x3c },
  { maxMacroblocks: 139264, maxBitrate: 480_000_000, level: 0x3d },
  { maxMacroblocks: 139264, maxBitrate: 800_000_000, level: 0x3e },
] as const;

const HEVC_LEVEL_TABLE = [
  { maxPictureSize: 36864, maxBitrate: 128000, tier: "L", level: 30 },
  { maxPictureSize: 122880, maxBitrate: 1_500_000, tier: "L", level: 60 },
  { maxPictureSize: 245760, maxBitrate: 3_000_000, tier: "L", level: 63 },
  { maxPictureSize: 552960, maxBitrate: 6_000_000, tier: "L", level: 90 },
  { maxPictureSize: 983040, maxBitrate: 10_000_000, tier: "L", level: 93 },
  { maxPictureSize: 2228224, maxBitrate: 12_000_000, tier: "L", level: 120 },
  { maxPictureSize: 2228224, maxBitrate: 30_000_000, tier: "H", level: 120 },
  { maxPictureSize: 2228224, maxBitrate: 20_000_000, tier: "L", level: 123 },
  { maxPictureSize: 2228224, maxBitrate: 50_000_000, tier: "H", level: 123 },
  { maxPictureSize: 8912896, maxBitrate: 25_000_000, tier: "L", level: 150 },
  { maxPictureSize: 8912896, maxBitrate: 100_000_000, tier: "H", level: 150 },
  { maxPictureSize: 8912896, maxBitrate: 40_000_000, tier: "L", level: 153 },
  { maxPictureSize: 8912896, maxBitrate: 160_000_000, tier: "H", level: 153 },
  { maxPictureSize: 8912896, maxBitrate: 60_000_000, tier: "L", level: 156 },
  { maxPictureSize: 8912896, maxBitrate: 240_000_000, tier: "H", level: 156 },
  { maxPictureSize: 35651584, maxBitrate: 60_000_000, tier: "L", level: 180 },
  { maxPictureSize: 35651584, maxBitrate: 240_000_000, tier: "H", level: 180 },
  { maxPictureSize: 35651584, maxBitrate: 120_000_000, tier: "L", level: 183 },
  { maxPictureSize: 35651584, maxBitrate: 480_000_000, tier: "H", level: 183 },
  { maxPictureSize: 35651584, maxBitrate: 240_000_000, tier: "L", level: 186 },
  { maxPictureSize: 35651584, maxBitrate: 800_000_000, tier: "H", level: 186 },
] as const;

const AV1_LEVEL_TABLE = [
  { maxPictureSize: 147456, maxBitrate: 1_500_000, tier: "M", level: 0 },
  { maxPictureSize: 278784, maxBitrate: 3_000_000, tier: "M", level: 1 },
  { maxPictureSize: 665856, maxBitrate: 6_000_000, tier: "M", level: 4 },
  { maxPictureSize: 1065024, maxBitrate: 10_000_000, tier: "M", level: 5 },
  { maxPictureSize: 2359296, maxBitrate: 12_000_000, tier: "M", level: 8 },
  { maxPictureSize: 2359296, maxBitrate: 30_000_000, tier: "H", level: 8 },
  { maxPictureSize: 2359296, maxBitrate: 20_000_000, tier: "M", level: 9 },
  { maxPictureSize: 2359296, maxBitrate: 50_000_000, tier: "H", level: 9 },
  { maxPictureSize: 8912896, maxBitrate: 30_000_000, tier: "M", level: 12 },
  { maxPictureSize: 8912896, maxBitrate: 100_000_000, tier: "H", level: 12 },
  { maxPictureSize: 8912896, maxBitrate: 40_000_000, tier: "M", level: 13 },
  { maxPictureSize: 8912896, maxBitrate: 160_000_000, tier: "H", level: 13 },
  { maxPictureSize: 8912896, maxBitrate: 60_000_000, tier: "M", level: 14 },
  { maxPictureSize: 8912896, maxBitrate: 240_000_000, tier: "H", level: 14 },
  { maxPictureSize: 35651584, maxBitrate: 60_000_000, tier: "M", level: 15 },
  { maxPictureSize: 35651584, maxBitrate: 240_000_000, tier: "H", level: 15 },
  { maxPictureSize: 35651584, maxBitrate: 60_000_000, tier: "M", level: 16 },
  { maxPictureSize: 35651584, maxBitrate: 240_000_000, tier: "H", level: 16 },
  { maxPictureSize: 35651584, maxBitrate: 100_000_000, tier: "M", level: 17 },
  { maxPictureSize: 35651584, maxBitrate: 480_000_000, tier: "H", level: 17 },
  { maxPictureSize: 35651584, maxBitrate: 160_000_000, tier: "M", level: 18 },
  { maxPictureSize: 35651584, maxBitrate: 800_000_000, tier: "H", level: 18 },
  { maxPictureSize: 35651584, maxBitrate: 160_000_000, tier: "M", level: 19 },
  { maxPictureSize: 35651584, maxBitrate: 800_000_000, tier: "H", level: 19 },
] as const;

export interface AxisRange {
  min: number;
  max: number;
}

export interface ExportProgress {
  timestamp: number;
  duration: number;
  progress: number;
  codecLabel: string;
}

export interface ExportOptions {
  file: File;
  videoCanvas: HTMLCanvasElement;
  diffCanvas: HTMLCanvasElement;
  threshold: number;
  frameThreshold: number;
  fpsRange: AxisRange;
  ftRange: AxisRange;
  signal: AbortSignal;
  onStats: (stats: Stats) => void;
  onDuplicate: (event: DupEvent) => void;
  onProgress: (progress: ExportProgress) => void;
}

interface ExportTargetInfo {
  fileName: string;
  target: StreamTarget;
  complete: (mimeType: string) => Promise<void>;
}

interface SparseChunk {
  data: Uint8Array;
  position: number;
}

interface CodecCandidate {
  codec: VideoCodec;
  codecLabel: string;
  fullCodecString?: string;
}

export class ExportCanceledError extends Error {
  constructor() {
    super("書き出しを中断しました");
    this.name = "ExportCanceledError";
  }
}

export async function exportOverlayVideo(options: ExportOptions) {
  const source = new BlobSource(options.file, {
    maxCacheSize: 8 * 1024 * 1024,
  });
  const input = new Input({
    source,
    formats: ALL_FORMATS,
  });
  const analyzer = new Analyzer();
  const outputCanvas = document.createElement("canvas");
  let output: Output<Mp4OutputFormat, StreamTarget> | null = null;
  let canceling: Promise<void> | null = null;

  const cancelOutput = () => {
    if (
      !output ||
      output.state === "canceled" ||
      output.state === "finalized"
    ) {
      return Promise.resolve();
    }
    canceling ??= output.cancel().catch(() => undefined);
    return canceling;
  };

  const handleAbort = () => {
    void cancelOutput();
  };

  options.signal.addEventListener("abort", handleAbort);

  try {
    throwIfAborted(options.signal);
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("動画トラックがありません");
    if (!(await track.canDecode())) {
      const codec = await track.getCodecParameterString();
      throw new Error(
        `このブラウザでは動画コーデックをデコードできません${codec ? ` (${codec})` : ""}`,
      );
    }

    const mediaStartTime = await track.getFirstTimestamp();
    const metadataEnd = await input.getDurationFromMetadata([track], {
      skipLiveWait: true,
    });
    const endTime =
      metadataEnd ??
      (await input.computeDuration([track], { skipLiveWait: true }));
    const duration = Math.max(0, endTime - mediaStartTime);
    const sourceWidth = await track.getCodedWidth();
    const sourceHeight = await track.getCodedHeight();
    const outputWidth = roundUpToEven(sourceWidth);
    const outputHeight = roundUpToEven(sourceHeight);
    const totalPixels = sourceWidth * sourceHeight;

    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    options.videoCanvas.width = outputWidth;
    options.videoCanvas.height = outputHeight;
    const outputCtx = required2dContext(outputCanvas);
    const displayCtx = required2dContext(options.videoCanvas);

    await analyzer.init(sourceWidth, sourceHeight, options.diffCanvas);
    const encodingConfig = await selectEncodingConfig(
      outputWidth,
      outputHeight,
    );
    const exportTarget = await createExportTarget(options.file);

    throwIfAborted(options.signal);
    const canvasSource = new CanvasSource(outputCanvas, encodingConfig);
    output = new Output({
      format: new Mp4OutputFormat(),
      target: exportTarget.target,
    });
    output.addVideoTrack(canvasSource);
    await output.start();

    const sampleSink = new VideoSampleSink(track);
    const history: { fps: number; ft: number }[] = [];
    const uniqueTimestamps: number[] = [];
    let frameNumber = 0;
    let previousUniqueTimestamp = 0;
    let lastFrameTime = 0;
    let lastDuration = DEFAULT_FRAME_DURATION;

    for await (const sample of sampleSink.samples(mediaStartTime)) {
      throwIfAborted(options.signal);
      const frame = sample.toVideoFrame();
      const sampleTimestamp = sample.timestamp;
      const relativeTimestamp = Math.max(0, sampleTimestamp - mediaStartTime);
      const sampleDuration =
        sample.duration > 0 ? sample.duration : lastDuration;
      lastDuration = sampleDuration > 0 ? sampleDuration : lastDuration;

      try {
        outputCtx.clearRect(0, 0, outputWidth, outputHeight);
        outputCtx.drawImage(
          frame as unknown as CanvasImageSource,
          0,
          0,
          outputWidth,
          outputHeight,
        );

        frameNumber++;
        let diffCount = 0;
        let isFirst = true;
        const result = await analyzer.compare(frame, options.threshold);
        diffCount = result.diffCount;
        isFirst = result.isFirst;
        frame.close();

        if (isFirst) {
          previousUniqueTimestamp = relativeTimestamp;
          uniqueTimestamps.push(relativeTimestamp);
        } else {
          const ratio = totalPixels > 0 ? diffCount / totalPixels : 0;
          if (ratio <= options.frameThreshold) {
            options.onDuplicate({
              timestamp: relativeTimestamp,
              frameNumber,
            });
          } else {
            lastFrameTime = relativeTimestamp - previousUniqueTimestamp;
            previousUniqueTimestamp = relativeTimestamp;
            uniqueTimestamps.push(relativeTimestamp);
          }
        }

        while (
          uniqueTimestamps.length > 0 &&
          uniqueTimestamps[0] <= relativeTimestamp - 1
        ) {
          uniqueTimestamps.shift();
        }

        const stats = {
          fps: uniqueTimestamps.length,
          frameTime: lastFrameTime,
          timestamp: relativeTimestamp,
          frameNumber,
        };
        history.push({ fps: stats.fps, ft: stats.frameTime * 1000 });
        drawExportCharts(outputCtx, outputWidth, outputHeight, history, {
          fpsRange: options.fpsRange,
          ftRange: options.ftRange,
        });
        displayCtx.clearRect(0, 0, outputWidth, outputHeight);
        displayCtx.drawImage(outputCanvas, 0, 0);
        options.onStats(stats);
        options.onProgress({
          timestamp: relativeTimestamp,
          duration,
          progress: duration > 0 ? clamp(relativeTimestamp / duration, 0, 1) : 0,
          codecLabel: encodingConfig.codecLabel,
        });

        await canvasSource.add(relativeTimestamp, sampleDuration);
      } finally {
        try {
          frame.close();
        } catch {
          /* already closed */
        }
        sample.close();
      }
    }

    throwIfAborted(options.signal);
    await output.finalize();
    const mimeType = await output.getMimeType();
    await exportTarget.complete(mimeType);
    options.onProgress({
      timestamp: duration,
      duration,
      progress: 1,
      codecLabel: encodingConfig.codecLabel,
    });
  } catch (error) {
    if (options.signal.aborted || error instanceof ExportCanceledError) {
      await cancelOutput();
      throw new ExportCanceledError();
    }
    await cancelOutput();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", handleAbort);
    analyzer.destroy();
    input.dispose();
  }
}

async function selectEncodingConfig(width: number, height: number) {
  const candidates = buildCodecCandidates(width, height);
  for (const candidate of candidates) {
    const bitrate = estimateVideoBitrate(candidate.codec, width, height);
    const canEncode = await canEncodeVideo(candidate.codec, {
      width,
      height,
      bitrate,
      bitrateMode: "variable",
      latencyMode: "quality",
      hardwareAcceleration: "prefer-hardware",
      fullCodecString: candidate.fullCodecString,
    });
    if (canEncode) {
      return {
        codecLabel: candidate.codecLabel,
        codec: candidate.codec,
        bitrate,
        bitrateMode: "variable",
        latencyMode: "quality",
        hardwareAcceleration: "prefer-hardware",
        fullCodecString: candidate.fullCodecString,
        keyFrameInterval: 2,
      } satisfies VideoEncodingConfig & { codecLabel: string };
    }
  }

  throw new Error("この環境で利用できる書き出し用動画コーデックがありません");
}

function buildCodecCandidates(width: number, height: number): CodecCandidate[] {
  const av1Bitrate = estimateVideoBitrate("av1", width, height);
  const hevcBitrate = estimateVideoBitrate("hevc", width, height);
  const avcBitrate = estimateVideoBitrate("avc", width, height);

  return [
    {
      codec: "av1",
      codecLabel: "AV1 yuv420p10le",
      fullCodecString: buildAv1Main10CodecString(width, height, av1Bitrate),
    },
    {
      codec: "hevc",
      codecLabel: "HEVC yuv420p10le",
      fullCodecString: buildHevcMain10CodecString(width, height, hevcBitrate),
    },
    {
      codec: "avc",
      codecLabel: "AVC yuv420p",
      fullCodecString: buildAvcHighCodecString(width, height, avcBitrate),
    },
  ];
}

function estimateVideoBitrate(
  codec: VideoCodec,
  width: number,
  height: number,
) {
  const codecEfficiencyFactors: Record<VideoCodec, number> = {
    avc: 1,
    hevc: 0.6,
    vp9: 0.6,
    av1: 0.4,
    vp8: 1.2,
  };
  const pixels = width * height;
  const referencePixels = 1920 * 1080;
  const referenceBitrate = 3_000_000;
  const scaleFactor = Math.pow(pixels / referencePixels, 0.95);
  const baseBitrate = referenceBitrate * scaleFactor;
  const finalBitrate =
    baseBitrate * codecEfficiencyFactors[codec] * EXPORT_QUALITY_FACTOR;

  return Math.ceil(finalBitrate / 1000) * 1000;
}

function buildAv1Main10CodecString(
  width: number,
  height: number,
  bitrate: number,
) {
  const pictureSize = width * height;
  const level =
    AV1_LEVEL_TABLE.find(
      (entry) =>
        pictureSize <= entry.maxPictureSize && bitrate <= entry.maxBitrate,
    ) ?? AV1_LEVEL_TABLE[AV1_LEVEL_TABLE.length - 1];

  return `av01.0.${String(level.level).padStart(2, "0")}${level.tier}.10.0.110.01.01.01.0`;
}

function buildHevcMain10CodecString(
  width: number,
  height: number,
  bitrate: number,
) {
  const pictureSize = width * height;
  const level =
    HEVC_LEVEL_TABLE.find(
      (entry) =>
        pictureSize <= entry.maxPictureSize && bitrate <= entry.maxBitrate,
    ) ?? HEVC_LEVEL_TABLE[HEVC_LEVEL_TABLE.length - 1];

  return `hev1.2.4.${level.tier}${level.level}.B0`;
}

function buildAvcHighCodecString(
  width: number,
  height: number,
  bitrate: number,
) {
  const totalMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level =
    AVC_LEVEL_TABLE.find(
      (entry) =>
        totalMacroblocks <= entry.maxMacroblocks &&
        bitrate <= entry.maxBitrate,
    ) ?? AVC_LEVEL_TABLE[AVC_LEVEL_TABLE.length - 1];

  return `avc1.6400${level.level.toString(16).padStart(2, "0")}`;
}

function drawExportCharts(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  history: { fps: number; ft: number }[],
  options: { fpsRange: AxisRange; ftRange: AxisRange },
) {
  const visibleHistory = history.slice(Math.max(0, history.length - HISTORY_CAP));
  const margin = clamp(Math.round(Math.min(width, height) * 0.025), 8, 28);
  const gap = clamp(Math.round(height * 0.012), 6, 16);
  const chartHeight = clamp(Math.round(height * 0.16), 54, 150);
  const chartWidth = Math.max(1, width - margin * 2);
  const top = Math.max(margin, height - margin - chartHeight * 2 - gap);
  const ftRect = {
    x: margin,
    y: top,
    width: chartWidth,
    height: chartHeight,
  };
  const fpsRect = {
    x: margin,
    y: top + chartHeight + gap,
    width: chartWidth,
    height: chartHeight,
  };

  drawTransparentChart(
    ctx,
    ftRect,
    visibleHistory.map((item) => item.ft),
    options.ftRange,
  );
  drawTransparentChart(
    ctx,
    fpsRect,
    visibleHistory.map((item) => item.fps),
    options.fpsRange,
  );
}

function drawTransparentChart(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  data: number[],
  axisRange: AxisRange,
) {
  const { min, max } = normalizeAxisRange(axisRange);
  const plotLeft = rect.x;
  const plotRight = rect.x + rect.width;
  const plotTop = rect.y;
  const plotBottom = rect.y + rect.height;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  ctx.save();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.5, Math.min(rect.width, rect.height) / 95);
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  if (data.length >= 2) {
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const value = clamp(data[i], min, max);
      const x = plotLeft + (i / (HISTORY_CAP - 1)) * plotWidth;
      const y = plotBottom - ((value - min) / (max - min)) * plotHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

async function createExportTarget(file: File): Promise<ExportTargetInfo> {
  const fileName = createExportFileName(file.name);
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: {
          description: string;
          accept: Record<string, string[]>;
        }[];
      }) => Promise<{
        createWritable: () => Promise<WritableStream<StreamTargetChunk>>;
      }>;
    }
  ).showSaveFilePicker;

  if (picker) {
    const handle = await picker({
      suggestedName: fileName,
      types: [
        {
          description: "MP4 Video",
          accept: { "video/mp4": [".mp4"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    return {
      fileName,
      target: new StreamTarget(writable, {
        chunked: true,
        chunkSize: EXPORT_CHUNK_SIZE,
      }),
      complete: async () => undefined,
    };
  }

  const chunks: SparseChunk[] = [];
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      chunks.push({
        position: chunk.position,
        data: new Uint8Array(chunk.data),
      });
    },
  });

  return {
    fileName,
    target: new StreamTarget(writable, {
      chunked: true,
      chunkSize: EXPORT_CHUNK_SIZE,
    }),
    complete: async (mimeType) => {
      let size = 0;
      for (const chunk of chunks) {
        size = Math.max(size, chunk.position + chunk.data.byteLength);
      }
      const bytes = new Uint8Array(size);
      for (const chunk of chunks) {
        bytes.set(chunk.data, chunk.position);
      }
      const url = URL.createObjectURL(
        new Blob([bytes], { type: mimeType || "video/mp4" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  };
}

function createExportFileName(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${base || "video"}-overlay.mp4`;
}

function normalizeAxisRange(range: AxisRange) {
  const min = Number.isFinite(range.min) ? range.min : 0;
  const max = Number.isFinite(range.max) ? range.max : min + 1;
  if (max - min >= 1) return { min, max };
  return { min, max: min + 1 };
}

function required2dContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas contextを取得できません");
  return context;
}

function roundUpToEven(value: number) {
  return value % 2 === 0 ? value : value + 1;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new ExportCanceledError();
}
