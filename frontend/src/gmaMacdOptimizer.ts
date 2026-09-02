import type { Bar, GmaMacdOptimizeMetric, GmaMacdOptimizeResult, OptimizeProgress } from "./types";

const WORKER_SOURCE = `
const LENGTHS = [...Array(29)].map((_, i) => i + 2).concat([...Array(36)].map((_, i) => 32 + i * 2));
const SIGNAL_LENGTHS = [...Array(15)].map((_, i) => i + 1);
const SIGMAS = [...Array(50)].map((_, i) => i + 1);
const SLOW_CACHE_BYTES = 96 * 1024 * 1024;
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23"
});
const weightCache = new Map();

function gmaWeights(length, sigma) {
  const key = length + ":" + sigma;
  let weights = weightCache.get(key);
  if (weights) return weights;
  weights = new Float64Array(length);
  let weightSum = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights[i] = w;
    weightSum += w;
  }
  for (let i = 0; i < length; i++) weights[i] /= weightSum;
  weightCache.set(key, weights);
  return weights;
}

function traditionalGmaInto(source, length, sigma, out) {
  const n = source.length;
  if (length < 1 || sigma < 1 || n < length) {
    out.fill(NaN);
    return out;
  }
  const weights = gmaWeights(length, sigma);
  for (let t = 0; t < length - 1; t++) out[t] = NaN;
  for (let t = length - 1; t < n; t++) {
    let gmaSum = 0;
    for (let lag = 0; lag < length; lag++) {
      const value = source[t - lag];
      if (!Number.isFinite(value)) { gmaSum = NaN; break; }
      gmaSum += value * weights[lag];
    }
    out[t] = gmaSum;
  }
  return out;
}

function traditionalGma(source, length, sigma) {
  return traditionalGmaInto(source, length, sigma, new Float64Array(source.length));
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
    let hour = Number(get("hour"));
    const period = (parts.find((part) => part.type === "dayPeriod")?.value || "").toLowerCase();
    if (period.startsWith("p") && hour < 12) hour += 12;
    if (period.startsWith("a") && hour === 12) hour = 0;
    if (hour === 24) hour = 0;
    const minutes = hour * 60 + Number(get("minute"));
    dates[i] = date;
    rth[i] = minutes >= 570 && minutes < 960 ? 1 : 0;
    open[i] = rth[i] && (i === 0 || !rth[i - 1] || dates[i] !== dates[i - 1]) ? 1 : 0;
    if (i > 0 && rth[i - 1] && (!rth[i] || dates[i] !== dates[i])) close[i - 1] = 1;
  }
  return { rth, open, close };
}

function scoreHistTrades(hist, close, high, low, masks) {
  let side = 0, entry = 0;
  let closed = 0, wins = 0, longClosed = 0, shortClosed = 0, longWins = 0, shortWins = 0;
  let profit = 0, longProfit = 0, shortProfit = 0, profitPct = 0, longProfitPct = 0, shortProfitPct = 0;
  let tradeRunup = 0, maxRunup = 0, totalRunup = 0;
  const closeTrade = (price) => {
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
    side = 0;
    tradeRunup = 0;
  };
  for (let i = 0; i < hist.length; i++) {
    if (side === 1) tradeRunup = Math.max(tradeRunup, (high[i] - entry) / entry * 100);
    else if (side === -1) tradeRunup = Math.max(tradeRunup, (entry - low[i]) / entry * 100);
    if (masks.close[i]) {
      if (side) closeTrade(close[i]);
      continue;
    }
    if (!masks.rth[i] || masks.close[i]) continue;
    if (!Number.isFinite(hist[i])) continue;
    const histLong = hist[i] > 0;
    const histShort = hist[i] < 0;
    const histLongPrev = i > 0 && Number.isFinite(hist[i - 1]) && hist[i - 1] > 0;
    const histShortPrev = i > 0 && Number.isFinite(hist[i - 1]) && hist[i - 1] < 0;
    let buy = false;
    let sell = false;
    if (masks.open[i] && !side) {
      buy = histLong;
      sell = histShort;
    } else {
      buy = histLong && !histLongPrev;
      sell = histShort && !histShortPrev;
    }
    const price = close[i];
    if (buy) {
      if (side === -1) closeTrade(price);
      if (!side) { entry = price; side = 1; tradeRunup = Math.max(0, (high[i] - price) / price * 100); }
    } else if (sell) {
      if (side === 1) closeTrade(price);
      if (!side) { entry = price; side = -1; tradeRunup = Math.max(0, (price - low[i]) / price * 100); }
    }
  }
  return { closed, wins, longClosed, shortClosed, longWins, shortWins, profit, longProfit, shortProfit, profitPct, longProfitPct, shortProfitPct, maxRunup, avgMaxRunup: closed ? totalRunup / closed : 0 };
}

function metricValue(metric, stats) {
  return metric === "total_win_rate" ? (stats.closed ? stats.wins / stats.closed * 100 : 0)
    : metric === "total_profit_pct" ? stats.profitPct
    : metric === "max_runup_pct" ? stats.maxRunup
    : metric === "avg_max_runup_pct" ? stats.avgMaxRunup
    : (stats.closed ? stats.profitPct / stats.closed : 0);
}

function isValidConfig(length, sigma) {
  return length >= 2 && length / sigma <= 3;
}

function buildGrid(lengths) {
  const grid = [];
  for (const length of lengths) {
    for (const sigma of SIGMAS) {
      if (isValidConfig(length, sigma)) grid.push({ length, sigma, ratio: length / sigma });
    }
  }
  return grid;
}

function buildSignalGrid() {
  const grid = [];
  for (const length of SIGNAL_LENGTHS) {
    for (const sigma of SIGMAS) {
      grid.push({ length, sigma, ratio: length / sigma });
    }
  }
  return grid;
}

function packResult(symbol, timeframe, metric, closeLen, totalTrials, fast, slow, sig, s) {
  return {
    symbol, timeframe, metric,
    params: {
      fast_length: fast.length, fast_sigma: fast.sigma,
      slow_length: slow.length, slow_sigma: slow.sigma,
      signal_length: sig.length, signal_sigma: sig.sigma,
    },
    macd_params: null,
    win_rate: s.closed ? s.wins / s.closed * 100 : 0,
    call_win_rate: s.longClosed ? s.longWins / s.longClosed * 100 : null,
    put_win_rate: s.shortClosed ? s.shortWins / s.shortClosed * 100 : null,
    profit: s.profit, call_profit: s.longProfit, put_profit: s.shortProfit,
    profit_pct: s.profitPct, call_profit_pct: s.longProfitPct, put_profit_pct: s.shortProfitPct,
    closed_trades: s.closed, close_calls: s.longClosed, close_puts: s.shortClosed,
    wins: s.wins, call_wins: s.longWins, put_wins: s.shortWins, bars: closeLen, tested: totalTrials,
    max_runup_pct: s.maxRunup, avg_max_runup_pct: s.avgMaxRunup,
    average_profit_pct: s.closed ? s.profitPct / s.closed : 0,
  };
}

self.onmessage = (event) => {
  try {
    const { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades, workerIndex, workerCount } = event.data;
    const minT = Math.max(1, Number.isFinite(minTrades) ? minTrades : 1);
    const maxT = Number.isFinite(maxTrades) ? maxTrades : Infinity;
    const n = close.length;
    const masks = sessionMasks(times);
    const fastGrid = buildGrid(LENGTHS);
    const slowGrid = fastGrid;
    const signalGrid = buildSignalGrid();
    const myFasts = [];
    for (let fi = 0; fi < fastGrid.length; fi++) {
      if (fi % workerCount === workerIndex) myFasts.push(fi);
    }
    let totalTrials = 0;
    let shardTotal = 0;
    for (let fi = 0; fi < fastGrid.length; fi++) {
      for (let si = 0; si < slowGrid.length; si++) {
        if (fastGrid[fi].length >= slowGrid[si].length || fastGrid[fi].ratio >= slowGrid[si].ratio) continue;
        totalTrials += signalGrid.length;
        if (fi % workerCount === workerIndex) shardTotal += signalGrid.length;
      }
    }
    const macd = new Float64Array(n);
    const signalLine = new Float64Array(n);
    const hist = new Float64Array(n);
    const chunkSize = Math.max(1, Math.min(slowGrid.length, Math.floor(SLOW_CACHE_BYTES / Math.max(1, n * 8))));
    let tested = 0;
    let lastPost = 0;
    let best = null;
    const postProgress = (force) => {
      const now = Date.now();
      if (!force && now - lastPost < 120) return;
      lastPost = now;
      self.postMessage({
        type: "progress",
        workerIndex,
        tested,
        shardTotal,
        total: totalTrials,
        timeframe,
        message: workerCount > 1
          ? "Testing GMA MACD parameter combos (" + workerCount + " workers)"
          : "Testing GMA MACD parameter combos",
      });
    };
    postProgress(true);
    if (shardTotal === 0) {
      self.postMessage({ type: "done", result: null, value: null, fi: 0, si: 0, gi: 0, total: totalTrials });
      return;
    }
    for (let slowStart = 0; slowStart < slowGrid.length; slowStart += chunkSize) {
      const slowEnd = Math.min(slowGrid.length, slowStart + chunkSize);
      const slowMas = new Array(slowEnd - slowStart);
      for (let si = slowStart; si < slowEnd; si++) {
        slowMas[si - slowStart] = traditionalGma(close, slowGrid[si].length, slowGrid[si].sigma);
      }
      for (let f = 0; f < myFasts.length; f++) {
        const fi = myFasts[f];
        const fast = fastGrid[fi];
        const fastMa = traditionalGma(close, fast.length, fast.sigma);
        for (let si = slowStart; si < slowEnd; si++) {
          if (fast.length >= slowGrid[si].length || fast.ratio >= slowGrid[si].ratio) continue;
          const slowMa = slowMas[si - slowStart];
          for (let i = 0; i < n; i++) macd[i] = fastMa[i] - slowMa[i];
          for (let gi = 0; gi < signalGrid.length; gi++) {
            const sig = signalGrid[gi];
            traditionalGmaInto(macd, sig.length, sig.sigma, signalLine);
            for (let i = 0; i < n; i++) hist[i] = macd[i] - signalLine[i];
            const stats = scoreHistTrades(hist, close, high, low, masks);
            const value = metricValue(metric, stats);
            if (stats.closed >= minT && stats.closed <= maxT && (!best || value > best.value)) {
              best = { value, fi, si, gi, stats };
            }
            tested++;
            if (tested % 250 === 0) postProgress(false);
          }
        }
      }
    }
    postProgress(true);
    if (!best) {
      self.postMessage({ type: "done", result: null, value: null, fi: 0, si: 0, gi: 0, total: totalTrials });
      return;
    }
    self.postMessage({
      type: "done",
      result: packResult(symbol, timeframe, metric, n, totalTrials, fastGrid[best.fi], slowGrid[best.si], signalGrid[best.gi], best.stats),
      value: best.value,
      fi: best.fi,
      si: best.si,
      gi: best.gi,
      total: totalTrials,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err && err.message ? err.message : String(err) });
  }
};
`;

