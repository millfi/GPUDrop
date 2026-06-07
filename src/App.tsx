import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  ExportCanceledError,
  exportOverlayVideo,
  type ExportProgress,
} from "./exporter";
import { Player, type Stats, type DupEvent, type StatsEvent } from "./player";
import type { RectMask } from "./analyzer";

const HISTORY_CAP = 600;
const EVENTS_CAP = 100;
const FPS_AXIS_LIMITS = { min: 0, max: 240 };
const FT_AXIS_LIMITS = { min: 0, max: 200 };
const ACCEPTED_MEDIA_TYPES = [
  "video/*",
  ".mp4",
  ".m4v",
  ".mov",
  ".qt",
  ".mkv",
  ".webm",
  ".ogv",
  ".ts",
  ".m2ts",
  ".mts",
  ".m3u8",
].join(",");

interface AxisRange {
  min: number;
  max: number;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(0.05);
  const [frameThreshold, setFrameThreshold] = useState(0.0006);
  const [mask, setMask] = useState<RectMask | null>(null);
  const [maskEditing, setMaskEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [seekValue, setSeekValue] = useState(0);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [exportMessage, setExportMessage] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<DupEvent[]>([]);
  const [fpsRange, setFpsRange] = useState<AxisRange>({ min: 0, max: 144 });
  const [ftRange, setFtRange] = useState<AxisRange>({ min: 0, max: 100 });

  const videoCanvas = useRef<HTMLCanvasElement>(null);
  const videoPanelRef = useRef<HTMLDivElement>(null);
  const diffCanvas = useRef<HTMLCanvasElement>(null);
  const fpsCanvas = useRef<HTMLCanvasElement>(null);
  const ftCanvas = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<Player | null>(null);
  const historyRef = useRef<{ fps: number; ft: number }[]>([]);
  const historyIndexRef = useRef(-1);
  const fpsRangeRef = useRef(fpsRange);
  const ftRangeRef = useRef(ftRange);
  const seekRequestIdRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const maskStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    playerRef.current?.setThreshold(threshold);
  }, [threshold]);

  useEffect(() => {
    playerRef.current?.setFrameThreshold(frameThreshold);
  }, [frameThreshold]);

  useEffect(() => {
    playerRef.current?.setMask(mask);
  }, [mask]);

  useEffect(() => {
    return () => {
      exportAbortRef.current?.abort();
      playerRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    fpsRangeRef.current = normalizeAxisRange(fpsRange, FPS_AXIS_LIMITS);
    ftRangeRef.current = normalizeAxisRange(ftRange, FT_AXIS_LIMITS);
    drawHistoryCharts();
  }, [fpsRange, ftRange]);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const videoPanel = videoPanelRef.current;
      if (!videoPanel) return;
      setOverlayVisible(videoPanel.contains(e.target as Node));
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  const unload = (options: { resetFileInput?: boolean } = {}) => {
    const { resetFileInput = true } = options;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    seekRequestIdRef.current++;
    playerRef.current?.stop();
    playerRef.current = null;
    historyRef.current = [];
    historyIndexRef.current = -1;
    setFile(null);
    setStats(null);
    setEvents([]);
    setDuration(0);
    setSeekValue(0);
    setSeeking(false);
    setRunning(false);
    setPaused(false);
    setExporting(false);
    setExportProgress(null);
    setExportMessage("");
    // Reset the file input so re-selecting the same file fires onChange.
    if (resetFileInput && fileInputRef.current) fileInputRef.current.value = "";
    clearCanvas(videoCanvas.current);
    clearCanvas(diffCanvas.current);
    drawHistoryCharts();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const nextFile = e.target.files?.[0] ?? null;
    if (!nextFile) {
      unload();
      return;
    }
    if (file || running || playerRef.current) {
      unload({ resetFileInput: false });
    }
    setFile(nextFile);
  };

  const start = async () => {
    if (!file || exporting) return;
    playerRef.current?.stop();
    historyRef.current = [];
    historyIndexRef.current = -1;
    setEvents([]);
    setStats(null);
    setDuration(0);
    setSeekValue(0);
    seekRequestIdRef.current++;
    setSeeking(false);
    drawHistoryCharts();

    const player = new Player({
      file,
      videoCanvas: videoCanvas.current!,
      diffCanvas: diffCanvas.current!,
      threshold,
      frameThreshold,
      mask,
      onStats: updateStats,
      onDuplicate: recordDuplicateEvent,
      onEnd: () => {
        seekRequestIdRef.current++;
        setSeeking(false);
      },
      onReady: ({ timestamp, duration }) => {
        setDuration(duration);
        setSeekValue(timestamp);
      },
      onPausedChange: setPaused,
    });
    playerRef.current = player;
    setRunning(true);
    setPaused(false);
    try {
      await player.start();
    } catch (e) {
      console.error(e);
      alert((e as Error).message);
      setRunning(false);
      setPaused(false);
    }
  };

  const togglePlayback = () => {
    if (!playerRef.current || exporting) return;
    if (!running) {
      playerRef.current.resume();
      setRunning(true);
    } else if (paused) {
      playerRef.current.resume();
    } else {
      playerRef.current.pause();
    }
  };

  const stepBackward = () => {
    if (exporting) return;
    void playerRef.current?.stepBackward().catch(console.error);
  };

  const stepForward = () => {
    if (exporting) return;
    void playerRef.current?.stepForward().catch(console.error);
  };

  const seek = (value: number) => {
    if (exporting) return;
    startSeek(value, { clearEvents: true });
  };

  const seekToDuplicateEvent = (timestamp: number) => {
    if (exporting) return;
    startSeek(timestamp);
  };

  const startSeek = (
    timestamp: number,
    options: { clearEvents?: boolean } = {},
  ) => {
    setSeekValue(timestamp);
    resetAnalysisHistory();
    if (options.clearEvents) setEvents([]);

    const player = playerRef.current;
    if (!player) return;

    const requestId = ++seekRequestIdRef.current;
    setSeeking(true);
    void player
      .seek(timestamp)
      .catch(console.error)
      .finally(() => {
        if (seekRequestIdRef.current === requestId) setSeeking(false);
      });
  };

  const startExport = async () => {
    if (!file || exporting || running) return;

    playerRef.current?.stop();
    playerRef.current = null;
    historyRef.current = [];
    historyIndexRef.current = -1;
    setEvents([]);
    setStats(null);
    setDuration(0);
    setSeekValue(0);
    setSeeking(false);
    setRunning(false);
    setPaused(false);
    setExportMessage("");
    drawHistoryCharts();

    const abortController = new AbortController();
    exportAbortRef.current = abortController;
    setExporting(true);
    setExportProgress(null);
    let lastExportProgress: ExportProgress | null = null;

    try {
      await exportOverlayVideo({
        file,
        videoCanvas: videoCanvas.current!,
        diffCanvas: diffCanvas.current!,
        threshold,
        frameThreshold,
        mask,
        fpsRange: fpsRangeRef.current,
        ftRange: ftRangeRef.current,
        signal: abortController.signal,
        onStats: updateStats,
        onDuplicate: recordDuplicateEvent,
        onProgress: (progress) => {
          lastExportProgress = progress;
          setExportProgress(progress);
        },
      });
      setExportMessage(
        `書き出し完了${lastExportProgress?.codecLabel ? ` (${lastExportProgress.codecLabel})` : ""}`,
      );
    } catch (e) {
      if (e instanceof ExportCanceledError || isAbortError(e)) {
        setExportMessage("書き出し中断");
      } else {
        console.error(e);
        alert((e as Error).message);
      }
    } finally {
      if (exportAbortRef.current === abortController) {
        exportAbortRef.current = null;
      }
      setExporting(false);
    }
  };

  const cancelExport = () => {
    exportAbortRef.current?.abort();
  };

  const startMaskSelection = () => {
    setMaskEditing(true);
    setOverlayVisible(false);
  };

  const handleMaskPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!maskEditing || e.button !== 0) return;
    const point = getNormalizedPointer(e);
    maskStartRef.current = point;
    e.currentTarget.setPointerCapture(e.pointerId);
    setMask({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const handleMaskPointerMove = (
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    const start = maskStartRef.current;
    if (!maskEditing || !start) return;
    setMask(rectFromPoints(start, getNormalizedPointer(e)));
  };

  const finishMaskSelection = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = maskStartRef.current;
    if (!start) return;
    const next = rectFromPoints(start, getNormalizedPointer(e));
    maskStartRef.current = null;
    setMask(
      next.width >= 0.002 && next.height >= 0.002 ? next : null,
    );
    setMaskEditing(false);
  };

  const recordDuplicateEvent = (e: DupEvent) => {
    setEvents((prev) => {
      const next = [e, ...prev];
      if (next.length > EVENTS_CAP) next.length = EVENTS_CAP;
      return next;
    });
  };

  const updateStats = (s: Stats, e?: StatsEvent) => {
    setStats(s);
    setSeekValue(s.timestamp);
    const h = historyRef.current;
    if (e?.resetHistory) {
      h.length = 0;
      historyIndexRef.current = -1;
    }
    if (e?.historyDelta) {
      historyIndexRef.current = clamp(
        historyIndexRef.current + e.historyDelta,
        0,
        h.length - 1,
      );
    } else {
      h.push({ fps: s.fps, ft: s.frameTime * 1000 });
      historyIndexRef.current = h.length - 1;
    }
    drawHistoryCharts();
  };

  const resetAnalysisHistory = () => {
    historyRef.current = [];
    historyIndexRef.current = -1;
    setStats(null);
    drawHistoryCharts();
  };

  function drawHistoryCharts() {
    const end = historyIndexRef.current + 1;
    const start = Math.max(0, end - HISTORY_CAP);
    const visibleHistory = historyRef.current.slice(start, end);
    drawChart(
      fpsCanvas.current,
      visibleHistory.map((x) => x.fps),
      fpsRangeRef.current,
      "#159447",
    );
    drawChart(
      ftCanvas.current,
      visibleHistory.map((x) => x.ft),
      ftRangeRef.current,
      "#0b8fb8",
    );
  }

  return (
    <div>
      <GlassFilterDefs />
      <h1>FPS推定</h1>
      <div className="controls">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MEDIA_TYPES}
          disabled={exporting}
          onChange={handleFileChange}
        />
        <label>
          ピクセル閾値: {threshold.toFixed(3)}
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.001}
            value={threshold}
            disabled={exporting}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
          />
        </label>
        <button
          type="button"
          onClick={startMaskSelection}
          disabled={!stats || exporting || maskEditing}
        >
          {mask ? "マスクを再選択" : "マスク範囲を選択"}
        </button>
        {mask && (
          <button
            type="button"
            onClick={() => setMask(null)}
            disabled={!stats || exporting}
          >
            マスク解除
          </button>
        )}
        {maskEditing && <span>映像上をドラッグしてください</span>}
        <label>
          フレーム閾値: {(frameThreshold * 100).toFixed(3)}%
          <input
            type="range"
            min={0}
            max={0.1}
            step={0.0001}
            value={frameThreshold}
            disabled={exporting}
            onChange={(e) => setFrameThreshold(parseFloat(e.target.value))}
          />
        </label>
        <button onClick={start} disabled={!file || running || exporting}>
          開始
        </button>
        <button onClick={startExport} disabled={!file || running || exporting}>
          Export
        </button>
        {exporting && <button onClick={cancelExport}>中断</button>}
        {running && <span>{paused ? "一時停止中" : "再生中…"}</span>}
        {exporting && <span>書き出し中…</span>}
      </div>

      <div className="stats">
        {stats
          ? `t=${stats.timestamp.toFixed(3)}s  frame#${stats.frameNumber}  fps=${stats.fps}  frameTime=${(stats.frameTime * 1000).toFixed(2)}ms`
          : "—"}
      </div>
      <div className="stats">
        {stats
          ? `現在値: fps=${stats.fps}  frameTime=${(stats.frameTime * 1000).toFixed(2)}ms`
          : "現在値: —"}
      </div>
      {(exporting || exportMessage) && (
        <div className="stats">
          {exporting && exportProgress
            ? `export ${Math.round(exportProgress.progress * 100)}%  ${formatTime(exportProgress.timestamp)} / ${formatTime(exportProgress.duration)}  ${exportProgress.codecLabel}`
            : exportMessage}
        </div>
      )}

      <div className="grid">
        <div className="media-column">
          <div>映像</div>
          <div ref={videoPanelRef} className="video-panel">
            <canvas ref={videoCanvas} />
            <div
              className={`mask-layer${maskEditing ? " is-editing" : ""}`}
              onPointerDown={handleMaskPointerDown}
              onPointerMove={handleMaskPointerMove}
              onPointerUp={finishMaskSelection}
              onPointerCancel={finishMaskSelection}
              aria-label="差分判定から除外する領域"
            >
              {mask && (
                <div
                  className="mask-rectangle"
                  style={{
                    left: `${mask.x * 100}%`,
                    top: `${mask.y * 100}%`,
                    width: `${mask.width * 100}%`,
                    height: `${mask.height * 100}%`,
                  }}
                />
              )}
            </div>
            {seeking && (
              <div className="seek-loading" role="status" aria-label="シーク中">
                <LoadingIcon />
              </div>
            )}
            <div
              className={`video-overlay${overlayVisible ? "" : " is-hidden"}`}
            >
              <div className="player-controls">
                <button
                  type="button"
                  className="icon-button"
                  onClick={stepBackward}
                  disabled={exporting}
                  title="1フレーム戻る"
                  aria-label="1フレーム戻る"
                >
                  <StepBackIcon />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={togglePlayback}
                  disabled={exporting}
                  title={paused ? "再生" : "一時停止"}
                  aria-label={paused ? "再生" : "一時停止"}
                >
                  {paused ? <PlayIcon /> : <PauseIcon />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={stepForward}
                  disabled={exporting}
                  title="1フレーム進む"
                  aria-label="1フレーム進む"
                >
                  <StepForwardIcon />
                </button>
              </div>
              <label className="seek-control">
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.001}
                  value={Math.min(seekValue, duration || 0)}
                  disabled={exporting || duration <= 0}
                  onChange={(e) => seek(parseFloat(e.target.value))}
                  aria-label="シーク"
                />
                <span>
                  {formatTime(seekValue)} / {formatTime(duration)}
                </span>
              </label>
            </div>
          </div>
          <div className="panel-block">
            <div>差分</div>
            <canvas ref={diffCanvas} />
          </div>
        </div>

        <div className="charts-column">
          <div className="chart-panel">
            <div className="chart-title">
              FPS ({fpsRange.min}–{fpsRange.max})
            </div>
            <canvas
              ref={fpsCanvas}
              className="chart-canvas"
              width={600}
              height={150}
            />
            <AxisRangeControl
              title="FPS 縦軸レンジ"
              description="このグラフの左軸に表示する値の範囲"
              value={fpsRange}
              limits={FPS_AXIS_LIMITS}
              step={1}
              onChange={setFpsRange}
            />
          </div>
          <div className="chart-panel">
            <div className="chart-title">
              フレームタイム (ms, {ftRange.min}–{ftRange.max})
            </div>
            <canvas
              ref={ftCanvas}
              className="chart-canvas"
              width={600}
              height={150}
            />
            <AxisRangeControl
              title="フレームタイム 縦軸レンジ"
              description="このグラフの左軸に表示する値の範囲"
              value={ftRange}
              limits={FT_AXIS_LIMITS}
              step={1}
              onChange={setFtRange}
            />
          </div>
        </div>

        <div className="events-column">
          <div>同一フレーム検知 ({events.length}件)</div>
          <div className="events">
            {events.map((e, i) => (
              <button
                key={`${e.frameNumber}-${e.timestamp}-${i}`}
                type="button"
                className="event-link"
                disabled={exporting}
                onClick={() => seekToDuplicateEvent(e.timestamp)}
                title={`${e.timestamp.toFixed(3)}s にシーク`}
              >
                t = {e.timestamp.toFixed(3)}s · frame #{e.frameNumber}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GlassFilterDefs() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute" }}
    >
      <filter
        id="gpudrop-glass-distortion"
        x="0%"
        y="0%"
        width="100%"
        height="100%"
        filterUnits="objectBoundingBox"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.001 0.005"
          numOctaves="1"
          seed="17"
          result="turbulence"
        />
        <feComponentTransfer in="turbulence" result="mapped">
          <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
          <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
          <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
        </feComponentTransfer>
        <feGaussianBlur in="turbulence" stdDeviation="1" result="softMap" />
        <feSpecularLighting
          in="softMap"
          surfaceScale="5"
          specularConstant="1"
          specularExponent="100"
          lightingColor="#fff"
          result="specLight"
        >
          <fePointLight x="-200" y="-200" z="300" />
        </feSpecularLighting>
        <feComposite
          in="specLight"
          operator="arithmetic"
          k1="0"
          k2="1"
          k3="1"
          k4="0"
          result="litImage"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="softMap"
          scale="44"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

function AxisRangeControl({
  title,
  description,
  value,
  limits,
  step,
  onChange,
}: {
  title: string;
  description: string;
  value: AxisRange;
  limits: AxisRange;
  step: number;
  onChange: (range: AxisRange) => void;
}) {
  const normalized = normalizeAxisRange(value);
  const applyRange = (next: AxisRange) => {
    onChange(normalizeAxisRange(next, limits, step));
  };

  return (
    <div className="axis-range-control">
      <div className="axis-range-copy">
        <div className="axis-range-title">{title}</div>
        <div className="axis-range-description">{description}</div>
      </div>
      <div className="axis-range-fields">
        <input
          className="axis-range-slider"
          type="range"
          min={limits.min}
          max={limits.max}
          step={step}
          value={normalized.max}
          onChange={(e) =>
            applyRange({ ...normalized, max: parseFloat(e.target.value) })
          }
          aria-label={`${title} 最大値`}
        />
        <div className="axis-range-inputs">
          <input
            className="axis-number"
            type="number"
            min={limits.min}
            max={limits.max}
            step={step}
            value={normalized.min}
            onChange={(e) =>
              applyRange({ ...normalized, min: parseFloat(e.target.value) })
            }
            aria-label={`${title} 最小値`}
          />
          <input
            className="axis-number"
            type="number"
            min={limits.min}
            max={limits.max}
            step={step}
            value={normalized.max}
            onChange={(e) =>
              applyRange({ ...normalized, max: parseFloat(e.target.value) })
            }
            aria-label={`${title} 最大値`}
          />
        </div>
      </div>
    </div>
  );
}

function LoadingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="34 18"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

function StepBackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h2v14H6zM18 6v12l-9-6z" fill="currentColor" />
    </svg>
  );
}

function StepForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 5h2v14h-2zM6 6l9 6-9 6z" fill="currentColor" />
    </svg>
  );
}

