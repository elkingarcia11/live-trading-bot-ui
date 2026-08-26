import type {
  Bar,
  OptimizeMetric,
  OptimizeProgress,
  OptimizeResult,
} from "./types";
import {
  LABEL_SCORING_SOURCE,
  DEFAULT_LABEL_WINDOW,
  DEFAULT_LABEL_SCORE_WEIGHTS,
  type GroundTruthLabels,
  type LabelWindow,
  type LabelScoreWeights,
  type LabelScoreBreakdown,
} from "./labelScoring";

// types.ts now includes both `"label_score"` in the OptimizeMetric union and an
// optional `label_score?: LabelScoreBreakdown` on OptimizeResult, so callers
// outside this file get full typing on the new metric without a local cast.

const WORKER_SOURCE = `
const LENGTHS = [...Array(30)].map((_, i) => i + 1).concat([...Array(10)].map((_, i) => 32 + i * 2));
const SIGMAS = [...Array(19)].map((_, i) => (i + 2) * 0.5);
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23"
});

${LABEL_SCORING_SOURCE}

function sourceSma(src, period) {
  const out = new Float64Array(src.length).fill(NaN);
  if (src.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += src[i];
  out[period - 1] = sum / period;
  for (let i = period; i < src.length; i++) {
    sum += src[i] - src[i - period];
    out[i] = sum / period;
  }
  return out;
}

function sourceEma(src, period) {
  const out = new Float64Array(src.length).fill(NaN);
  if (src.length < period) return out;
  const alpha = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += src[i];
  out[period - 1] = sum / period;
  for (let i = period; i < src.length; i++) out[i] = alpha * src[i] + (1 - alpha) * out[i - 1];
  return out;
}

function gaussianMA(src, length, sigma) {
  const out = new Float64Array(src.length).fill(NaN);
  if (src.length < length) return out;
  const weights = new Float64Array(length);
  let total = 0;
  for (let i = 0; i < length; i++) {
    const x = i / (length / sigma);
    weights[i] = Math.exp(-0.5 * x * x);
    total += weights[i];
  }
  for (let i = 0; i < length; i++) weights[i] /= total;
  for (let t = length - 1; t < src.length; t++) {
    let value = 0;
    for (let k = 0; k < length; k++) value += src[t - k] * weights[k];
    out[t] = value;
  }
  return out;
}

function sessionMasks(times) {
  const rth = new Uint8Array(times.length);
  const open = new Uint8Array(times.length);
  const close = new Uint8Array(times.length);
  const dates = new Array(times.length);
  for (let i = 0; i < times.length; i++) {
    const parts = ET_FORMAT.formatToParts(new Date(times[i] * 1000));
    const get = (type) => parts.find((part) => part.type === type)?.value || "0";
    const date = get("year") + get("month") + get("day");
    const minutes = Number(get("hour")) * 60 + Number(get("minute"));
    dates[i] = date;
    rth[i] = minutes >= 570 && minutes < 960 ? 1 : 0;
    open[i] = rth[i] && (i === 0 || !rth[i - 1] || dates[i] !== dates[i - 1]) ? 1 : 0;
    if (i > 0 && rth[i - 1] && (!rth[i] || dates[i - 1] !== dates[i])) close[i - 1] = 1;
  }
  return { rth, open, close };
}

function tradeIndices(fast, slow, masks) {
  const buy = [];
  const sell = [];
  const flatten = [];
  for (let i = 1; i < fast.length; i++) {
    if (!Number.isFinite(fast[i]) || !Number.isFinite(fast[i - 1]) || !Number.isFinite(slow[i]) || !Number.isFinite(slow[i - 1])) continue;
    const up = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const down = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    if (masks.rth[i] && !masks.close[i] && !masks.open[i]) {
      if (up) buy.push(i);
      if (down) sell.push(i);
    }
  }
  for (let i = 0; i < fast.length; i++) {
    if (masks.open[i] && !masks.close[i] && Number.isFinite(fast[i]) && Number.isFinite(slow[i])) {
      if (fast[i] > slow[i]) buy.push(i);
      if (fast[i] < slow[i]) sell.push(i);
    }
    if (masks.close[i]) flatten.push(i);
  }
  return { buy, sell, flatten };
}

function score(close, high, low, events) {
  let bi = 0, si = 0, fi = 0, side = 0, entry = 0;
  let closed = 0, wins = 0, longClosed = 0, shortClosed = 0, longWins = 0, shortWins = 0;
  let profit = 0, longProfit = 0, shortProfit = 0, profitPct = 0, longProfitPct = 0, shortProfitPct = 0;
  let tradeRunup = 0, maxRunup = 0, totalRunup = 0;
  // Bar indices where a position was actually opened / closed during simulation.
  // These (not the raw buy/sell/flatten crossover arrays) are what a ground-truth
  // entry/exit label should be matched against, since they reflect what the
  // strategy actually did once side-flipping and flatten rules are applied.
  const entryIndices = [];
  const exitIndices = [];
  const closeTrade = (price, index) => {
    if (!side) return;
    const pnl = side === 1 ? price - entry : entry - price;
    const pct = entry === 0 ? 0 : pnl / entry * 100;
    closed++; wins += pnl > 0 ? 1 : 0; profit += pnl; profitPct += pct;
    if (tradeRunup > maxRunup) maxRunup = tradeRunup;
    totalRunup += tradeRunup;
    if (side === 1) {
      longClosed++; longWins += pnl > 0 ? 1 : 0; longProfit += pnl; longProfitPct += pct;
    } else {
      shortClosed++; shortWins += pnl > 0 ? 1 : 0; shortProfit += pnl; shortProfitPct += pct;
    }
    exitIndices.push(index);
    side = 0;
  };
  while (bi < events.buy.length || si < events.sell.length || fi < events.flatten.length) {
    const b = bi < events.buy.length ? events.buy[bi] : Infinity;
    const s = si < events.sell.length ? events.sell[si] : Infinity;
    const f = fi < events.flatten.length ? events.flatten[fi] : Infinity;
    const index = Math.min(b, s, f);
    const price = close[index];
    if (side === 1) {
      tradeRunup = Math.max(tradeRunup, (high[index] - entry) / entry * 100);
    } else if (side === -1) {
      tradeRunup = Math.max(tradeRunup, (entry - low[index]) / entry * 100);
    }
    if (f === index) {
      fi++; if (b === index) bi++; if (s === index) si++; closeTrade(price, index);
    } else if (b === index) {
      bi++; if (side === -1) closeTrade(price, index); if (!side) { entry = price; side = 1; entryIndices.push(index); tradeRunup = Math.max(0, (high[index] - price) / price * 100); }
    } else {
      si++; if (side === 1) closeTrade(price, index); if (!side) { entry = price; side = -1; entryIndices.push(index); tradeRunup = Math.max(0, (price - low[index]) / price * 100); }
    }
  }
  return { closed, wins, longClosed, shortClosed, longWins, shortWins, profit, longProfit, shortProfit, profitPct, longProfitPct, shortProfitPct, maxRunup, avgMaxRunup: closed ? totalRunup / closed : 0, entryIndices, exitIndices };
}

self.onmessage = (event) => {
  const { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades, labels, labelWindow, labelWeights } = event.data;
  const minT = Math.max(1, Number.isFinite(minTrades) ? minTrades : 1);
  const maxT = Number.isFinite(maxTrades) ? maxTrades : Infinity;
  const useLabels = metric === "label_score" && labels && (labels.entries.length || labels.exits.length);
  const ema = sourceEma(close, 3);
  const sma = sourceSma(close, 3);
  const masks = sessionMasks(times);
  const grid = [];
  for (const length of LENGTHS) for (const sigma of SIGMAS) {
    if (length / sigma <= 5) grid.push({ length, sigma, ratio: length / sigma });
  }
  const fastGrid = grid.map((param) => gaussianMA(ema, param.length, param.sigma));
  const slowGrid = grid.map((param) => gaussianMA(sma, param.length, param.sigma));
  const pairs = [];
  for (let fast = 0; fast < grid.length; fast++) for (let slow = 0; slow < grid.length; slow++) if (grid[fast].length < grid[slow].length && grid[fast].ratio < grid[slow].ratio) pairs.push([fast, slow]);
  let best = null;
  for (let i = 0; i < pairs.length; i++) {
    const [fastIndex, slowIndex] = pairs[i];
    const stats = score(close, high, low, tradeIndices(fastGrid[fastIndex], slowGrid[slowIndex], masks));
    let labelBreakdown = null;
    let value;
    if (metric === "label_score") {
      labelBreakdown = useLabels
        ? scoreLabelSet(labels.entries, labels.exits, stats.entryIndices, stats.exitIndices, labelWindow, labelWeights)
        : { entryMatches: [], exitMatches: [], entryFalseNegatives: 0, exitFalseNegatives: 0, falsePositives: 0, entryProximitySum: 0, exitProximitySum: 0, totalScore: 0 };
      value = labelBreakdown.totalScore;
    } else {
      value = metric === "total_win_rate" ? (stats.closed ? stats.wins / stats.closed * 100 : 0)
        : metric === "call_win_rate" ? (stats.longClosed ? stats.longWins / stats.longClosed * 100 : 0)
        : metric === "put_win_rate" ? (stats.shortClosed ? stats.shortWins / stats.shortClosed * 100 : 0)
        : metric === "total_profit_pct" ? stats.profitPct
        : metric === "call_profit_pct" ? stats.longProfitPct
        : metric === "put_profit_pct" ? stats.shortProfitPct
        : metric === "max_runup_pct" ? stats.maxRunup : stats.avgMaxRunup;
    }
    if (stats.closed >= minT && stats.closed <= maxT && (!best || value > best.value)) best = { value, fastIndex, slowIndex, stats, labelBreakdown };
    if (i % 250 === 0 || i === pairs.length - 1) self.postMessage({ type: "progress", pct: 5 + i / pairs.length * 95, frame: i, frames: pairs.length, tested: i + 1, total: pairs.length, timeframe, message: "Testing GMA parameter pairs" });
  }
  if (!best) throw new Error("No GMA combination produced enough closed trades");
  const s = best.stats;
  self.postMessage({ type: "done", result: {
    symbol, timeframe, metric,
    params: { fast_length: grid[best.fastIndex].length, fast_sigma: grid[best.fastIndex].sigma, slow_length: grid[best.slowIndex].length, slow_sigma: grid[best.slowIndex].sigma },
    win_rate: s.closed ? s.wins / s.closed * 100 : 0,
    call_win_rate: s.longClosed ? s.longWins / s.longClosed * 100 : null,
    put_win_rate: s.shortClosed ? s.shortWins / s.shortClosed * 100 : null,
    profit: s.profit, call_profit: s.longProfit, put_profit: s.shortProfit,
    profit_pct: s.profitPct, call_profit_pct: s.longProfitPct, put_profit_pct: s.shortProfitPct,
    closed_trades: s.closed, close_calls: s.longClosed, close_puts: s.shortClosed,
    wins: s.wins, call_wins: s.longWins, put_wins: s.shortWins, bars: close.length, tested: pairs.length,
    max_runup_pct: s.maxRunup, avg_max_runup_pct: s.avgMaxRunup,
    label_score: best.labelBreakdown
  }});
};
`;

