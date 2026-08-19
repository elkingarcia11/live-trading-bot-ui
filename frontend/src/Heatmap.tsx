import { useEffect, useMemo, useRef, useState } from "react";
import type { GmaParams, VizAgg, VizHeatmap, VizMetric, VizParam } from "./types";
import { VIZ_PARAM_OPTIONS } from "./types";

interface Hover {
  x: number;
  y: number;
  xi: number;
  yi: number;
  value: number | null;
  count: number | null;
  params: GmaParams | null;
}

interface Props {
  heatmap: VizHeatmap;
  metric: VizMetric;
  agg: VizAgg;
  onApply: (params: GmaParams) => void;
}

function paramLabel(id: VizParam): string {
  return VIZ_PARAM_OPTIONS.find((item) => item.id === id)?.label ?? id;
}

function isProfit(metric: VizMetric): boolean {
  return metric.endsWith("profit_pct");
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export function metricColor(value: number, min: number, max: number, diverging: boolean): string {
  if (!Number.isFinite(value) || max === min) return "#1b2836";
  if (diverging) {
    const span = Math.max(Math.abs(min), Math.abs(max), 1e-9);
    const t = Math.max(-1, Math.min(1, value / span));
    if (t < 0) {
      const u = -t;
      return rgb(lerp(27, 255, u), lerp(40, 82, u), lerp(54, 82, u));
    }
    return rgb(lerp(27, 0, t), lerp(40, 230, t), lerp(54, 118, t));
  }
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  if (t < 0.5) {
    const u = t * 2;
    return rgb(lerp(27, 91, u), lerp(40, 157, u), lerp(54, 255, u));
  }
  const u = (t - 0.5) * 2;
  return rgb(lerp(91, 0, u), lerp(157, 230, u), lerp(255, 118, u));
}

function winnerParams(heatmap: VizHeatmap, metric: VizMetric, yi: number, xi: number): GmaParams | null {
  const pack = heatmap.winners[metric];
  const fl = pack.fast_length[yi]?.[xi];
  const fs = pack.fast_sigma[yi]?.[xi];
  const sl = pack.slow_length[yi]?.[xi];
  const ss = pack.slow_sigma[yi]?.[xi];
  if (fl == null || fs == null || sl == null || ss == null) return null;
  return { fastLength: fl, fastSigma: fs, slowLength: sl, slowSigma: ss };
}

export default function Heatmap({ heatmap, metric, agg, onApply }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 640, h: 420 });
  const [hover, setHover] = useState<Hover | null>(null);

  const grid = heatmap.metrics[metric]?.[agg] ?? [];
  const diverging = isProfit(metric);
  const { min, max } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of grid) {
      for (const cell of row) {
        if (cell == null || !Number.isFinite(cell)) continue;
        if (cell < lo) lo = cell;
        if (cell > hi) hi = cell;
      }
    }
    if (!Number.isFinite(lo)) return { min: 0, max: 1 };
    return { min: lo, max: hi };
  }, [grid]);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const apply = () => {
      const rect = node.getBoundingClientRect();
      setSize({ w: Math.max(320, Math.floor(rect.width)), h: Math.max(280, Math.floor(rect.height)) });
    };
    apply();
    const obs = new ResizeObserver(apply);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  const layout = useMemo(() => {
    const left = 52;
    const right = 56;
    const top = 12;
    const bottom = 36;
    const nx = heatmap.x_values.length;
    const ny = heatmap.y_values.length;
    const plotW = Math.max(1, size.w - left - right);
    const plotH = Math.max(1, size.h - top - bottom);
    return { left, right, top, bottom, nx, ny, plotW, plotH, cellW: plotW / nx, cellH: plotH / ny };
  }, [heatmap.x_values.length, heatmap.y_values.length, size.h, size.w]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const { left, top, nx, ny, cellW, cellH, plotW, plotH } = layout;
    ctx.fillStyle = "#0c1016";
    ctx.fillRect(0, 0, size.w, size.h);
    for (let yi = 0; yi < ny; yi++) {
      for (let xi = 0; xi < nx; xi++) {
        const value = grid[yi]?.[xi];
        ctx.fillStyle = value == null ? "#121821" : metricColor(value, min, max, diverging);
        ctx.fillRect(left + xi * cellW, top + (ny - 1 - yi) * cellH, Math.max(1, cellW - 0.4), Math.max(1, cellH - 0.4));
      }
    }
    if (hover) {
      ctx.strokeStyle = "#d7dee8";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        left + hover.xi * cellW,
        top + (ny - 1 - hover.yi) * cellH,
        Math.max(1, cellW - 0.4),
        Math.max(1, cellH - 0.4)
      );
    }
    ctx.fillStyle = "#7d8896";
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xStep = Math.max(1, Math.ceil(nx / 8));
    for (let xi = 0; xi < nx; xi += xStep) {
      ctx.fillText(String(heatmap.x_values[xi]), left + (xi + 0.5) * cellW, top + plotH + 8);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const yStep = Math.max(1, Math.ceil(ny / 8));
    for (let yi = 0; yi < ny; yi += yStep) {
      ctx.fillText(String(heatmap.y_values[yi]), left - 8, top + (ny - 0.5 - yi) * cellH);
    }
    const barX = left + plotW + 16;
    const barY = top;
    const barH = plotH;
    const barW = 10;
    for (let i = 0; i < 64; i++) {
      const t = 1 - i / 63;
      const value = min + t * (max - min);
      ctx.fillStyle = metricColor(value, min, max, diverging);
      ctx.fillRect(barX, barY + (i / 64) * barH, barW, barH / 64 + 0.5);
    }
    ctx.fillStyle = "#7d8896";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(formatTick(max, metric), barX + 14, barY);
    ctx.textBaseline = "bottom";
    ctx.fillText(formatTick(min, metric), barX + 14, barY + barH);
  }, [diverging, grid, heatmap.x_values, heatmap.y_values, hover, layout, max, metric, min, size.h, size.w]);

  const cellAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { left, top, nx, ny, cellW, cellH, plotW, plotH } = layout;
    if (x < left || y < top || x >= left + plotW || y >= top + plotH) return null;
    const xi = Math.min(nx - 1, Math.max(0, Math.floor((x - left) / cellW)));
    const yi = Math.min(ny - 1, Math.max(0, ny - 1 - Math.floor((y - top) / cellH)));
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      xi,
      yi,
      value: grid[yi]?.[xi] ?? null,
      count: heatmap.count[yi]?.[xi] ?? null,
      params: winnerParams(heatmap, metric, yi, xi),
    };
  };

  return (
    <div className="heatmap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => setHover(cellAt(event.clientX, event.clientY))}
        onClick={(event) => {
          const cell = cellAt(event.clientX, event.clientY);
          if (cell?.params) onApply(cell.params);
        }}
      />
      <div className="heatmap-axes">
        <span>{paramLabel(heatmap.y)}</span>
        <span>{paramLabel(heatmap.x)}</span>
      </div>
      {hover && (
        <div className="heatmap-tip" style={{ left: Math.min(hover.x + 14, size.w - 220), top: Math.max(8, hover.y - 72) }}>
          <div>
            {paramLabel(heatmap.x)} {heatmap.x_values[hover.xi]} · {paramLabel(heatmap.y)} {heatmap.y_values[hover.yi]}
          </div>
          <div>
            {agg} {formatTick(hover.value, metric)}
            {hover.count != null ? ` · ${hover.count.toLocaleString()} trials` : ""}
          </div>
          {hover.params && (
            <div>
              fast {hover.params.fastLength}/{hover.params.fastSigma} · slow {hover.params.slowLength}/
              {hover.params.slowSigma}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTick(value: number | null, metric: VizMetric): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (metric === "closed") return value.toFixed(0);
  if (metric.endsWith("win_rate") || metric.endsWith("profit_pct")) return `${value.toFixed(metric.endsWith("win_rate") ? 1 : 2)}%`;
  return String(value);
}
