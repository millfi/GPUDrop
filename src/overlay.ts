// Shared overlay rendering for the live preview and the export burn-in.
// Element geometry is stored in normalized coordinates (0..1) relative to the
// video frame, so one layout definition applies to the scaled-down preview
// canvas and to the full-resolution export canvas alike.

import { t } from "./i18n";

export interface AxisRange {
  min: number;
  max: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const OVERLAY_ELEMENT_KINDS = [
  "fpsValue",
  "fpsChart",
  "ftChart",
] as const;
export type OverlayElementKind = (typeof OVERLAY_ELEMENT_KINDS)[number];

export interface OverlayElement {
  kind: OverlayElementKind;
  rect: NormalizedRect;
  visible: boolean;
}

export type OverlayLayout = OverlayElement[];

export interface OverlayHistoryPoint {
  fps: number;
  ft: number; // milliseconds
}

export interface OverlayFrameData {
  history: readonly OverlayHistoryPoint[];
  historyIndex: number;
  fps: number | null;
}

export interface OverlayAxisSettings {
  fpsRange: AxisRange;
  ftRange: AxisRange;
  maxPoints: number;
}

export interface ChartTheme {
  background: string | null;
  grid: string;
  axis: string;
  label: string;
}

export const FPS_COLOR = "#159447";
export const FT_COLOR = "#0b8fb8";
// The FPS value panel keeps a fixed pixel aspect ratio (width = height * 2.4)
// so digit-count changes never squeeze the text; resizing adjusts height only.
export const FPS_VALUE_ASPECT = 2.4;
export const OVERLAY_MIN_CHART_SIZE = 0.05;
export const OVERLAY_MIN_VALUE_HEIGHT = 0.03;

const OVERLAY_PANEL_BACKGROUND = "rgb(0 0 0 / 55%)";

export const SCREEN_CHART_THEME: ChartTheme = {
  background: "#fff",
  grid: "#d8dee6",
  axis: "#9aa4b2",
  label: "#4b5563",
};

const OVERLAY_CHART_THEME: ChartTheme = {
  background: OVERLAY_PANEL_BACKGROUND,
  grid: "rgb(255 255 255 / 26%)",
  axis: "rgb(255 255 255 / 62%)",
  label: "#e5e7eb",
};

const STORAGE_KEY = "gpudrop-overlay-layout";

export function createDefaultOverlayLayout(): OverlayLayout {
  return [
    {
      kind: "fpsValue",
      rect: { x: 0.02, y: 0.03, width: 0.081, height: 0.06 },
      visible: true,
    },
    {
      kind: "ftChart",
      rect: { x: 0.05, y: 0.63, width: 0.9, height: 0.16 },
      visible: true,
    },
    {
      kind: "fpsChart",
      rect: { x: 0.05, y: 0.81, width: 0.9, height: 0.16 },
      visible: true,
    },
  ];
}

export function loadOverlayLayout(): OverlayLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultOverlayLayout();
    return normalizeOverlayLayout(JSON.parse(raw));
  } catch {
    return createDefaultOverlayLayout();
  }
}

export function saveOverlayLayout(layout: OverlayLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable */
  }
}

export function normalizeOverlayLayout(raw: unknown): OverlayLayout {
  const defaults = createDefaultOverlayLayout();
  if (!Array.isArray(raw)) return defaults;
  return defaults.map((fallback) => {
    const stored = raw.find(
      (entry): entry is OverlayElement =>
        !!entry &&
        typeof entry === "object" &&
        (entry as OverlayElement).kind === fallback.kind &&
        isValidRect((entry as OverlayElement).rect),
    );
    if (!stored) return fallback;
    return {
      kind: fallback.kind,
      rect: clampRect(stored.rect),
      visible:
        typeof stored.visible === "boolean" ? stored.visible : fallback.visible,
    };
  });
}

function isValidRect(rect: unknown): rect is NormalizedRect {
  if (!rect || typeof rect !== "object") return false;
  const r = rect as NormalizedRect;
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  );
}

