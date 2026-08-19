import { useEffect, useMemo, useState } from "react";
import Heatmap, { metricColor } from "./Heatmap";
import type {
  GmaParams,
  OptimizeResult,
  OptimizeViz,
  ResultSummary,
  ResultsCatalog,
  VizAgg,
  VizHeatmap,
  VizMetric,
  VizParam,
} from "./types";
import {
  SEARCH_METRIC_FIELD,
  VIZ_METRIC_OPTIONS,
  VIZ_PARAM_OPTIONS,
} from "./types";

interface Props {
  catalog: ResultsCatalog;
  symbol: string;
  metric: string;
  timeframe: string;
  summary: ResultSummary | null;
  viz: OptimizeViz | null;
  result: OptimizeResult | null;
  loading: boolean;
  onSelect: (symbol: string, metric: string, timeframe: string) => void;
  onApply: (params: GmaParams) => void;
}

function paramLabel(id: VizParam): string {
  return VIZ_PARAM_OPTIONS.find((item) => item.id === id)?.label ?? id;
}

function metricLabel(id: VizMetric): string {
  return VIZ_METRIC_OPTIONS.find((item) => item.id === id)?.label ?? id;
}

function transposeGrid(grid: (number | null)[][]): (number | null)[][] {
  if (!grid.length) return grid;
  return grid[0].map((_, xi) => grid.map((row) => row[xi] ?? null));
}

function transposeHeatmap(heatmap: VizHeatmap): VizHeatmap {
  const metrics = {} as VizHeatmap["metrics"];
  for (const [key, pack] of Object.entries(heatmap.metrics)) {
    metrics[key as VizMetric] = { best: transposeGrid(pack.best), mean: transposeGrid(pack.mean) };
  }
  const winners = {} as VizHeatmap["winners"];
  for (const [key, pack] of Object.entries(heatmap.winners)) {
    winners[key as VizMetric] = {
      fast_length: transposeGrid(pack.fast_length),
      fast_sigma: transposeGrid(pack.fast_sigma),
      slow_length: transposeGrid(pack.slow_length),
      slow_sigma: transposeGrid(pack.slow_sigma),
    };
  }
  return {
    ...heatmap,
    x: heatmap.y,
    y: heatmap.x,
    x_values: heatmap.y_values,
    y_values: heatmap.x_values,
    count: transposeGrid(heatmap.count),
    metrics,
    winners,
  };
}

function formatMetric(value: number | null | undefined, id: VizMetric): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (id === "closed") return value.toLocaleString();
  return `${value.toFixed(2)}%`;
}

function CurveChart({
  title,
  labels,
  best,
  mean,
  metric,
}: {
  title: string;
  labels: number[];
  best: (number | null)[];
  mean: (number | null)[];
  metric: VizMetric;
}) {
  const w = 280;
  const h = 120;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const nums = [...best, ...mean].filter((v): v is number => v != null && Number.isFinite(v));
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 1;
  const span = max - min || 1;
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const x = (i: number) => pad.l + (labels.length <= 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
  const y = (v: number) => pad.t + innerH - ((v - min) / span) * innerH;
  const path = (series: (number | null)[]) => {
    let started = false;
    return series
      .map((v, i) => {
        if (v == null) return "";
        const cmd = started ? "L" : "M";
        started = true;
        return `${cmd}${x(i)} ${y(v)}`;
      })
      .filter(Boolean)
      .join(" ");
  };
  const ticks = [0, Math.floor((labels.length - 1) / 2), labels.length - 1].filter(
    (i, idx, all) => i >= 0 && i < labels.length && all.indexOf(i) === idx
  );
  return (
    <div className="curve-card">
      <h3>{title}</h3>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="120">
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="#1c2430" />
        <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="#1c2430" />
        <path d={path(mean)} fill="none" stroke="#5b9dff" strokeWidth="1.5" />
        <path d={path(best)} fill="none" stroke="#00e676" strokeWidth="1.5" />
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={h - 6} textAnchor="middle" fill="#7d8896" fontSize="10">
            {labels[i]}
          </text>
        ))}
        <text x={pad.l - 6} y={pad.t + 4} textAnchor="end" fill="#7d8896" fontSize="10">
          {formatMetric(max, metric)}
        </text>
        <text x={pad.l - 6} y={pad.t + innerH} textAnchor="end" fill="#7d8896" fontSize="10">
          {formatMetric(min, metric)}
        </text>
      </svg>
      <div className="curve-legend">
        <span>
          <i className="swatch best" /> Best
        </span>
        <span>
          <i className="swatch mean" /> Mean
        </span>
      </div>
    </div>
  );
}

