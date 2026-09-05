import {
  ALL_FORMATS,
  BlobSource,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  canEncodeVideo,
  type EncodedPacket,
  type InputAudioTrack,
  type StreamTargetChunk,
  type VideoCodec,
  type VideoEncodingConfig,
} from "mediabunny";
import {
  Analyzer,
  getAnalyzedPixelCount,
  type RectMask,
} from "./analyzer";
import { FpsEstimator, type DupEvent, type Stats } from "./player";
import { t } from "./i18n";
import {
  drawOverlay,
  type AxisRange,
  type OverlayHistoryPoint,
  type OverlayLayout,
} from "./overlay";

import { DEFAULT_ENCODING_SETTINGS, makeEncodingConfig, validateEncodingSettings, type EncodingSettings } from "./encoding-settings";

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

export interface ExportProgress {
  timestamp: number;
  duration: number;
  progress: number;
  codecLabel: string;
}

export interface ExportOptions {
  file: File;
  encoding?: EncodingSettings;
  videoCanvas: HTMLCanvasElement;
  diffCanvas: HTMLCanvasElement;
  threshold: number;
  frameThreshold: number;
  masks: readonly RectMask[];
  layout: OverlayLayout;
  fpsRange: AxisRange;
  ftRange: AxisRange;
  historyMaxPoints: number;
  signal: AbortSignal;
  onStats: (stats: Stats) => void;
  onDuplicate: (event: DupEvent) => void;
  onProgress: (progress: ExportProgress) => void;
}

