import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  ExportCanceledError,
  exportOverlayVideo,
  type ExportProgress,
} from "./exporter";
import { Player, type Stats, type DupEvent, type StatsEvent } from "./player";
import type { RectMask } from "./analyzer";
import { t } from "./i18n";
import {
  FPS_COLOR,
  FT_COLOR,
  OVERLAY_ELEMENT_KINDS,
  SCREEN_CHART_THEME,
  applyOverlayDrag,
  createDefaultOverlayLayout,
  drawOverlay,
  getOverlayElementRect,
  loadOverlayLayout,
  renderChart,
  saveOverlayLayout,
  type AxisRange,
  type NormalizedRect,
  type OverlayElementKind,
  type OverlayHistoryPoint,
  type OverlayLayout,
} from "./overlay";

const EVENTS_CAP = 100;
const FPS_AXIS_LIMITS = { min: 0, max: 240 };
const FT_AXIS_LIMITS = { min: 0, max: 200 };
const HISTORY_AXIS_LIMITS = { min: 10, max: 1200 };
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

const OVERLAY_ELEMENT_LABELS: Record<OverlayElementKind, string> = {
  fpsValue: t("FPS 数値", "FPS Value"),
  fpsChart: t("FPS グラフ", "FPS Graph"),
  ftChart: t("フレームタイム グラフ", "Frame Time Graph"),
};

