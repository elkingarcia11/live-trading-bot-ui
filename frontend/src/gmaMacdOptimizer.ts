import type { Bar, GmaMacdOptimizeMetric, GmaMacdOptimizeResult, OptimizeProgress } from "./types";

const WORKER_SOURCE = `
const LENGTHS = [...Array(29)].map((_, i) => i + 2).concat([...Array(36)].map((_, i) => 32 + i * 2));
const SIGNAL_LENGTHS = [...Array(15)].map((_, i) => i + 1);
const SIGMAS = [...Array(50)].map((_, i) => i + 1);
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23"
});

function traditionalGma(source, length, sigma) {
  const n = source.length;
  const out = new Float64Array(n).fill(NaN);
  if (length < 1 || sigma < 1 || n < length) return out;
  const weights = new Float64Array(length);
  let weightSum = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights[i] = w;
    weightSum += w;
  }
  for (let i = 0; i < length; i++) weights[i] /= weightSum;
  for (let t = length - 1; t < n; t++) {
    let gmaSum = 0;
    for (let lag = 0; lag < length; lag++) {
      const value = source[t - lag];
      if (!Number.isFinite(value)) { gmaSum = NaN; break; }
      gmaSum += value * weights[lag];
    }
    if (Number.isFinite(gmaSum)) out[t] = gmaSum;
  }
  return out;
}

function computeGmaMacdHist(close, fastLength, fastSigma, slowLength, slowSigma, signalLength, signalSigma) {
  const n = close.length;
  const hist = new Float64Array(n).fill(NaN);
  const fastMa = traditionalGma(close, fastLength, fastSigma);
  const slowMa = traditionalGma(close, slowLength, slowSigma);
  const macd = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(fastMa[i]) && Number.isFinite(slowMa[i])) macd[i] = fastMa[i] - slowMa[i];
  }
  const signalLine = traditionalGma(macd, signalLength, signalSigma);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(macd[i]) && Number.isFinite(signalLine[i])) hist[i] = macd[i] - signalLine[i];
  }
  return hist;
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

self.onmessage = (event) => {
  const { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades } = event.data;
  const minT = Math.max(1, Number.isFinite(minTrades) ? minTrades : 1);
  const maxT = Number.isFinite(maxTrades) ? maxTrades : Infinity;
  const masks = sessionMasks(times);
  const fastGrid = buildGrid(LENGTHS);
  const slowGrid = buildGrid(LENGTHS);
  const signalGrid = buildGrid(SIGNAL_LENGTHS);
  const pairs = [];
  for (let fi = 0; fi < fastGrid.length; fi++) {
    for (let si = 0; si < slowGrid.length; si++) {
      if (fastGrid[fi].ratio >= slowGrid[si].ratio) continue;
      for (let gi = 0; gi < signalGrid.length; gi++) {
        pairs.push([fi, si, gi]);
      }
    }
  }
  const totalTrials = pairs.length;
  let best = null;
  for (let i = 0; i < pairs.length; i++) {
    const [fi, si, gi] = pairs[i];
    const fast = fastGrid[fi];
    const slow = slowGrid[si];
    const sig = signalGrid[gi];
    const hist = computeGmaMacdHist(close, fast.length, fast.sigma, slow.length, slow.sigma, sig.length, sig.sigma);
    const stats = scoreHistTrades(hist, close, high, low, masks);
    const value = metricValue(metric, stats);
    if (stats.closed >= minT && stats.closed <= maxT && (!best || value > best.value)) {
      best = { value, fi, si, gi, stats };
    }
    if (i % 500 === 0 || i === pairs.length - 1) {
      self.postMessage({
        type: "progress",
        pct: 5 + (i + 1) / totalTrials * 95,
        frame: i,
        frames: totalTrials,
        tested: i + 1,
        total: totalTrials,
        timeframe,
        message: "Testing GMA MACD parameter combos",
      });
    }
  }
  if (!best) throw new Error("No GMA MACD combination produced enough closed trades");
  const s = best.stats;
  const fast = fastGrid[best.fi];
  const slow = slowGrid[best.si];
  const sig = signalGrid[best.gi];
  self.postMessage({ type: "done", result: {
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
    wins: s.wins, call_wins: s.longWins, put_wins: s.shortWins, bars: close.length, tested: totalTrials,
    max_runup_pct: s.maxRunup, avg_max_runup_pct: s.avgMaxRunup,
    average_profit_pct: s.closed ? s.profitPct / s.closed : 0,
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

interface WorkerDone {
  type: "done";
  result: GmaMacdOptimizeResult;
}

function abortError(): DOMException {
  return new DOMException("Optimization cancelled", "AbortError");
}

export function isGmaMacdOptimizationAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

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
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "application/javascript" }),
    );
    const worker = new Worker(url);
    const close = new Float64Array(bars.map((bar) => bar.close));
    const high = new Float64Array(bars.map((bar) => bar.high));
    const low = new Float64Array(bars.map((bar) => bar.low));
    const times = bars.map((bar) => bar.time);
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
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
    worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerDone>) => {
      if (event.data.type === "progress") {
        if (!settled) {
          onProgress({
            ...event.data,
            elapsed_s: 0,
            eta_s: null,
          });
        }
      } else {
        const done = event.data as WorkerDone;
        settle(() => resolve(done.result));
      }
    };
    worker.onerror = (event) => {
      settle(() =>
        reject(new Error(event.message || "GMA MACD optimization failed")),
      );
    };
    worker.postMessage(
      { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades },
      [close.buffer, high.buffer, low.buffer],
    );
  });
}
