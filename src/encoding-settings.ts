import { Quality, type VideoEncodingConfig } from "mediabunny";
import { t } from "./i18n";

export interface EncodingSettings {
  codec: "auto" | "av1" | "hevc" | "avc";
  rateControl: "auto" | "quality" | "bitrate" | "quantizer";
  quality: number;
  preferBitrate: boolean;
  bitrateMbps: number;
  bitrateMode: "variable" | "constant";
  quantizer: number;
  quantizerFallback: boolean;
  keyFrameInterval: number;
  latencyMode: "quality" | "realtime";
  hardwareAcceleration: "no-preference" | "prefer-hardware" | "prefer-software";
  fullCodecString: string;
  scalabilityMode: string;
  contentHint: string;
  alpha: "discard" | "keep";
}

export const DEFAULT_ENCODING_SETTINGS: EncodingSettings = {
  codec: "auto", rateControl: "auto", quality: 0.75, preferBitrate: false,
  bitrateMbps: 12, bitrateMode: "variable", quantizer: 24, quantizerFallback: false,
  keyFrameInterval: 2, latencyMode: "quality", hardwareAcceleration: "prefer-hardware",
  fullCodecString: "", scalabilityMode: "", contentHint: "", alpha: "discard",
};

export function validateEncodingSettings(s: EncodingSettings): string | null {
  const invalid = (ja: string, en: string) => t(ja, en);
  if (!Number.isFinite(s.keyFrameInterval) || s.keyFrameInterval < 0)
    return invalid("キーフレーム間隔は0以上にしてください", "Key frame interval must be zero or greater");
  if (s.rateControl === "quality" && !Number.isFinite(s.quality))
    return invalid("品質値を入力してください", "Enter a finite quality value");
  if ((s.rateControl === "bitrate" || (s.rateControl === "quantizer" && s.quantizerFallback)) &&
      (!Number.isFinite(s.bitrateMbps) || s.bitrateMbps <= 0 || !Number.isSafeInteger(Math.round(s.bitrateMbps * 1e6))))
    return invalid("ビットレートは0より大きい有効な値にしてください", "Bitrate must be a valid value greater than zero");
  if (s.rateControl === "quantizer") {
    if (s.codec === "auto") return invalid("量子化数を指定する場合はコーデックを選んでください", "Select a codec for explicit quantizer control");
    const max = s.codec === "av1" ? 255 : 51;
    if (!Number.isInteger(s.quantizer) || s.quantizer < 0 || s.quantizer > max)
      return invalid(`量子化数は0〜${max}の整数にしてください`, `Quantizer must be an integer from 0 to ${max}`);
  }
  if (s.fullCodecString.trim()) {
    const prefix = { av1: /^av01\./, hevc: /^(hvc1|hev1)\./, avc: /^(avc1|avc3)\./ };
    if (s.codec === "auto" || !prefix[s.codec].test(s.fullCodecString.trim()))
      return invalid("詳細コーデック文字列に一致するコーデックを選んでください", "Select the codec matching the full codec string");
  }
  return null;
}

export function makeEncodingConfig(s: EncodingSettings, codec: "av1" | "hevc" | "avc", automaticBitrate: number, automaticCodecString?: string): VideoEncodingConfig {
  const error = validateEncodingSettings(s);
  if (error) throw new Error(error);
  const bitrate = Math.round(s.bitrateMbps * 1e6);
  const quality = s.rateControl === "quality"
    ? new Quality({ quality: s.quality, preferBitrate: s.preferBitrate, bitrateMode: s.bitrateMode })
    : s.rateControl === "quantizer"
      ? new Quality({ quantizer: s.quantizer, ...(s.quantizerFallback ? { bitrate } : {}), bitrateMode: s.bitrateMode })
      : new Quality({ bitrate: s.rateControl === "bitrate" ? bitrate : automaticBitrate, bitrateMode: s.bitrateMode });
  return {
    codec, quality, keyFrameInterval: s.keyFrameInterval,
    latencyMode: s.latencyMode, hardwareAcceleration: s.hardwareAcceleration,
    fullCodecString: s.fullCodecString.trim() || automaticCodecString,
    scalabilityMode: s.scalabilityMode.trim() || undefined,
    contentHint: s.contentHint || undefined, alpha: s.alpha,
  };
}