interface WorkerProgress {
  type: "progress";
  workerIndex: number;
  tested: number;
  shardTotal: number;
  total: number;
  timeframe: string;
  message: string;
}

interface WorkerDone {
  type: "done";
  result: GmaMacdOptimizeResult | null;
  value: number | null;
  fi: number;
  si: number;
  gi: number;
  total: number;
}

interface WorkerFail {
  type: "error";
  message: string;
}

type WorkerEvent = WorkerProgress | WorkerDone | WorkerFail;

export interface GmaMacdShardScore {
  value: number;
  fi: number;
  si: number;
  gi: number;
}

function abortError(): DOMException {
  return new DOMException("Optimization cancelled", "AbortError");
}

export function isGmaMacdOptimizationAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function gmaMacdWorkerCount(
  nBars: number,
  hardwareConcurrency?: number,
): number {
  const reported =
    hardwareConcurrency ??
    (typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4);
  const cores = Math.max(1, reported);
  let cap = 8;
  if (nBars >= 250_000) cap = 2;
  else if (nBars >= 80_000) cap = 4;
  return Math.max(1, Math.min(cap, cores));
}

/** Same rule as the original sequential scan: higher metric wins; ties keep the earlier (fi, si, gi). */
export function isBetterGmaMacdShard(
  next: GmaMacdShardScore,
  best: GmaMacdShardScore | null,
): boolean {
  if (!best) return true;
  if (next.value !== best.value) return next.value > best.value;
  if (next.fi !== best.fi) return next.fi < best.fi;
  if (next.si !== best.si) return next.si < best.si;
  return next.gi < best.gi;
}