function clampRect(rect: NormalizedRect): NormalizedRect {
  const width = clamp(rect.width, 0.01, 1);
  const height = clamp(rect.height, 0.01, 1);
  return {
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height,
  };
}

// Normalized coordinates use different units per axis, so a fixed pixel
// aspect ratio must be converted through the video's aspect ratio.
export function fpsValueNormalizedWidth(
  normalizedHeight: number,
  videoWidth: number,
  videoHeight: number,
) {
  const aspect =
    videoWidth > 0 && videoHeight > 0 ? videoHeight / videoWidth : 9 / 16;
  return normalizedHeight * FPS_VALUE_ASPECT * aspect;
}

export function applyOverlayDrag(
  kind: OverlayElementKind,
  startRect: NormalizedRect,
  mode: "move" | "resize",
  dx: number,
  dy: number,
  videoWidth: number,
  videoHeight: number,
): NormalizedRect {
  if (mode === "move") {
    const width =
      kind === "fpsValue"
        ? fpsValueNormalizedWidth(startRect.height, videoWidth, videoHeight)
        : startRect.width;
    return {
      ...startRect,
      x: clamp(startRect.x + dx, 0, Math.max(0, 1 - width)),
      y: clamp(startRect.y + dy, 0, Math.max(0, 1 - startRect.height)),
      width,
    };
  }
  if (kind === "fpsValue") {
    let height = clamp(
      startRect.height + dy,
      OVERLAY_MIN_VALUE_HEIGHT,
      1 - startRect.y,
    );
    let width = fpsValueNormalizedWidth(height, videoWidth, videoHeight);
    if (startRect.x + width > 1) {
      width = 1 - startRect.x;
      const unitWidth = fpsValueNormalizedWidth(1, videoWidth, videoHeight);
      height = clamp(
        unitWidth > 0 ? width / unitWidth : height,
        OVERLAY_MIN_VALUE_HEIGHT,
        1 - startRect.y,
      );
      width = fpsValueNormalizedWidth(height, videoWidth, videoHeight);
    }
    return { ...startRect, width, height };
  }
  return {
    x: startRect.x,
    y: startRect.y,
    width: clamp(startRect.width + dx, OVERLAY_MIN_CHART_SIZE, 1 - startRect.x),
    height: clamp(
      startRect.height + dy,
      OVERLAY_MIN_CHART_SIZE,
      1 - startRect.y,
    ),
  };
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  layout: OverlayLayout,
  data: OverlayFrameData,
  axes: OverlayAxisSettings,
  options: { ghostHidden?: boolean } = {},
) {
  const maxPoints = Number.isFinite(axes.maxPoints)
    ? Math.max(2, Math.floor(axes.maxPoints))
    : 600;
  const end = clamp(data.historyIndex + 1, 0, data.history.length);
  const start = Math.max(0, end - maxPoints);
  const visibleHistory = data.history.slice(start, end);

  for (const element of layout) {
    if (!element.visible && !options.ghostHidden) continue;
    ctx.save();
    if (!element.visible) ctx.globalAlpha = 0.35;
    const rect = toPixelRect(element, width, height);
    switch (element.kind) {
      case "fpsValue":
        drawFpsValuePanel(ctx, rect, data.fps);
        break;
      case "fpsChart":
        renderChart(
          ctx,
          rect,
          visibleHistory.map((point) => point.fps),
          axes.fpsRange,
          FPS_COLOR,
          maxPoints,
          OVERLAY_CHART_THEME,
          "FPS",
        );
        break;
      case "ftChart":
        renderChart(
          ctx,
          rect,
          visibleHistory.map((point) => point.ft),
          axes.ftRange,
          FT_COLOR,
          maxPoints,
          OVERLAY_CHART_THEME,
          t("フレームタイム (ms)", "Frame Time (ms)"),
        );
        break;
    }
    ctx.restore();
  }
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getOverlayElementRect(
  element: OverlayElement,
  videoWidth: number,
  videoHeight: number,
): NormalizedRect {
  let height = clamp(element.rect.height, 0.01, 1);
  let width =
    element.kind === "fpsValue"
      ? fpsValueNormalizedWidth(height, videoWidth, videoHeight)
      : clamp(element.rect.width, 0.01, 1);

  // Extremely narrow portrait videos can make a height-derived FPS panel
  // wider than the frame. Scale both dimensions down to retain its aspect.
  if (width > 1) {
    height /= width;
    width = 1;
  }

  return {
    x: clamp(element.rect.x, 0, Math.max(0, 1 - width)),
    y: clamp(element.rect.y, 0, Math.max(0, 1 - height)),
    width,
    height,
  };
}

function toPixelRect(
  element: OverlayElement,
  width: number,
  height: number,
): PixelRect {
  const normalized = getOverlayElementRect(element, width, height);
  return {
    x: normalized.x * width,
    y: normalized.y * height,
    width: Math.max(1, normalized.width * width),
    height: Math.max(1, normalized.height * height),
  };
}

function drawFpsValuePanel(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  fps: number | null,
) {
  const radius = Math.min(10, rect.height * 0.14);
  ctx.fillStyle = OVERLAY_PANEL_BACKGROUND;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  ctx.fill();

  const numberFont = `700 ${Math.max(8, Math.round(rect.height * 0.56))}px ui-monospace, monospace`;
  const unitFont = `600 ${Math.max(6, Math.round(rect.height * 0.26))}px ui-monospace, monospace`;
  const text = fps === null ? "--" : String(fps);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = numberFont;
  const numberWidth = ctx.measureText(text).width;
  ctx.font = unitFont;
  const unitWidth = ctx.measureText("FPS").width;
  const gap = rect.height * 0.12;
  const totalWidth = numberWidth + gap + unitWidth;
  const startX = rect.x + (rect.width - totalWidth) / 2;
  const baseline = rect.y + rect.height * 0.68;

  ctx.fillStyle = FPS_COLOR;
  ctx.font = numberFont;
  ctx.fillText(text, startX, baseline);
  ctx.font = unitFont;
  ctx.fillText("FPS", startX + numberWidth + gap, baseline);
}

export function renderChart(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  data: readonly number[],
  axisRange: AxisRange,
  color: string,
  maxPoints: number,
  theme: ChartTheme,
  label?: string,
) {
  const { min, max } = sanitizeAxisRange(axisRange);
  const pointCapacity = Number.isFinite(maxPoints)
    ? Math.max(2, Math.floor(maxPoints))
    : 600;
  const fontSize = clamp(Math.round(rect.height * 0.075), 9, 64);
  const plotLeft = rect.x + fontSize * 4;
  const plotRight = rect.x + rect.width - fontSize * 0.75;
  const plotTop = rect.y + fontSize * 0.75;
  const plotBottom = rect.y + rect.height - fontSize * 1.8;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  if (theme.background) {
    ctx.fillStyle = theme.background;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = Math.max(1, rect.height / 150);
  ctx.fillStyle = theme.label;
  ctx.font = `${fontSize}px ui-monospace, monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = plotBottom - ratio * plotHeight;
    const tick = formatAxisTick(min + (max - min) * ratio);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(tick, plotLeft - fontSize * 0.55, y);
  }

  ctx.strokeStyle = theme.axis;
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  if (label) {
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(label, plotLeft + fontSize * 0.5, plotTop + fontSize * 0.3);
  }

  if (data.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, rect.height / 100);
  ctx.lineJoin = "round";
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
  ctx.clip();
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const value = clamp(data[i], min, max);
    const x = plotLeft + (i / (pointCapacity - 1)) * plotWidth;
    const y = plotBottom - ((value - min) / (max - min)) * plotHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

export function formatAxisTick(value: number) {
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

function sanitizeAxisRange(range: AxisRange) {
  const min = Number.isFinite(range.min) ? range.min : 0;
  const max = Number.isFinite(range.max) ? range.max : min + 1;
  if (max - min >= 1) return { min, max };
  return { min, max: min + 1 };
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}