interface OverlayDragState {
  kind: OverlayElementKind;
  mode: "move" | "resize";
  startPoint: { x: number; y: number };
  startRect: NormalizedRect;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(0.05);
  const [frameThreshold, setFrameThreshold] = useState(0.0006);
  const [mask, setMask] = useState<RectMask | null>(null);
  const [maskEditing, setMaskEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [seekValue, setSeekValue] = useState(0);
  const [playerControlsVisible, setPlayerControlsVisible] = useState(true);
  const [previewOverlayVisible, setPreviewOverlayVisible] = useState(false);
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [selectedOverlayKind, setSelectedOverlayKind] =
    useState<OverlayElementKind>("fpsValue");
  const [overlayLayout, setOverlayLayout] = useState<OverlayLayout>(() =>
    loadOverlayLayout(),
  );
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
  const [historyRange, setHistoryRange] = useState<AxisRange>({ min: 10, max: 600 });

  const videoCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const overlayEditorRef = useRef<HTMLDivElement>(null);
  const videoPanelRef = useRef<HTMLDivElement>(null);
  const diffCanvas = useRef<HTMLCanvasElement>(null);
  const fpsCanvas = useRef<HTMLCanvasElement>(null);
  const ftCanvas = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<Player | null>(null);
  const historyRef = useRef<OverlayHistoryPoint[]>([]);
  const historyIndexRef = useRef(-1);
  const statsRef = useRef<Stats | null>(null);
  const fpsRangeRef = useRef(fpsRange);
  const ftRangeRef = useRef(ftRange);
  const historyRangeRef = useRef(historyRange);
  const overlayLayoutRef = useRef(overlayLayout);
  const previewOverlayVisibleRef = useRef(previewOverlayVisible);
  const layoutEditingRef = useRef(layoutEditing);
  const seekRequestIdRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const maskStartRef = useRef<{ x: number; y: number } | null>(null);
  const overlayDragRef = useRef<OverlayDragState | null>(null);

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
    drawPreviewOverlay();
  }, [fpsRange, ftRange]);

  useEffect(() => {
    historyRangeRef.current = normalizeAxisRange(historyRange, HISTORY_AXIS_LIMITS);
    drawHistoryCharts();
    drawPreviewOverlay();
  }, [historyRange]);

  useEffect(() => {
    overlayLayoutRef.current = overlayLayout;
    saveOverlayLayout(overlayLayout);
    drawPreviewOverlay();
  }, [overlayLayout]);

  useEffect(() => {
    previewOverlayVisibleRef.current = previewOverlayVisible;
    drawPreviewOverlay();
  }, [previewOverlayVisible]);

  useEffect(() => {
    layoutEditingRef.current = layoutEditing;
    if (!layoutEditing) overlayDragRef.current = null;
    drawPreviewOverlay();
  }, [layoutEditing]);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const videoPanel = videoPanelRef.current;
      if (!videoPanel) return;
      setPlayerControlsVisible(videoPanel.contains(e.target as Node));
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
    const previousPlayer = playerRef.current;
    playerRef.current = null;
    previousPlayer?.stop();
    historyRef.current = [];
    historyIndexRef.current = -1;
    statsRef.current = null;
    setFile(null);
    setStats(null);
    setEvents([]);
    setDuration(0);
    setSeekValue(0);
    setSeeking(false);
    setRunning(false);
    setLoading(false);
    setPaused(false);
    setExporting(false);
    setExportProgress(null);
    setExportMessage("");
    setMaskEditing(false);
    setLayoutEditing(false);
    // Reset the file input so re-selecting the same file fires onChange.
    if (resetFileInput && fileInputRef.current) fileInputRef.current.value = "";
    clearCanvas(videoCanvas.current);
    clearCanvas(overlayCanvas.current);
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
    setMask(null);
    loadVideo(nextFile, 0, null);
  };

  const loadVideo = (sourceFile: File, position = 0, sourceMask = mask) => {
    const previousPlayer = playerRef.current;
    playerRef.current = null;
    previousPlayer?.stop();
    historyRef.current = [];
    historyIndexRef.current = -1;
    statsRef.current = null;
    setEvents([]);
    setStats(null);
    setDuration(0);
    setSeekValue(0);
    seekRequestIdRef.current++;
    setSeeking(false);
    setLoading(true);
    setMaskEditing(false);
    setLayoutEditing(false);
    drawHistoryCharts();

    const player = new Player({
      file: sourceFile,
      videoCanvas: videoCanvas.current!,
      diffCanvas: diffCanvas.current!,
      threshold,
      frameThreshold,
      mask: sourceMask,
      onStats: (nextStats, event) => {
        if (playerRef.current !== player) return;
        updateStats(nextStats, event);
        setLoading(false);
        if (position > 0) {
          const restorePosition = position;
          position = 0;
          startSeek(restorePosition);
        }
      },
      onDuplicate: (event) => {
        if (playerRef.current === player) recordDuplicateEvent(event);
      },
      onEnd: () => {
        if (playerRef.current !== player) return;
        seekRequestIdRef.current++;
        setSeeking(false);
        setRunning(false);
        setLoading(false);
      },
      onReady: ({ timestamp, duration }) => {
        if (playerRef.current !== player) return;
        setDuration(duration);
        setSeekValue(timestamp);
      },
      onPausedChange: (nextPaused) => {
        if (playerRef.current === player) setPaused(nextPaused);
      },
    });
    playerRef.current = player;
    setRunning(true);
    setPaused(true);
    void player.start().catch((e) => {
      if (playerRef.current !== player) return;
      playerRef.current = null;
      console.error(e);
      alert((e as Error).message);
      setRunning(false);
      setLoading(false);
      setPaused(true);
    });
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
    if (!file || loading || seeking || exporting || (running && !paused)) return;

    const restorePosition = statsRef.current?.timestamp ?? 0;
    const previousPlayer = playerRef.current;
    playerRef.current = null;
    previousPlayer?.stop();
    historyRef.current = [];
    historyIndexRef.current = -1;
    statsRef.current = null;
    setEvents([]);
    setStats(null);
    setDuration(0);
    setSeekValue(0);
    setSeeking(false);
    setRunning(false);
    setPaused(false);
    setMaskEditing(false);
    setLayoutEditing(false);
    setExportMessage("");
    drawHistoryCharts();
    clearCanvas(overlayCanvas.current);

    const abortController = new AbortController();
    exportAbortRef.current = abortController;
    setExporting(true);
    setExportProgress(null);
    const progressSummary = { codecLabel: "" };

    try {
      const result = await exportOverlayVideo({
        file,
        videoCanvas: videoCanvas.current!,
        diffCanvas: diffCanvas.current!,
        threshold,
        frameThreshold,
        mask: mask ? { ...mask } : null,
        layout: overlayLayoutRef.current.map((element) => ({
          ...element,
          rect: { ...element.rect },
        })),
        fpsRange: { ...fpsRangeRef.current },
        ftRange: { ...ftRangeRef.current },
        historyMaxPoints: historyRangeRef.current.max,
        signal: abortController.signal,
        onStats: updateStats,
        onDuplicate: recordDuplicateEvent,
        onProgress: (progress) => {
          progressSummary.codecLabel = progress.codecLabel;
          setExportProgress(progress);
        },
      });
      const audioNote = result.audioSkippedReason
        ? t(
            ` — 音声なし: ${result.audioSkippedReason}`,
            ` — No audio: ${result.audioSkippedReason}`,
          )
        : "";
      setExportMessage(
        `${t("書き出し完了", "Export complete")}${
          progressSummary.codecLabel
            ? ` (${progressSummary.codecLabel})`
            : ""
        }${audioNote}`,
      );
    } catch (e) {
      if (e instanceof ExportCanceledError || isAbortError(e)) {
        setExportMessage(t("書き出し中断", "Export canceled"));
      } else {
        console.error(e);
        alert((e as Error).message);
      }
    } finally {
      if (exportAbortRef.current === abortController) {
        exportAbortRef.current = null;
      }
      setExporting(false);
      loadVideo(file, restorePosition);
    }
  };

  const cancelExport = () => {
    exportAbortRef.current?.abort();
  };

  const toggleLayoutEditor = () => {
    const next = !layoutEditing;
    overlayDragRef.current = null;
    if (next) {
      maskStartRef.current = null;
      setMaskEditing(false);
      setPlayerControlsVisible(false);
    }
    setLayoutEditing(next);
  };

  const setOverlayElementVisible = (
    kind: OverlayElementKind,
    visible: boolean,
  ) => {
    setOverlayLayout((current) =>
      current.map((element) =>
        element.kind === kind ? { ...element, visible } : element,
      ),
    );
  };

  const resetOverlayLayout = () => {
    overlayDragRef.current = null;
    setSelectedOverlayKind("fpsValue");
    setOverlayLayout(createDefaultOverlayLayout());
  };

  const beginOverlayDrag = (
    e: React.PointerEvent<HTMLElement>,
    kind: OverlayElementKind,
    mode: "move" | "resize",
  ) => {
    if (!layoutEditing || e.button !== 0) return;
    const editor = overlayEditorRef.current;
    const element = overlayLayoutRef.current.find((item) => item.kind === kind);
    if (!editor || !element) return;

    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedOverlayKind(kind);
    overlayDragRef.current = {
      kind,
      mode,
      startPoint: getNormalizedPointerWithin(e.clientX, e.clientY, editor),
      startRect: { ...element.rect },
    };
  };

  const handleOverlayPointerMove = (
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    const drag = overlayDragRef.current;
    const editor = overlayEditorRef.current;
    if (!drag || !editor) return;

    e.preventDefault();
    const point = getNormalizedPointerWithin(e.clientX, e.clientY, editor);
    const videoWidth = videoCanvas.current?.width ?? editor.clientWidth;
    const videoHeight = videoCanvas.current?.height ?? editor.clientHeight;
    const rect = applyOverlayDrag(
      drag.kind,
      drag.startRect,
      drag.mode,
      point.x - drag.startPoint.x,
      point.y - drag.startPoint.y,
      videoWidth,
      videoHeight,
    );
    setOverlayLayout((current) =>
      current.map((element) =>
        element.kind === drag.kind ? { ...element, rect } : element,
      ),
    );
  };

  const finishOverlayDrag = () => {
    overlayDragRef.current = null;
  };

  const startMaskSelection = () => {
    setLayoutEditing(false);
    setMaskEditing(true);
    setPlayerControlsVisible(false);
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
    statsRef.current = s;
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
    drawPreviewOverlay();
  };

  const resetAnalysisHistory = () => {
    historyRef.current = [];
    historyIndexRef.current = -1;
    statsRef.current = null;
    setStats(null);
    drawHistoryCharts();
    drawPreviewOverlay();
  };

  function drawHistoryCharts() {
    const maxPoints = historyRangeRef.current.max;
    const end = historyIndexRef.current + 1;
    const start = Math.max(0, end - maxPoints);
    const visibleHistory = historyRef.current.slice(start, end);
    drawChart(
      fpsCanvas.current,
      visibleHistory.map((x) => x.fps),
      fpsRangeRef.current,
      FPS_COLOR,
      maxPoints,
    );
    drawChart(
      ftCanvas.current,
      visibleHistory.map((x) => x.ft),
      ftRangeRef.current,
      FT_COLOR,
      maxPoints,
    );
  }

  function drawPreviewOverlay() {
    const canvas = overlayCanvas.current;
    const video = videoCanvas.current;
    if (!canvas || !video) return;

    if (canvas.width !== video.width) canvas.width = video.width;
    if (canvas.height !== video.height) canvas.height = video.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const currentStats = statsRef.current;
    if (
      !currentStats ||
      (!previewOverlayVisibleRef.current && !layoutEditingRef.current)
    ) {
      return;
    }

    drawOverlay(
      ctx,
      canvas.width,
      canvas.height,
      overlayLayoutRef.current,
      {
        history: historyRef.current,
        historyIndex: historyIndexRef.current,
        fps: currentStats.fps,
      },
      {
        fpsRange: fpsRangeRef.current,
        ftRange: ftRangeRef.current,
        maxPoints: historyRangeRef.current.max,
      },
      { ghostHidden: layoutEditingRef.current },
    );
  }

  return (
    <div>
      <GlassFilterDefs />
      <h1>{t("FPS推定", "FPS Estimator")}</h1>
      <div className="controls">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MEDIA_TYPES}
          disabled={exporting}
          onChange={handleFileChange}
        />
        <label>
          {t("ピクセル閾値", "Pixel threshold")}: {threshold.toFixed(3)}
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
          disabled={!stats || loading || exporting || maskEditing}
        >
          {mask
            ? t("マスクを再選択", "Reselect mask")
            : t("マスク範囲を選択", "Select mask area")}
        </button>
        {mask && (
          <button
            type="button"
            onClick={() => setMask(null)}
            disabled={!stats || exporting}
          >
            {t("マスク解除", "Clear mask")}
          </button>
        )}
        {maskEditing && (
          <span>
            {t("映像上をドラッグしてください", "Drag over the video")}
          </span>
        )}
        <label>
          {t("フレーム閾値", "Frame threshold")}: {(
            frameThreshold * 100
          ).toFixed(3)}%
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
        <button onClick={startExport} disabled={!file || loading || seeking || (running && !paused) || exporting}>
          {t("エクスポート", "Export")}
        </button>
        {exporting && (
          <button onClick={cancelExport}>{t("中断", "Cancel")}</button>
        )}
        {running && (
          <span>
            {paused ? t("一時停止中", "Paused") : t("再生中…", "Playing…")}
          </span>
        )}
        {loading && <span role="status">{t("読み込み中…", "Loading…")}</span>}
        {exporting && <span>{t("書き出し中…", "Exporting…")}</span>}
      </div>

      <div className="stats">
        {stats
          ? `t=${stats.timestamp.toFixed(3)}s  frame#${stats.frameNumber}  fps=${stats.fps}  frameTime=${(stats.frameTime * 1000).toFixed(2)}ms`
          : "—"}
      </div>
      <div className="stats">
        {stats
          ? `${t("現在値", "Current")}: fps=${stats.fps}  ${t("フレームタイム", "frameTime")}=${(stats.frameTime * 1000).toFixed(2)}ms`
          : `${t("現在値", "Current")}: —`}
      </div>
      <p>
        {t(
          "現在の設定で全編を再解析して書き出します。再生位置は書き出し範囲に影響しません。",
          "Export reanalyzes the entire video with the current settings, regardless of the playback position.",
        )}
      </p>
      {(exporting || exportMessage) && (
        <div className="stats">
          {exporting && exportProgress
            ? `export ${Math.round(exportProgress.progress * 100)}%  ${formatTime(exportProgress.timestamp)} / ${formatTime(exportProgress.duration)}  ${exportProgress.codecLabel}`
            : exportMessage}
        </div>
      )}

      <div className="grid">
        <div className="media-column">
          <div>{t("映像", "Video")}</div>
          <div ref={videoPanelRef} className="video-panel">
            <canvas ref={videoCanvas} />
            <canvas
              ref={overlayCanvas}
              className="preview-overlay-canvas"
              aria-hidden="true"
            />
            <div
              className={`mask-layer${
                maskEditing ? " is-editing" : ""
              }`}
              onPointerDown={handleMaskPointerDown}
              onPointerMove={handleMaskPointerMove}
              onPointerUp={finishMaskSelection}
              onPointerCancel={finishMaskSelection}
              aria-label={t(
                "差分判定から除外する領域",
                "Area excluded from difference detection",
              )}
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
            <div
              ref={overlayEditorRef}
              className={`overlay-editor-layer${
                layoutEditing ? " is-editing" : ""
              }`}
              onPointerMove={handleOverlayPointerMove}
              onPointerUp={finishOverlayDrag}
              onPointerCancel={finishOverlayDrag}
              aria-label={t(
                "エクスポートオーバーレイの配置",
                "Export overlay layout",
              )}
            >
              {layoutEditing &&
                overlayLayout.map((element) => {
                  const rect = getOverlayElementRect(
                    element,
                    videoCanvas.current?.width ?? 16,
                    videoCanvas.current?.height ?? 9,
                  );
                  return (
                    <div
                      key={element.kind}
                      className={`overlay-edit-box${
                        selectedOverlayKind === element.kind
                          ? " is-selected"
                          : ""
                      }${element.visible ? "" : " is-hidden-element"}`}
                      style={{
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`,
                      }}
                      onPointerDown={(e) =>
                        beginOverlayDrag(e, element.kind, "move")
                      }
                    >
                      <span className="overlay-edit-label">
                        {OVERLAY_ELEMENT_LABELS[element.kind]}
                      </span>
                      <button
                        type="button"
                        className="overlay-resize-handle"
                        onPointerDown={(e) =>
                          beginOverlayDrag(e, element.kind, "resize")
                        }
                        aria-label={t(
                          `${OVERLAY_ELEMENT_LABELS[element.kind]}をリサイズ`,
                          `Resize ${OVERLAY_ELEMENT_LABELS[element.kind]}`,
                        )}
                      />
                    </div>
                  );
                })}
            </div>
            {seeking && (
              <div
                className="seek-loading"
                role="status"
                aria-label={t("シーク中", "Seeking")}
              >
                <LoadingIcon />
              </div>
            )}
            <div
              className={`video-overlay${playerControlsVisible && !layoutEditing && !maskEditing ? "" : " is-hidden"}`}
            >
              <div className="player-controls">
                <button
                  type="button"
                  className="icon-button"
                  onClick={stepBackward}
                  disabled={!stats || loading || seeking || exporting}
                  title={t("1フレーム戻る", "Previous frame")}
                  aria-label={t("1フレーム戻る", "Previous frame")}
                >
                  <StepBackIcon />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={togglePlayback}
                  disabled={!stats || loading || seeking || exporting}
                  title={
                    paused ? t("再生", "Play") : t("一時停止", "Pause")
                  }
                  aria-label={
                    paused ? t("再生", "Play") : t("一時停止", "Pause")
                  }
                >
                  {paused ? <PlayIcon /> : <PauseIcon />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={stepForward}
                  disabled={!stats || loading || seeking || exporting}
                  title={t("1フレーム進む", "Next frame")}
                  aria-label={t("1フレーム進む", "Next frame")}
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
                  disabled={!stats || loading || exporting || duration <= 0}
                  onChange={(e) => seek(parseFloat(e.target.value))}
                  aria-label={t("シーク", "Seek")}
                />
                <span>
                  {formatTime(seekValue)} / {formatTime(duration)}
                </span>
              </label>
            </div>
          </div>
          <div
            className="overlay-settings"
            role="group"
            aria-label={t(
              "エクスポートオーバーレイ設定",
              "Export overlay settings",
            )}
          >
            <div className="overlay-settings-title">
              {t("エクスポートオーバーレイ", "Export Overlay")}
            </div>
            <label>
              <input
                type="checkbox"
                checked={previewOverlayVisible}
                onChange={(e) => setPreviewOverlayVisible(e.target.checked)}
              />
              {t("プレビュー表示", "Show preview")}
            </label>
            {OVERLAY_ELEMENT_KINDS.map((kind) => {
              const element = overlayLayout.find((item) => item.kind === kind);
              return (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={element?.visible ?? false}
                    disabled={exporting}
                    onChange={(e) =>
                      setOverlayElementVisible(kind, e.target.checked)
                    }
                  />
                  {OVERLAY_ELEMENT_LABELS[kind]}
                </label>
              );
            })}
            <button
              type="button"
              onClick={toggleLayoutEditor}
              disabled={!stats || exporting || maskEditing}
              aria-pressed={layoutEditing}
            >
              {layoutEditing
                ? t("編集を終了", "Finish editing")
                : t("レイアウト編集", "Edit layout")}
            </button>
            <button
              type="button"
              onClick={resetOverlayLayout}
              disabled={exporting}
            >
              {t("配置をリセット", "Reset layout")}
            </button>
            {layoutEditing && (
              <span className="overlay-edit-hint">
                {t(
                  "要素をドラッグして移動、右下のハンドルでサイズ変更",
                  "Drag elements to move; use the bottom-right handle to resize",
                )}
              </span>
            )}
          </div>
          <div className="panel-block">
            <div>{t("差分", "Difference")}</div>
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
              title={t("FPS 縦軸レンジ", "FPS Y-axis range")}
              description={t(
                "このグラフの左軸に表示する値の範囲",
                "Range shown on the left axis of this graph",
              )}
              value={fpsRange}
              limits={FPS_AXIS_LIMITS}
              step={1}
              onChange={setFpsRange}
              disabled={exporting}
            />
            <AxisRangeControl
              title={t("横軸レンジ", "X-axis range")}
              description={t(
                "表示する履歴データポイント数（最大フレーム数）",
                "Number of history data points to show (maximum frames)",
              )}
              value={historyRange}
              limits={HISTORY_AXIS_LIMITS}
              step={10}
              onChange={setHistoryRange}
              disabled={exporting}
            />
          </div>
          <div className="chart-panel">
            <div className="chart-title">
              {t("フレームタイム", "Frame Time")} (ms, {ftRange.min}–
              {ftRange.max})
            </div>
            <canvas
              ref={ftCanvas}
              className="chart-canvas"
              width={600}
              height={150}
            />
            <AxisRangeControl
              title={t(
                "フレームタイム 縦軸レンジ",
                "Frame Time Y-axis range",
              )}
              description={t(
                "このグラフの左軸に表示する値の範囲",
                "Range shown on the left axis of this graph",
              )}
              value={ftRange}
              limits={FT_AXIS_LIMITS}
              step={1}
              onChange={setFtRange}
              disabled={exporting}
            />
            <AxisRangeControl
              title={t("横軸レンジ", "X-axis range")}
              description={t(
                "表示する履歴データポイント数（最大フレーム数）",
                "Number of history data points to show (maximum frames)",
              )}
              value={historyRange}
              limits={HISTORY_AXIS_LIMITS}
              step={10}
              onChange={setHistoryRange}
              disabled={exporting}
            />
          </div>
        </div>

        <div className="events-column">
          <div>
            {t(
              `同一フレーム検知 (${events.length}件)`,
              `Duplicate Frames (${events.length})`,
            )}
          </div>
          <div className="events">
            {events.map((e, i) => (
              <button
                key={`${e.frameNumber}-${e.timestamp}-${i}`}
                type="button"
                className="event-link"
                disabled={exporting}
                onClick={() => seekToDuplicateEvent(e.timestamp)}
                title={t(
                  `${e.timestamp.toFixed(3)}s にシーク`,
                  `Seek to ${e.timestamp.toFixed(3)}s`,
                )}
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
  disabled = false,
}: {
  title: string;
  description: string;
  value: AxisRange;
  limits: AxisRange;
  step: number;
  onChange: (range: AxisRange) => void;
  disabled?: boolean;
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
          disabled={disabled}
          type="range"
          min={limits.min}
          max={limits.max}
          step={step}
          value={normalized.max}
          onChange={(e) =>
            applyRange({ ...normalized, max: parseFloat(e.target.value) })
          }
          aria-label={t(`${title} 最大値`, `${title} maximum`)}
        />
        <div className="axis-range-inputs">
          <input
            className="axis-number"
            disabled={disabled}
            type="number"
            min={limits.min}
            max={limits.max}
            step={step}
            value={normalized.min}
            onChange={(e) =>
              applyRange({ ...normalized, min: parseFloat(e.target.value) })
            }
            aria-label={t(`${title} 最小値`, `${title} minimum`)}
          />
          <input
            className="axis-number"
            disabled={disabled}
            type="number"
            min={limits.min}
            max={limits.max}
            step={step}
            value={normalized.max}
            onChange={(e) =>
              applyRange({ ...normalized, max: parseFloat(e.target.value) })
            }
            aria-label={t(`${title} 最大値`, `${title} maximum`)}
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
  return getNormalizedPointerWithin(e.clientX, e.clientY, e.currentTarget);
}

function getNormalizedPointerWithin(
  clientX: number,
  clientY: number,
  element: HTMLElement,
) {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
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
  data: readonly number[],
  axisRange: AxisRange,
  color: string,
  maxPoints: number,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  renderChart(
    ctx,
    { x: 0, y: 0, width: canvas.width, height: canvas.height },
    data,
    axisRange,
    color,
    maxPoints,
    SCREEN_CHART_THEME,
  );
}
