import { DEFAULT_ENCODING_SETTINGS, type EncodingSettings } from "./encoding-settings";
import { t } from "./i18n";

export function EncodingSettingsPanel({ value: s, onChange, disabled, error }: {
  value: EncodingSettings; onChange: (value: EncodingSettings) => void; disabled: boolean; error: string | null;
}) {
  const set = <K extends keyof EncodingSettings>(key: K, value: EncodingSettings[K]) => onChange({ ...s, [key]: value });
  const select = (key: keyof EncodingSettings, label: string, choices: [string, string][]) => (
    <label>{label}<select aria-label={label} value={String(s[key])} onChange={e => set(key, e.target.value as never)}>
      {choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select></label>
  );
  const number = (key: keyof EncodingSettings, label: string, min?: number, max?: number, step: number | "any" = "any") => (
    <label>{label}<input aria-label={label} type="number" value={Number.isFinite(s[key]) ? Number(s[key]) : ""}
      min={min} max={max} step={step} onChange={e => set(key, e.target.valueAsNumber as never)} /></label>
  );
  const text = (key: "fullCodecString" | "scalabilityMode", label: string, placeholder: string) => (
    <label>{label}<input aria-label={label} value={s[key]} placeholder={placeholder} onChange={e => set(key, e.target.value)} /></label>
  );
  const check = (key: "preferBitrate" | "quantizerFallback", label: string) => (
    <label className="encoding-check"><input type="checkbox" checked={s[key]} onChange={e => set(key, e.target.checked)} />{label}</label>
  );
  return <details className="encoding-settings">
    <summary>{t("エンコード品質・詳細設定", "Encoding quality & advanced settings")}</summary>
    <fieldset disabled={disabled}>
      <div className="encoding-grid">
        {select("codec", t("動画コーデック", "Video codec"), [["auto", t("自動 (AV1 → HEVC → AVC)", "Auto (AV1 → HEVC → AVC)")], ["av1", "AV1"], ["hevc", "HEVC / H.265"], ["avc", "AVC / H.264"]])}
        {select("rateControl", t("品質方式", "Rate control"), [["auto", t("従来の自動ビットレート", "Original automatic bitrate")], ["quality", t("品質指定", "Quality level")], ["bitrate", t("ビットレート指定", "Explicit bitrate")], ["quantizer", t("量子化数指定", "Explicit quantizer")]])}
        {s.rateControl === "quality" && <>
          <label>{t("品質プリセット", "Quality preset")}<select aria-label="Quality preset" value={[0, .25, .5, .75, 1].includes(s.quality) ? s.quality : "custom"} onChange={e => { if (e.target.value !== "custom") set("quality", Number(e.target.value)); }}>
            {[t("最低", "Very low"), t("低", "Low"), t("標準", "Medium"), t("高", "High"), t("最高", "Very high")].map((label, i) => <option key={i} value={i / 4}>{label}</option>)}
            <option value="custom">{t("カスタム", "Custom")}</option>
          </select></label>
          {number("quality", t("品質値（通常0〜1・大きいほど高品質）", "Quality value (normally 0–1; higher is better)"))}
          {check("preferBitrate", t("品質値を常にビットレートに変換", "Always map quality to bitrate"))}
        </>}
        {s.rateControl === "quantizer" && <>
          {number("quantizer", t("量子化数（小さいほど高品質）", "Quantizer (lower is better)"), 0, s.codec === "av1" ? 255 : 51, 1)}
          {check("quantizerFallback", t("非対応時に指定ビットレートへ切り替え", "Allow bitrate fallback when quantizer is unsupported"))}
        </>}
        {(s.rateControl === "bitrate" || (s.rateControl === "quantizer" && s.quantizerFallback)) && number("bitrateMbps", t("ビットレート (Mbps)", "Bitrate (Mbps)"), 0.000001)}
        {(s.rateControl !== "quantizer" || s.quantizerFallback) && select("bitrateMode", t("ビットレート制御", "Bitrate mode"), [["variable", "VBR"], ["constant", "CBR"]])}
      </div>
      <details>
        <summary>{t("エンコーダー詳細", "Encoder details")}</summary>
        <div className="encoding-grid">
          {number("keyFrameInterval", t("キーフレーム間隔（秒・0で全フレーム）", "Key frame interval (seconds; 0 = every frame)"), 0)}
          {select("latencyMode", t("品質と速度の優先度", "Quality / speed priority"), [["quality", t("品質優先", "Quality")], ["realtime", t("低遅延（フレーム欠落の可能性）", "Realtime (may drop frames)")]])}
          {select("hardwareAcceleration", t("エンコーダー優先設定", "Encoder preference"), [["no-preference", t("指定なし", "No preference")], ["prefer-hardware", t("ハードウェア優先", "Prefer hardware")], ["prefer-software", t("ソフトウェア優先", "Prefer software")]])}
          {select("contentHint", t("映像の種類", "Content hint"), [["", t("指定なし", "Unspecified")], ["motion", t("動き", "Motion")], ["detail", t("細部", "Detail")], ["text", t("文字", "Text")]])}
          {text("scalabilityMode", t("スケーラビリティモード", "Scalability mode"), "L1T1 / L1T2 / L1T3")}
          {text("fullCodecString", t("詳細コーデック文字列（プロファイル・レベル・ビット深度）", "Full codec string (profile, level, bit depth)"), t("空欄で自動", "Blank = automatic"))}
          {select("alpha", t("アルファチャンネル", "Alpha channel"), [["discard", t("破棄", "Discard")], ["keep", t("保持（対応エンコーダーのみ）", "Keep (supported encoders only)")]])}
        </div>
        <p>{t("数値のエンコードeffortはWebCodecs / Mediabunnyでは指定できません。優先設定はブラウザへのヒントです。詳細コーデック文字列は選択したコーデックと一致させてください。", "WebCodecs / Mediabunny do not expose numeric encoding effort. Preferences are browser hints. The full codec string must match the selected codec.")}</p>
      </details>
      <p>{t("MP4で出力します。音声は再エンコードせずコピーします。品質指定では利用可能な量子化方式／ビットレートが自動選択されます。指定条件が非対応の場合はエラーになります。", "Output is MP4. Audio is copied without re-encoding. Quality levels automatically choose available quantizer or bitrate control. Unsupported settings produce an error.")}</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => onChange({ ...DEFAULT_ENCODING_SETTINGS })}>{t("エンコード設定をリセット", "Reset encoding settings")}</button>
    </fieldset>
  </details>;
}
