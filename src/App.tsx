import { useEffect, useRef, useState } from "react";
import { Player, type Stats, type DupEvent } from "./player";

const HISTORY_CAP = 600;
const EVENTS_CAP = 100;

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(0.05);
  const [frameThreshold, setFrameThreshold] = useState(0);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<DupEvent[]>([]);

  const videoCanvas = useRef<HTMLCanvasElement>(null);
  const diffCanvas = useRef<HTMLCanvasElement>(null);
  const fpsCanvas = useRef<HTMLCanvasElement>(null);
  const ftCanvas = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const historyRef = useRef<{ fps: number; ft: number }[]>([]);

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

  const start = async () => {
    if (!file) return;
    playerRef.current?.stop();
    historyRef.current = [];
    setEvents([]);
    setStats(null);

    const player = new Player({
      file,
      videoCanvas: videoCanvas.current!,
      diffCanvas: diffCanvas.current!,
      threshold,
      frameThreshold,
      onStats: (s) => {
        setStats(s);
        const h = historyRef.current;
        h.push({ fps: s.fps, ft: s.frameTime * 1000 });
        if (h.length > HISTORY_CAP) h.shift();
        drawChart(
          fpsCanvas.current,
          h.map((x) => x.fps),
          0,
          144,
          "#0f0",
        );
        drawChart(
          ftCanvas.current,
          h.map((x) => x.ft),
          0,
          100,
          "#0cf",
        );
      },
      onDuplicate: (e) => {
        setEvents((prev) => {
          const next = [e, ...prev];
          if (next.length > EVENTS_CAP) next.length = EVENTS_CAP;
          return next;
        });
      },
      onEnd: () => setRunning(false),
    });
    playerRef.current = player;
    setRunning(true);
    try {
      await player.start();
    } catch (e) {
      console.error(e);
      alert((e as Error).message);
      setRunning(false);
    }
  };

  return (
    <div>
      <h1>FPS推定</h1>
      <div className="controls">
        <input
          type="file"
          accept="video/mp4"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
        {running && <span>再生中…</span>}
      </div>

      <div className="stats">
        {stats
          ? `t=${stats.timestamp.toFixed(3)}s  frame#${stats.frameNumber}  fps=${stats.fps}  frameTime=${(stats.frameTime * 1000).toFixed(2)}ms`
          : "—"}
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