export default function ResultsView({
  catalog,
  symbol,
  metric,
  timeframe,
  summary,
  viz,
  result,
  loading,
  onSelect,
  onApply,
}: Props) {
  const symbols = Object.keys(catalog.symbols);
  const metrics = symbol ? Object.keys(catalog.symbols[symbol] ?? {}) : [];
  const frames = symbol && metric ? catalog.symbols[symbol]?.[metric] ?? [] : [];
  const defaultMetric = (viz ? SEARCH_METRIC_FIELD[viz.metric] ?? "win_rate" : "win_rate") as VizMetric;
  const [colorMetric, setColorMetric] = useState<VizMetric>(defaultMetric);
  const [agg, setAgg] = useState<VizAgg>("best");
  const [xParam, setXParam] = useState<VizParam>("fast_length");
  const [yParam, setYParam] = useState<VizParam>("slow_length");

  useEffect(() => {
    if (viz) setColorMetric(SEARCH_METRIC_FIELD[viz.metric] ?? "win_rate");
  }, [viz]);

  const heatmap = useMemo(() => {
    if (!viz) return null;
    const match = viz.heatmaps.find((item) => item.x === xParam && item.y === yParam);
    if (match) return match;
    const swapped = viz.heatmaps.find((item) => item.x === yParam && item.y === xParam);
    return swapped ? transposeHeatmap(swapped) : viz.heatmaps[0] ?? null;
  }, [viz, xParam, yParam]);

  const activeMetric = viz?.metrics.includes(colorMetric) ? colorMetric : defaultMetric;
  const rows = (summary?.by_timeframe ?? []).filter((row) => !row.error);
  const maxWr = Math.max(0, ...rows.map((row) => row.win_rate || 0));
  const maxPct = Math.max(0.0001, ...rows.map((row) => Math.abs(row.profit_pct || 0)));

  return (
    <>
      <aside className="sidebar">
        <section>
          <h2>Results</h2>
          <p className="hint">{viz ? `${viz.n_trials.toLocaleString()} scored trials` : "Saved winners"}</p>
          <label className="field">
            <span>Symbol</span>
            <select
              value={symbol}
              onChange={(e) => {
                const next = e.target.value;
                const nextMetric = Object.keys(catalog.symbols[next] ?? {})[0] ?? "";
                const nextTf = catalog.symbols[next]?.[nextMetric]?.[0]?.timeframe ?? "";
                onSelect(next, nextMetric, nextTf);
              }}
            >
              {symbols.length === 0 && <option value="">No results</option>}
              {symbols.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search metric</span>
            <select
              value={metric}
              onChange={(e) => {
                const next = e.target.value;
                const nextTf = catalog.symbols[symbol]?.[next]?.[0]?.timeframe ?? "";
                onSelect(symbol, next, nextTf);
              }}
              disabled={!metrics.length}
            >
              {metrics.map((item) => (
                <option key={item} value={item}>
                  {item.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Timeframe</span>
            <select
              value={timeframe}
              onChange={(e) => onSelect(symbol, metric, e.target.value)}
              disabled={!frames.length}
            >
              {frames.map((item) => (
                <option key={item.timeframe} value={item.timeframe}>
                  {item.timeframe}
                  {item.has_viz ? "" : " · winner only"}
                </option>
              ))}
            </select>
          </label>
        </section>
        {viz && (
          <section>
            <h2>Heatmap</h2>
            <label className="field">
              <span>Color</span>
              <select value={activeMetric} onChange={(e) => setColorMetric(e.target.value as VizMetric)}>
                {VIZ_METRIC_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Aggregate</span>
              <select value={agg} onChange={(e) => setAgg(e.target.value as VizAgg)}>
                <option value="best">Best at this cell</option>
                <option value="mean">Mean at this cell</option>
              </select>
            </label>
            <label className="field">
              <span>X axis</span>
              <select value={xParam} onChange={(e) => setXParam(e.target.value as VizParam)}>
                {VIZ_PARAM_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.id === yParam}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Y axis</span>
              <select value={yParam} onChange={(e) => setYParam(e.target.value as VizParam)}>
                {VIZ_PARAM_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.id === xParam}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">Click a cell to load that GMA pair on the chart.</p>
          </section>
        )}
        {result && !result.error && (
          <section className="stats">
            <h2>Winner · {result.timeframe}</h2>
            <dl>
              <div>
                <dt>Fast</dt>
                <dd>
                  {result.params.fast_length} / {result.params.fast_sigma}
                </dd>
              </div>
              <div>
                <dt>Slow</dt>
                <dd>
                  {result.params.slow_length} / {result.params.slow_sigma}
                </dd>
              </div>
              <div>
                <dt>Total WR</dt>
                <dd>
                  {result.win_rate.toFixed(2)}% ({result.wins}/{result.closed_trades})
                </dd>
              </div>
              <div>
                <dt>Total %</dt>
                <dd className={result.profit_pct >= 0 ? "buy" : "sell"}>{result.profit_pct.toFixed(2)}%</dd>
              </div>
            </dl>
            <button
              className="apply-params"
              type="button"
              onClick={() =>
                onApply({
                  fastLength: result.params.fast_length,
                  fastSigma: result.params.fast_sigma,
                  slowLength: result.params.slow_length,
                  slowSigma: result.params.slow_sigma,
                })
              }
            >
              Load on chart
            </button>
          </section>
        )}
      </aside>
      <main className="stage results-stage">
        {loading && <div className="banner">Loading results…</div>}
        {!loading && !frames.length && <div className="empty-results">No saved backtests yet. Run optimize to populate this view.</div>}
        {!!rows.length && (
          <section className="result-block">
            <header>
              <h2>Best by timeframe</h2>
              <p>
                {symbol} · {metric.replaceAll("_", " ")}
              </p>
            </header>
            <div className="tf-bars">
              {rows.map((row) => (
                <button
                  key={row.timeframe}
                  type="button"
                  className={row.timeframe === timeframe ? "active" : ""}
                  onClick={() => onSelect(symbol, metric, row.timeframe)}
                >
                  <span className="tf-name">{row.timeframe}</span>
                  <span className="tf-track">
                    <i style={{ width: `${maxWr ? (row.win_rate / maxWr) * 100 : 0}%` }} />
                  </span>
                  <span className="tf-wr">{row.win_rate.toFixed(1)}%</span>
                  <span className={row.profit_pct >= 0 ? "buy" : "sell"}>
                    {row.profit_pct >= 0 ? "+" : ""}
                    {row.profit_pct.toFixed(2)}%
                  </span>
                  <span className="tf-profit-track">
                    <i
                      className={row.profit_pct >= 0 ? "buy" : "sell"}
                      style={{ width: `${(Math.abs(row.profit_pct) / maxPct) * 100}%` }}
                    />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {heatmap && viz ? (
          <>
            <section className="result-block heatmap-block">
              <header>
                <h2>
                  {metricLabel(activeMetric)} · {agg} · {paramLabel(heatmap.y)} vs {paramLabel(heatmap.x)}
                </h2>
                <p>Each cell is the {agg} {metricLabel(activeMetric).toLowerCase()} over the other two GMA params.</p>
              </header>
              <Heatmap heatmap={heatmap} metric={activeMetric} agg={agg} onApply={onApply} />
            </section>
            <section className="result-block">
              <header>
                <h2>Param vs {metricLabel(activeMetric)}</h2>
                <p>Best and mean {metricLabel(activeMetric).toLowerCase()} at each parameter value.</p>
              </header>
              <div className="curve-grid">
                {(Object.keys(viz.curves) as VizParam[]).map((param) => (
                  <CurveChart
                    key={param}
                    title={paramLabel(param)}
                    labels={viz.curves[param].values}
                    best={viz.curves[param][activeMetric].best}
                    mean={viz.curves[param][activeMetric].mean}
                    metric={activeMetric}
                  />
                ))}
              </div>
            </section>
            <section className="result-block">
              <header>
                <h2>Pearson correlation</h2>
                <p>Linear association between GMA params and scored metrics. r from −1 to 1.</p>
              </header>
              <div className="corr-table">
                <table>
                  <thead>
                    <tr>
                      <th />
                      {VIZ_PARAM_OPTIONS.map((item) => (
                        <th key={item.id}>{item.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {VIZ_METRIC_OPTIONS.map((row) => (
                      <tr key={row.id}>
                        <th>{row.label}</th>
                        {VIZ_PARAM_OPTIONS.map((col) => {
                          const value = viz.correlations[row.id]?.[col.id] ?? 0;
                          return (
                            <td key={col.id} style={{ background: metricColor(value, -1, 1, true) }}>
                              {value.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="result-block">
              <header>
                <h2>Top trials</h2>
                <p>Highest {metric.replaceAll("_", " ")} among scored pairs. Click a row to load it.</p>
              </header>
              <div className="trials-table">
                <table>
                  <thead>
                    <tr>
                      <th>Fast L/σ</th>
                      <th>Slow L/σ</th>
                      <th>WR</th>
                      <th>Total %</th>
                      <th>Call WR</th>
                      <th>Put WR</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viz.top_trials.map((trial, index) => (
                      <tr
                        key={`${trial.fast_length}-${trial.fast_sigma}-${trial.slow_length}-${trial.slow_sigma}-${index}`}
                        onClick={() =>
                          onApply({
                            fastLength: trial.fast_length,
                            fastSigma: trial.fast_sigma,
                            slowLength: trial.slow_length,
                            slowSigma: trial.slow_sigma,
                          })
                        }
                      >
                        <td>
                          {trial.fast_length}/{trial.fast_sigma}
                        </td>
                        <td>
                          {trial.slow_length}/{trial.slow_sigma}
                        </td>
                        <td>{trial.win_rate.toFixed(2)}%</td>
                        <td className={trial.profit_pct >= 0 ? "buy" : "sell"}>{trial.profit_pct.toFixed(2)}%</td>
                        <td>{trial.call_win_rate.toFixed(1)}%</td>
                        <td>{trial.put_win_rate.toFixed(1)}%</td>
                        <td>{trial.closed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          !loading &&
          frames.length > 0 && (
            <section className="result-block">
              <header>
                <h2>Heatmaps unavailable</h2>
                <p>
                  This run stored only the winning pair. Re-run optimize or the GLBX backtest to score the full grid
                  and populate heatmaps, param charts, and correlations.
                </p>
              </header>
            </section>
          )
        )}
      </main>
    </>
  );
}

export function defaultResultSelection(
  catalog: ResultsCatalog,
  prefer?: { symbol?: string; metric?: string; timeframe?: string }
): { symbol: string; metric: string; timeframe: string } {
  const symbols = Object.keys(catalog.symbols);
  const symbol =
    prefer?.symbol && catalog.symbols[prefer.symbol] ? prefer.symbol : symbols[0] ?? "";
  const metrics = Object.keys(catalog.symbols[symbol] ?? {});
  const metric =
    prefer?.metric && catalog.symbols[symbol]?.[prefer.metric]
      ? prefer.metric
      : metrics[0] ?? "";
  const frames = catalog.symbols[symbol]?.[metric] ?? [];
  const timeframe =
    prefer?.timeframe && frames.some((item) => item.timeframe === prefer.timeframe)
      ? prefer.timeframe
      : frames[0]?.timeframe ?? "";
  return { symbol, metric, timeframe };
}