interface WorkerProgress {
  type: "progress";
  pct: number;
  frame: number;
  frames: number;
  tested: number;
  total: number;
  timeframe: string;
  message: string;
}

/** OptimizeResult plus the optional label-score breakdown, until types.ts adds the field. */
export type OptimizeResultWithLabelScore = OptimizeResult & {
  label_score?: LabelScoreBreakdown | null;
};

interface WorkerDone {
  type: "done";
  result: OptimizeResultWithLabelScore;
}

export interface CrossTfResult extends OptimizeResultWithLabelScore {
  timeframe: string;
  /** Input-order index used for deterministic tiebreaking only. */
  _tfIndex: number;
}

export interface CrossTfProgress {
  type: "progress";
  pct: number;
  timeframe: string;
  timeframesDone: string[];
  totalTimeframes: number;
  tested: number;
  total: number;
  message: string;
}

/** Optional ground-truth label scoring inputs, only used when metric === "label_score". */
export interface LabelScoringOptions {
  labels: GroundTruthLabels;
  window?: LabelWindow;
  weights?: LabelScoreWeights;
}

function runSingleOptimize(
  bars: Bar[],
  symbol: string,
  timeframe: string,
  metric: OptimizeMetric,
  minTrades: number,
  maxTrades: number | null,
  onProgress: (progress: OptimizeProgress) => void,
  labelScoring?: LabelScoringOptions,
): Promise<OptimizeResultWithLabelScore> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "application/javascript" }),
    );
    const worker = new Worker(url);
    const close = new Float64Array(bars.map((bar) => bar.close));
    const high = new Float64Array(bars.map((bar) => bar.high));
    const low = new Float64Array(bars.map((bar) => bar.low));
    const times = bars.map((bar) => bar.time);
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerDone>) => {
      if (event.data.type === "progress") {
        onProgress({
          ...event.data,
          elapsed_s: 0,
          eta_s: null,
        });
      } else {
        cleanup();
        resolve(event.data.result);
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Frontend optimization failed"));
    };
    worker.postMessage(
      {
        close,
        high,
        low,
        times,
        symbol,
        timeframe,
        metric,
        minTrades,
        maxTrades,
        labels: labelScoring?.labels ?? null,
        labelWindow: labelScoring?.window ?? DEFAULT_LABEL_WINDOW,
        labelWeights: labelScoring?.weights ?? DEFAULT_LABEL_SCORE_WEIGHTS,
      },
      [close.buffer, high.buffer, low.buffer],
    );
  });
}