/**
 * Grid-search GMA MACD params in a bounded pool of Web Workers.
 * Each worker owns a round-robin slice of fast GMA configs, caches slow GMAs
 * of close in memory-capped chunks, then scores signal GMA combos.
 */
export function runGmaMacdOptimization(
  bars: Bar[],
  symbol: string,
  timeframe: string,
  metric: GmaMacdOptimizeMetric,
  minTrades: number,
  maxTrades: number | null,
  onProgress: (progress: OptimizeProgress) => void,
  signal?: AbortSignal,
): Promise<GmaMacdOptimizeResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (bars.length === 0) {
      reject(new Error("No bars to optimize"));
      return;
    }
    const nWorkers = gmaMacdWorkerCount(bars.length);
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "application/javascript" }),
    );
    const workers: Worker[] = [];
    const testedByWorker = new Array<number>(nWorkers).fill(0);
    const started = Date.now();
    let totalTrials = 0;
    let finished = 0;
    let best: (GmaMacdShardScore & { result: GmaMacdOptimizeResult }) | null = null;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      for (const worker of workers) worker.terminate();
      URL.revokeObjectURL(url);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => settle(() => reject(abortError()));
    signal?.addEventListener("abort", onAbort, { once: true });

    const emitProgress = (message: string) => {
      const tested = testedByWorker.reduce((sum, n) => sum + n, 0);
      const total = totalTrials || tested;
      const pct = total > 0 ? 5 + (tested / total) * 95 : 1;
      const elapsed_s = (Date.now() - started) / 1000;
      onProgress({
        type: "progress",
        pct,
        elapsed_s,
        eta_s: pct > 5 ? elapsed_s * (100 / pct - 1) : null,
        timeframe,
        frame: tested,
        frames: total,
        tested,
        total,
        message,
      });
    };

    onProgress({
      type: "progress",
      pct: 1,
      elapsed_s: 0,
      eta_s: null,
      timeframe,
      frame: 0,
      frames: 0,
      tested: 0,
      total: 0,
      message:
        nWorkers > 1
          ? `Starting ${nWorkers} GMA MACD workers`
          : "Starting GMA MACD optimization",
    });

    const closeSrc = Float64Array.from(bars, (bar) => bar.close);
    const highSrc = Float64Array.from(bars, (bar) => bar.high);
    const lowSrc = Float64Array.from(bars, (bar) => bar.low);
    const timesSrc = Float64Array.from(bars, (bar) => bar.time);

    for (let i = 0; i < nWorkers; i++) {
      const worker = new Worker(url);
      workers.push(worker);
      worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
        if (settled) return;
        const data = event.data;
        if (data.type === "progress") {
          testedByWorker[data.workerIndex] = data.tested;
          if (data.total) totalTrials = data.total;
          emitProgress(data.message);
          return;
        }
        if (data.type === "error") {
          settle(() => reject(new Error(data.message || "GMA MACD optimization failed")));
          return;
        }
        if (data.total) totalTrials = data.total;
        if (data.result != null && data.value != null) {
          const shard: GmaMacdShardScore = {
            value: data.value,
            fi: data.fi,
            si: data.si,
            gi: data.gi,
          };
          if (isBetterGmaMacdShard(shard, best)) {
            best = { ...shard, result: data.result };
          }
        }
        finished += 1;
        if (finished < nWorkers) return;
        if (!best) {
          settle(() =>
            reject(new Error("No GMA MACD combination produced enough closed trades")),
          );
          return;
        }
        const winner = best.result;
        settle(() => resolve(winner));
      };
      worker.onerror = (event) => {
        settle(() =>
          reject(new Error(event.message || "GMA MACD optimization failed")),
        );
      };
      const close = new Float64Array(closeSrc);
      const high = new Float64Array(highSrc);
      const low = new Float64Array(lowSrc);
      const times = new Float64Array(timesSrc);
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
          workerIndex: i,
          workerCount: nWorkers,
        },
        [close.buffer, high.buffer, low.buffer, times.buffer],
      );
    }
  });
}
