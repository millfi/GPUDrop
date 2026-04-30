import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Player, type Stats, type DupEvent, type StatsEvent } from "./player";

const HISTORY_CAP = 600;
const EVENTS_CAP = 100;
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

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(0.05);
  const [frameThreshold, setFrameThreshold] = useState(0.0006);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [seekValue, setSeekValue] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<DupEvent[]>([]);

  const videoCanvas = useRef<HTMLCanvasElement>(null);
  const diffCanvas = useRef<HTMLCanvasElement>(null);
  const fpsCanvas = useRef<HTMLCanvasElement>(null);
  const ftCanvas = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<Player | null>(null);
  const historyRef = useRef<{ fps: number; ft: number }[]>([]);
  const historyIndexRef = useRef(-1);

  useEffect(() => {
    playerRef.current?.setThreshold(threshold);
  }, [threshold]);

  useEffect(() => {
    playerRef.current?.setFrameThreshold(frameThreshold);
  }, [frameThreshold]);

  useEffect(() => {
    return () => {
      playerRef.current?.stop();
    };
  }, []);

  const unload = (options: { resetFileInput?: boolean } = {}) => {
    const { resetFileInput = true } = options;
    playerRef.current?.stop();
    playerRef.current = null;
    historyRef.current = [];
    historyIndexRef.current = -1;
    setFile(null);
    setStats(null);
    setEvents([]);
    setDuration(0);
    setSeekValue(0);
    setRunning(false);
    setPaused(false);
    // Reset the file input so re-selecting the same file fires onChange.
    if (resetFileInput && fileInputRef.current) fileInputRef.current.value = "";
    clearCanvas(videoCanvas.current);
    clearCanvas(diffCanvas.current);
    clearCanvas(fpsCanvas.current);
    clearCanvas(ftCanvas.current);
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
    if (!file) return;
    playerRef.current?.stop();
    historyRef.current = [];
    historyIndexRef.current = -1;
    setEvents([]);
    setStats(null);
    setDuration(0);
    setSeekValue(0);

    const player = new Player({
      file,
      videoCanvas: videoCanvas.current!,
      diffCanvas: diffCanvas.current!,
      threshold,
      frameThreshold,
      onStats: updateStats,
      onDuplicate: (e) => {
        setEvents((prev) => {
          const next = [e, ...prev];
          if (next.length > EVENTS_CAP) next.length = EVENTS_CAP;
          return next;
        });
      },
      onEnd: () => {
        setRunning(false);
        setPaused(false);
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
    if (!playerRef.current) return;
    if (paused) playerRef.current.resume();
    else playerRef.current.pause();
  };

  const stepBackward = () => {
    void playerRef.current?.stepBackward().catch(console.error);
  };

  const stepForward = () => {
    void playerRef.current?.stepForward().catch(console.error);
  };

  const seek = (value: number) => {
    setSeekValue(value);
    resetAnalysisHistory();
    setEvents([]);
    void playerRef.current?.seek(value).catch(console.error);
  };

  const updateStats = (s: Stats, e?: StatsEvent) => {
    setStats(s);
    setSeekValue(s.timestamp);
    const h = historyRef.current;
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

  const drawHistoryCharts = () => {
    const end = historyIndexRef.current + 1;
    const start = Math.max(0, end - HISTORY_CAP);
    const visibleHistory = historyRef.current.slice(start, end);
    drawChart(
      fpsCanvas.current,
      visibleHistory.map((x) => x.fps),
      0,
      144,
      "#0f0",
    );
    drawChart(
      ftCanvas.current,
      visibleHistory.map((x) => x.ft),
      0,
      100,
      "#0cf",
    );
  };

  return (
    <div>
      <h1>FPS推定</h1>
      <div className="controls">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MEDIA_TYPES}
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
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
          />
        </label>
        <label>
          フレーム閾値: {(frameThreshold * 100).toFixed(3)}%
          <input
            type="range"
            min={0}
            max={0.1}
            step={0.0001}
            value={frameThreshold}
            onChange={(e) => setFrameThreshold(parseFloat(e.target.value))}
          />
        </label>
        <button onClick={start} disabled={!file || running}>
          開始
        </button>
        <div className="player-controls">
          <button
            type="button"
            className="icon-button"
            onClick={stepBackward}
            disabled={!running}
            title="1フレーム戻る"
            aria-label="1フレーム戻る"
          >
            <StepBackIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={togglePlayback}
            disabled={!running}
            title={paused ? "再生" : "一時停止"}
            aria-label={paused ? "再生" : "一時停止"}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={stepForward}
            disabled={!running}
            title="1フレーム進む"
            aria-label="1フレーム進む"
          >
            <StepForwardIcon />
          </button>
        </div>
        <label className="seek-control">
          シーク
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.001}
            value={Math.min(seekValue, duration || 0)}
            disabled={!running || duration <= 0}
            onChange={(e) => seek(parseFloat(e.target.value))}
          />
          <span>
            {formatTime(seekValue)} / {formatTime(duration)}
          </span>
        </label>
        {running && <span>{paused ? "一時停止中" : "再生中…"}</span>}
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

      <div className="grid">
        <div>
          <div>映像</div>
          <canvas ref={videoCanvas} />
        </div>
        <div>
          <div>差分</div>
          <canvas ref={diffCanvas} />
        </div>
        <div>
          <div>FPS (0–144)</div>
          <canvas ref={fpsCanvas} width={600} height={150} />
        </div>
        <div>
          <div>フレームタイム (ms, 0–100)</div>
          <canvas ref={ftCanvas} width={600} height={150} />
        </div>
      </div>

      <div>
        <div>同一フレーム検知 ({events.length}件)</div>
        <div className="events">
          {events.map((e, i) => (
            <div key={i}>
              t = {e.timestamp.toFixed(3)}s · frame #{e.frameNumber}
            </div>
          ))}
        </div>
      </div>
    </div>
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

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

function drawChart(
  canvas: HTMLCanvasElement | null,
  data: number[],
  min: number,
  max: number,
  color: string,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // gridlines at 1/4 increments
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (i * h) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(min, Math.min(max, data[i]));
    const x = (i / (HISTORY_CAP - 1)) * w;
    const y = h - ((v - min) / (max - min)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