export function runFrontendOptimization(
  bars: Bar[],
  symbol: string,
  timeframe: string,
  metric: OptimizeMetric,
  minTrades: number,
  maxTrades: number | null,
  onProgress: (progress: OptimizeProgress) => void,
  labelScoring?: LabelScoringOptions,
): Promise<OptimizeResultWithLabelScore> {
  return runSingleOptimize(
    bars,
    symbol,
    timeframe,
    metric,
    minTrades,
    maxTrades,
    onProgress,
    labelScoring,
  );
}

/**
 * Runs the same frontend grid-search worker on multiple timeframes and
 * returns the best (timeframe + GMA params) for the given metric.
 *
 * Timeframes are processed concurrently via a bounded pool of Web Workers
 * (one worker per timeframe, capped at the device's hardware concurrency).
 * Each worker runs an independent grid search, so there is no shared mutable
 * compute state. Result aggregation is serialized on the main thread and uses
 * a deterministic tiebreak (higher metric score, then more closed trades, then
 * earlier input order) so the outcome is identical regardless of completion
 * order — no race conditions or illogical ordering.
 *
 * When `metric` is `"label_score"`, `labelScoring.labels` are matched against
 * each candidate's actual entry/exit bar indices (see the Worker's `score()`),
 * using the exact same ground-truth points for every timeframe. Ground-truth
 * bar indices are expected to already be aligned to each series' own bar
 * spacing by the caller (the label editor is timeframe-specific).
 */