function clearCanvas(c: HTMLCanvasElement | null) {
  if (!c) return;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, c.width, c.height);
  } else {
    // WebGPU-bound canvas (the diff canvas): assigning width clears it
    // regardless of which context type was bound.
    // eslint-disable-next-line no-self-assign
    c.width = c.width;
  }
}

function clamp(v: number, min: number, max: number) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, v));
}

function getNormalizedPointer(e: React.PointerEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  return {
    x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
  };
}

function rectFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): RectMask {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function normalizeAxisRange(range: AxisRange, limits?: AxisRange, minSpan = 1) {
  const lowerLimit = limits?.min ?? Number.NEGATIVE_INFINITY;
  const upperLimit = limits?.max ?? Number.POSITIVE_INFINITY;
  const rawMin = Number.isFinite(range.min) ? range.min : (limits?.min ?? 0);
  const rawMax = Number.isFinite(range.max)
    ? range.max
    : (limits?.max ?? rawMin + minSpan);
  let min = clamp(rawMin, lowerLimit, upperLimit);
  let max = clamp(rawMax, lowerLimit, upperLimit);

  if (max < min) {
    [min, max] = [max, min];
  }

  if (max - min < minSpan) {
    min = clamp(min, lowerLimit, upperLimit - minSpan);
    max = min + minSpan;
  }

  return { min, max };
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function drawChart(
  canvas: HTMLCanvasElement | null,
  data: number[],
  axisRange: AxisRange,
  color: string,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const { min, max } = normalizeAxisRange(axisRange);
  const plotLeft = 44;
  const plotRight = w - 8;
  const plotTop = 8;
  const plotBottom = h - 20;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#d8dee6";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#4b5563";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = plotBottom - ratio * plotHeight;
    const label = formatAxisTick(min + (max - min) * ratio);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(label, plotLeft - 6, y);
  }

  ctx.strokeStyle = "#9aa4b2";
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(min, Math.min(max, data[i]));
    const x = plotLeft + (i / (HISTORY_CAP - 1)) * plotWidth;
    const y = plotBottom - ((v - min) / (max - min)) * plotHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function formatAxisTick(value: number) {
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}
