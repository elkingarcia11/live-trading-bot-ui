import type { Bar, EmaOptimizeMetric, EmaOptimizeResult, OptimizeProgress } from "./types";

const WORKER_SOURCE = `
const MIN_LEN = 1;
const MAX_LEN = 100;
const LONG_ABOVE_SLOW = 1.5;
const SHORT_BELOW_FAST = 1.5;
const EXTREME_VS_SLOW = 3;
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23"
});

function computeEma(source, period) {
  const n = source.length;
  const out = new Float64Array(n).fill(NaN);
  if (period < 1 || n < period) return out;
  const alpha = 2 / (period + 1);
  let start = 0;
  while (start < n && !Number.isFinite(source[start])) start += 1;
  if (start + period > n) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const value = source[start + i];
    if (!Number.isFinite(value)) return out;
    sum += value;
  }
  out[start + period - 1] = sum / period;
  for (let t = start + period; t < n; t++) {
    const value = source[t];
    const prev = out[t - 1];
    if (!Number.isFinite(value) || !Number.isFinite(prev)) continue;
    out[t] = alpha * value + (1 - alpha) * prev;
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

function scoreDualMaTrades(fast, slow, close, high, low, masks) {
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
  for (let i = 0; i < fast.length; i++) {
    if (side === 1) tradeRunup = Math.max(tradeRunup, (high[i] - entry) / entry * 100);
    else if (side === -1) tradeRunup = Math.max(tradeRunup, (entry - low[i]) / entry * 100);
    if (masks.close[i]) {
      if (side) closeTrade(close[i]);
      continue;
    }
    if (!masks.rth[i]) continue;
    if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i]) || !Number.isFinite(close[i])) continue;
    const maLong = fast[i] > slow[i];
    const maShort = fast[i] < slow[i];
    const maLongPrev = i > 0 && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && fast[i - 1] > slow[i - 1];
    const maShortPrev = i > 0 && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && fast[i - 1] < slow[i - 1];
    let crossBuy = false;
    let crossSell = false;
    if (masks.open[i] && !side) {
      crossBuy = maLong;
      crossSell = maShort;
    } else if (!masks.open[i]) {
      crossBuy = maLong && !maLongPrev;
      crossSell = maShort && !maShortPrev;
    }
    const longOk = close[i] >= slow[i] + LONG_ABOVE_SLOW;
    const shortOk = close[i] <= fast[i] - SHORT_BELOW_FAST;
    const above3 = close[i] >= slow[i] + EXTREME_VS_SLOW;
    const below3 = close[i] <= slow[i] - EXTREME_VS_SLOW;
    const prevAbove3 = i > 0 && Number.isFinite(close[i - 1]) && Number.isFinite(slow[i - 1]) && close[i - 1] >= slow[i - 1] + EXTREME_VS_SLOW;
    const prevBelow3 = i > 0 && Number.isFinite(close[i - 1]) && Number.isFinite(slow[i - 1]) && close[i - 1] <= slow[i - 1] - EXTREME_VS_SLOW;
    const extremeLong = masks.open[i] ? above3 : above3 && !prevAbove3;
    const extremeShort = masks.open[i] ? below3 : below3 && !prevBelow3;
    let buy = extremeLong || (crossBuy && longOk);
    let sell = extremeShort || (crossSell && shortOk);
    if (extremeLong) sell = false;
    if (extremeShort) buy = false;
    const price = close[i];
    if (side === -1 && (crossBuy || buy)) closeTrade(price);
    if (side === 1 && (crossSell || sell)) closeTrade(price);
    if (!side && buy) {
      entry = price; side = 1;
      tradeRunup = Math.max(0, (high[i] - price) / price * 100);
    } else if (!side && sell) {
      entry = price; side = -1;
      tradeRunup = Math.max(0, (price - low[i]) / price * 100);
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

self.onmessage = (event) => {
  try {
    const { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades } = event.data;
    const minT = Math.max(1, Number.isFinite(minTrades) ? minTrades : 1);
    const maxT = Number.isFinite(maxTrades) ? maxTrades : Infinity;
    const n = close.length;
    if (n === 0) throw new Error("No bars to optimize");
    const masks = sessionMasks(times);
    const series = [];
    for (let length = MIN_LEN; length <= MAX_LEN; length++) {
      series[length] = computeEma(close, length);
    }
    const pairs = [];
    for (let fast = MIN_LEN; fast <= MAX_LEN; fast++) {
      for (let slow = fast + 1; slow <= MAX_LEN; slow++) pairs.push([fast, slow]);
    }
    const totalTrials = pairs.length;
    let best = null;
    let lastPost = 0;
    const postProgress = (tested, force) => {
      const now = Date.now();
      if (!force && now - lastPost < 120) return;
      lastPost = now;
      self.postMessage({
        type: "progress",
        pct: 5 + tested / totalTrials * 95,
        frame: tested,
        frames: totalTrials,
        tested,
        total: totalTrials,
        timeframe,
        message: "Testing EMA parameter pairs",
      });
    };
    postProgress(0, true);
    for (let i = 0; i < pairs.length; i++) {
      const [fastLen, slowLen] = pairs[i];
      const stats = scoreDualMaTrades(series[fastLen], series[slowLen], close, high, low, masks);
      const value = metricValue(metric, stats);
      if (stats.closed >= minT && stats.closed <= maxT && (!best || value > best.value)) {
        best = { value, fastLen, slowLen, stats };
      }
      if (i % 50 === 0) postProgress(i + 1, false);
    }
    postProgress(totalTrials, true);
    if (!best) throw new Error("No EMA combination produced enough closed trades");
    const s = best.stats;
    self.postMessage({
      type: "done",
      result: {
        symbol, timeframe, metric,
        params: {
          fast_length: best.fastLen, fast_sigma: 0,
          slow_length: best.slowLen, slow_sigma: 0,
        },
        macd_params: null,
        win_rate: s.closed ? s.wins / s.closed * 100 : 0,
        call_win_rate: s.longClosed ? s.longWins / s.longClosed * 100 : null,
        put_win_rate: s.shortClosed ? s.shortWins / s.shortClosed * 100 : null,
        profit: s.profit, call_profit: s.longProfit, put_profit: s.shortProfit,
        profit_pct: s.profitPct, call_profit_pct: s.longProfitPct, put_profit_pct: s.shortProfitPct,
        closed_trades: s.closed, close_calls: s.longClosed, close_puts: s.shortClosed,
        wins: s.wins, call_wins: s.longWins, put_wins: s.shortWins, bars: n, tested: totalTrials,
        max_runup_pct: s.maxRunup, avg_max_runup_pct: s.avgMaxRunup,
        average_profit_pct: s.closed ? s.profitPct / s.closed : 0,
      },
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err && err.message ? err.message : String(err) });
  }
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
  result: EmaOptimizeResult;
}

interface WorkerFail {
  type: "error";
  message: string;
}

function abortError(): DOMException {
  return new DOMException("Optimization cancelled", "AbortError");
}

export function isEmaOptimizationAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function runEmaOptimization(
  bars: Bar[],
  symbol: string,
  timeframe: string,
  metric: EmaOptimizeMetric,
  minTrades: number,
  maxTrades: number | null,
  onProgress: (progress: OptimizeProgress) => void,
  signal?: AbortSignal,
): Promise<EmaOptimizeResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (bars.length === 0) {
      reject(new Error("No bars to optimize"));
      return;
    }
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "application/javascript" }),
    );
    const worker = new Worker(url);
    const close = Float64Array.from(bars, (bar) => bar.close);
    const high = Float64Array.from(bars, (bar) => bar.high);
    const low = Float64Array.from(bars, (bar) => bar.low);
    const times = Float64Array.from(bars, (bar) => bar.time);
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
    worker.onmessage = (event: MessageEvent<WorkerProgress | WorkerDone | WorkerFail>) => {
      if (settled) return;
      const data = event.data;
      if (data.type === "progress") {
        onProgress({
          ...data,
          elapsed_s: 0,
          eta_s: null,
        });
        return;
      }
      if (data.type === "error") {
        settle(() => reject(new Error(data.message || "EMA optimization failed")));
        return;
      }
      settle(() => resolve(data.result));
    };
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || "EMA optimization failed")));
    };
    worker.postMessage(
      { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades },
      [close.buffer, high.buffer, low.buffer, times.buffer],
    );
  });
}