export interface ExportResult {
  audioSkippedReason: string | null;
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

type ExportVideoCodec = Extract<VideoCodec, "av1" | "hevc" | "avc">;

interface CodecCandidate {
  codec: ExportVideoCodec;
  codecLabel: string;
  fullCodecString?: string;
}

interface AudioPassthroughPlan {
  source: EncodedAudioPacketSource;
  sink: EncodedPacketSink;
  startPacket: EncodedPacket;
  decoderConfig: AudioDecoderConfig | null;
}

interface AudioPassthroughPreparation {
  plan: AudioPassthroughPlan | null;
  skippedReason: string | null;
}

export class ExportCanceledError extends Error {
  constructor() {
    super(t("書き出しを中断しました", "Export was canceled"));
    this.name = "ExportCanceledError";
  }
}

export async function exportOverlayVideo(
  options: ExportOptions,
): Promise<ExportResult> {
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
  let audioCopyPromise: Promise<void> | null = null;
  let audioCopyError: unknown = null;

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
    if (!track) {
      throw new Error(t("動画トラックがありません", "No video track found"));
    }
    if (!(await track.canDecode())) {
      const codec = await track.getCodecParameterString();
      throw new Error(
        t(
          `このブラウザでは動画コーデックをデコードできません${codec ? ` (${codec})` : ""}`,
          `This browser cannot decode the video codec${codec ? ` (${codec})` : ""}`,
        ),
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
    const analyzedPixels = getAnalyzedPixelCount(
      options.masks,
      sourceWidth,
      sourceHeight,
    );
    if (analyzedPixels === 0) {
      throw new Error(t("マスクを減らして解析対象を残してください", "Reduce the masks to leave pixels to analyze"));
    }

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
      options.encoding,
    );
    const outputFormat = new Mp4OutputFormat();
    const audioPreparation = await prepareAudioPassthrough(
      input,
      outputFormat,
      mediaStartTime,
    );
    const exportTarget = await createExportTarget(options.file);

    throwIfAborted(options.signal);
    const canvasSource = new CanvasSource(outputCanvas, encodingConfig);
    output = new Output({
      format: outputFormat,
      target: exportTarget.target,
    });
    output.addVideoTrack(canvasSource);
    if (audioPreparation.plan) {
      output.addAudioTrack(audioPreparation.plan.source);
    }
    await output.start();
    if (audioPreparation.plan) {
      audioCopyPromise = copyAudioPackets(
        audioPreparation.plan,
        mediaStartTime,
        endTime,
        options.signal,
      ).catch((error: unknown) => {
        audioCopyError = error;
      });
    }

    const sampleSink = new VideoSampleSink(track);
    const history: OverlayHistoryPoint[] = [];
    const historyCapacity = Number.isFinite(options.historyMaxPoints)
      ? Math.max(2, Math.floor(options.historyMaxPoints))
      : 600;
    const fpsEstimator = new FpsEstimator();
    let frameNumber = 0;
    let lastDuration = DEFAULT_FRAME_DURATION;

    for await (const sample of sampleSink.samples(mediaStartTime)) {
      throwIfAborted(options.signal);
      if (audioCopyError) throw audioCopyError;
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
        // Keep the live preview as an unmodified source frame. App.tsx draws
        // the same overlay on its separate preview canvas, avoiding a double
        // overlay while still matching the exported frame exactly.
        displayCtx.clearRect(0, 0, outputWidth, outputHeight);
        displayCtx.drawImage(outputCanvas, 0, 0);

        frameNumber++;
        const result = await analyzer.compare(
          frame,
          options.threshold,
          options.masks,
        );
        frame.close();

        const fpsSample = fpsEstimator.process({
          tSec: relativeTimestamp,
          diffCount: result.diffCount,
          isFirst: result.isFirst,
          analyzedPixels,
          frameThreshold: options.frameThreshold,
        });
        if (fpsSample.isDuplicate) {
          options.onDuplicate({
            timestamp: relativeTimestamp,
            frameNumber,
          });
        }

        const stats = {
          fps: fpsSample.fps,
          frameTime: fpsSample.frameTime,
          timestamp: relativeTimestamp,
          frameNumber,
        };
        history.push({ fps: stats.fps, ft: stats.frameTime * 1000 });
        if (history.length > historyCapacity) {
          history.splice(0, history.length - historyCapacity);
        }
        drawOverlay(
          outputCtx,
          outputWidth,
          outputHeight,
          options.layout,
          {
            history,
            historyIndex: history.length - 1,
            fps: stats.fps,
          },
          {
            fpsRange: options.fpsRange,
            ftRange: options.ftRange,
            maxPoints: historyCapacity,
          },
        );
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
    canvasSource.close();
    if (audioCopyPromise) await audioCopyPromise;
    if (audioCopyError) throw audioCopyError;
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
    return { audioSkippedReason: audioPreparation.skippedReason };
  } catch (error) {
    if (options.signal.aborted || error instanceof ExportCanceledError) {
      await cancelOutput();
      if (audioCopyPromise) await audioCopyPromise;
      throw new ExportCanceledError();
    }
    await cancelOutput();
    if (audioCopyPromise) await audioCopyPromise;
    throw error;
  } finally {
    options.signal.removeEventListener("abort", handleAbort);
    analyzer.destroy();
    input.dispose();
  }
}

async function prepareAudioPassthrough(
  input: Input,
  outputFormat: Mp4OutputFormat,
  mediaStartTime: number,
): Promise<AudioPassthroughPreparation> {
  let track: InputAudioTrack | null;
  try {
    track = await input.getPrimaryAudioTrack();
  } catch (error) {
    return {
      plan: null,
      skippedReason: t(
        `音声トラックを読み取れません (${getErrorMessage(error)})`,
        `Could not read the audio track (${getErrorMessage(error)})`,
      ),
    };
  }
  if (!track) return { plan: null, skippedReason: null };

  try {
    const codec = await track.getCodec();
    const codecParameter = await track.getCodecParameterString();
    const codecLabel = codecParameter ?? codec ?? t("不明", "unknown");
    if (!codec) {
      return {
        plan: null,
        skippedReason: t(
          `音声コーデックを判別できません (${codecLabel})`,
          `Could not identify the audio codec (${codecLabel})`,
        ),
      };
    }
    if (!outputFormat.getSupportedAudioCodecs().includes(codec)) {
      return {
        plan: null,
        skippedReason: t(
          `MP4へコピーできない音声コーデックです (${codecLabel})`,
          `The audio codec cannot be copied to MP4 (${codecLabel})`,
        ),
      };
    }

    const sink = new EncodedPacketSink(track);
    const packetAtStart = await sink.getPacket(mediaStartTime, {
      skipLiveWait: true,
    });
    const startPacket =
      packetAtStart ??
      (await sink.getFirstPacket({
        skipLiveWait: true,
      }));
    if (!startPacket) {
      return {
        plan: null,
        skippedReason: t(
          "音声トラックにコピー可能なデータがありません",
          "The audio track contains no copyable data",
        ),
      };
    }

    return {
      plan: {
        source: new EncodedAudioPacketSource(codec),
        sink,
        startPacket,
        decoderConfig: await track.getDecoderConfig(),
      },
      skippedReason: null,
    };
  } catch (error) {
    return {
      plan: null,
      skippedReason: t(
        `音声のコピー準備に失敗しました (${getErrorMessage(error)})`,
        `Could not prepare audio passthrough (${getErrorMessage(error)})`,
      ),
    };
  }
}

async function copyAudioPackets(
  plan: AudioPassthroughPlan,
  mediaStartTime: number,
  mediaEndTime: number,
  signal: AbortSignal,
) {
  let isFirstOutputPacket = true;
  try {
    for await (const packet of plan.sink.packets(plan.startPacket, undefined, {
      skipLiveWait: true,
    })) {
      throwIfAborted(signal);
      if (packet.timestamp >= mediaEndTime) break;
      if (packet.timestamp + packet.duration <= mediaStartTime) continue;

      const shiftedPacket = packet.clone({
        timestamp: packet.timestamp - mediaStartTime,
      });
      await plan.source.add(
        shiftedPacket,
        isFirstOutputPacket
          ? { decoderConfig: plan.decoderConfig ?? undefined }
          : undefined,
      );
      isFirstOutputPacket = false;
    }
  } finally {
    plan.source.close();
  }
}

export async function selectEncodingConfig(width: number, height: number, settings = DEFAULT_ENCODING_SETTINGS) {
  const error = validateEncodingSettings(settings);
  if (error) throw new Error(error);
  const candidates = buildCodecCandidates(width, height).filter(candidate =>
    settings.codec === "auto" || candidate.codec === settings.codec);
  const failures: string[] = [];
  for (const candidate of candidates) {
    // Derive the codec level from custom rate control rather than the old fixed bitrate.
    const config = makeEncodingConfig(settings, candidate.codec,
      estimateVideoBitrate(candidate.codec, width, height),
      settings.rateControl === "auto" ? candidate.fullCodecString : undefined);
    try {
      if (await canEncodeVideo(candidate.codec, { width, height, ...config })) {
        return { ...config, codecLabel: candidate.codec.toUpperCase() + (config.fullCodecString ? " (" + config.fullCodecString + ")" : "") };
      }
      failures.push(candidate.codec.toUpperCase());
    } catch (error) {
      failures.push(candidate.codec.toUpperCase() + ": " + getErrorMessage(error));
    }
  }
  throw new Error(t(
    "指定したエンコード設定はこの環境で利用できません。コーデック・品質方式・詳細設定を変更してください",
    "The requested encoding settings are unsupported. Change the codec, rate control or advanced settings",
  ) + " (" + failures.join("; ") + ")");
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
  codec: ExportVideoCodec,
  width: number,
  height: number,
) {
  const codecEfficiencyFactors: Record<ExportVideoCodec, number> = {
    avc: 1,
    hevc: 0.6,
    av1: 0.4,
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

function required2dContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(
      t(
        "2D canvas contextを取得できません",
        "Could not obtain a 2D canvas context",
      ),
    );
  }
  return context;
}

function roundUpToEven(value: number) {
  return value % 2 === 0 ? value : value + 1;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new ExportCanceledError();
}