export async function runMultiTimeframeOptimization(
  series: { timeframe: string; bars: Bar[] }[],
  symbol: string,
  metric: OptimizeMetric,
  minTrades: number,
  maxTrades: number | null,
  onProgress: (progress: CrossTfProgress) => void,
  labelScoring?: LabelScoringOptions,
): Promise<CrossTfResult> {
  const total = series.length;
  if (total === 0) throw new Error("No timeframes to optimize");

  // Bounded concurrency: never spawn more workers than we have cores, and
  // never more than the number of timeframes. Fall back to 4 if the browser
  // does not report hardware concurrency.
  const concurrency = Math.max(
    1,
    Math.min(
      total,
      typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4,
    ),
  );

  // Deterministic aggregation state. JS is single-threaded on the main
  // thread, so these updates are naturally serialized; we keep them in one
  // place to make the ordering explicit and race-free.
  let best: CrossTfResult | null = null;
  const doneSet = new Set<number>();
  let completed = 0;

  const emitProgress = (tfIndex: number, p: OptimizeProgress) => {
    // Report done timeframes in input order for a logical readout.
    const timeframesDone = series
      .map((s) => s.timeframe)
      .filter((_, i) => doneSet.has(i));
    onProgress({
      type: "progress",
      pct: ((completed + p.pct / 100) / total) * 100,
      timeframe: series[tfIndex].timeframe,
      timeframesDone,
      totalTimeframes: total,
      tested: p.total,
      total: p.total,
      message: `${series[tfIndex].timeframe}: ${Math.round(p.pct)}%${p.total ? ` (${p.total.toLocaleString()} pairs)` : ""}`,
    });
  };

  const consider = (tfIndex: number, single: OptimizeResultWithLabelScore) => {
    const timeframe = series[tfIndex].timeframe;
    if (
      !best ||
      metricScore(single, metric) > metricScore(best, metric) ||
      (metricScore(single, metric) === metricScore(best, metric) &&
        (single.closed_trades > best.closed_trades ||
          (single.closed_trades === best.closed_trades &&
            tfIndex < best._tfIndex)))
    ) {
      best = { ...single, timeframe, _tfIndex: tfIndex };
    }
  };

  // Simple bounded pool: run up to `concurrency` workers at a time, awaiting
  // each batch before starting the next. This keeps memory bounded and avoids
  // spawning an unbounded number of workers.
  for (let start = 0; start < total; start += concurrency) {
    const batch = series.slice(start, start + concurrency);
    const results = await Promise.all(
      batch.map(async (entry, offset) => {
        const tfIndex = start + offset;
        const single = await runSingleOptimize(
          entry.bars,
          symbol,
          entry.timeframe,
          metric,
          minTrades,
          maxTrades,
          (p) => emitProgress(tfIndex, p),
          labelScoring,
        );
        return { tfIndex, single };
      }),
    );
    for (const { tfIndex, single } of results) {
      consider(tfIndex, single);
      doneSet.add(tfIndex);
      completed++;
    }
  }

  if (!best)
    throw new Error("No GMA combination produced enough closed trades");
  return best;
}

function metricScore(
  result: OptimizeResultWithLabelScore,
  metric: OptimizeMetric,
): number {
  switch (metric) {
    case "total_win_rate":
      return result.win_rate;
    case "total_profit_pct":
      return result.profit_pct;
    case "max_runup_pct":
      return result.max_runup_pct ?? Number.NEGATIVE_INFINITY;
    case "avg_max_runup_pct":
      return result.avg_max_runup_pct ?? Number.NEGATIVE_INFINITY;
    case "label_score":
      return result.label_score?.totalScore ?? Number.NEGATIVE_INFINITY;
    default:
      return Number.NEGATIVE_INFINITY;
  }
}
