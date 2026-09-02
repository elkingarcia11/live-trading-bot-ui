import type { Bar, DualMaOptimizeOptions, EmaOptimizeMetric, EmaOptimizeResult, OptimizeProgress } from "./types";
import { MA_CLOSE_MIN, MA_SPREAD_MIN, MA_THRESHOLD_MAX, MA_THRESHOLD_MIN, MA_THRESHOLD_STEP, normalizeDualMaThresholds } from "./types";

const WORKER_SOURCE = `
const MIN_LEN = 1;
const MAX_LEN = 100;
const DEFAULT_MA_SPREAD = ${MA_SPREAD_MIN};
const DEFAULT_CLOSE_MIN = ${MA_CLOSE_MIN};
const THRESHOLD_MIN = ${MA_THRESHOLD_MIN};
const THRESHOLD_MAX = ${MA_THRESHOLD_MAX};
const THRESHOLD_STEP = ${MA_THRESHOLD_STEP};
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
    let hour = Number(get("hour"));
    const period = (parts.find((part) => part.type === "dayPeriod")?.value || "").toLowerCase();
    if (period.startsWith("p") && hour < 12) hour += 12;
    if (period.startsWith("a") && hour === 12) hour = 0;
    if (hour === 24) hour = 0;
    const minutes = hour * 60 + Number(get("minute"));
    dates[i] = date;
    rth[i] = minutes >= 570 && minutes < 960 ? 1 : 0;
    open[i] = rth[i] && (i === 0 || !rth[i - 1] || dates[i] !== dates[i - 1]) ? 1 : 0;
    if (i > 0 && rth[i - 1] && (!rth[i] || dates[i - 1] !== dates[i])) close[i - 1] = 1;
  }
  return { rth, open, close };
}

function scoreCrossoverTrades(fast, slow, close, high, low, masks) {
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
    const prevLong = i > 0 && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && fast[i - 1] > slow[i - 1];
    const prevShort = i > 0 && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && fast[i - 1] < slow[i - 1];
    let buy = false;
    let sell = false;
    if (masks.open[i] && !side) {
      buy = maLong;
      sell = maShort;
    } else {
      buy = maLong && !prevLong;
      sell = maShort && !prevShort;
    }
    const price = close[i];
    if (buy) {
      if (side === -1) closeTrade(price);
      if (!side) {
        entry = price; side = 1;
        tradeRunup = Math.max(0, (high[i] - price) / price * 100);
      }
    } else if (sell) {
      if (side === 1) closeTrade(price);
      if (!side) {
        entry = price; side = -1;
        tradeRunup = Math.max(0, (price - low[i]) / price * 100);
      }
    }
  }
  return { closed, wins, longClosed, shortClosed, longWins, shortWins, profit, longProfit, shortProfit, profitPct, longProfitPct, shortProfitPct, maxRunup, avgMaxRunup: closed ? totalRunup / closed : 0 };
}

function scoreDualMaTrades(fast, slow, close, high, low, masks, maSpread, closeMin) {
  let side = 0, entry = 0, reasonMa = 0, reasonClose = 0;
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
    reasonMa = 0;
    reasonClose = 0;
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
    const maLong = fast[i] >= slow[i] + maSpread;
    const maShort = fast[i] <= slow[i] - maSpread;
    const closeLong = close[i] >= slow[i] + closeMin;
    const closeShort = close[i] <= fast[i] - closeMin || close[i] <= slow[i] - closeMin;
    const prevMaLong = i > 0 && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && fast[i - 1] >= slow[i - 1] + maSpread;
    const prevMaShort = i > 0 && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && fast[i - 1] <= slow[i - 1] - maSpread;
    const prevCloseLong = i > 0 && Number.isFinite(close[i - 1]) && Number.isFinite(slow[i - 1]) && close[i - 1] >= slow[i - 1] + closeMin;
    const prevCloseShort = i > 0 && Number.isFinite(close[i - 1]) && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1]) && (close[i - 1] <= fast[i - 1] - closeMin || close[i - 1] <= slow[i - 1] - closeMin);
    if (side === 1) {
      if (reasonMa && maShort) reasonMa = 0;
      if (reasonClose && closeShort) reasonClose = 0;
      if (!reasonMa && !reasonClose) closeTrade(close[i]);
    } else if (side === -1) {
      if (reasonMa && maLong) reasonMa = 0;
      if (reasonClose && closeLong) reasonClose = 0;
      if (!reasonMa && !reasonClose) closeTrade(close[i]);
    }
    if (side) continue;
    const session = masks.open[i];
    let enterMaLong = session ? maLong : maLong && !prevMaLong;
    let enterMaShort = session ? maShort : maShort && !prevMaShort;
    let enterCloseLong = session ? closeLong : closeLong && !prevCloseLong;
    let enterCloseShort = session ? closeShort : closeShort && !prevCloseShort;
    if ((enterMaLong || enterCloseLong) && (enterMaShort || enterCloseShort)) {
      if (enterCloseLong && !enterCloseShort) {
        enterMaShort = false;
        enterCloseShort = false;
      } else if (enterCloseShort && !enterCloseLong) {
        enterMaLong = false;
        enterCloseLong = false;
      } else {
        enterMaLong = false;
        enterCloseLong = false;
        enterMaShort = false;
        enterCloseShort = false;
      }
    }
    const price = close[i];
    if (enterMaLong || enterCloseLong) {
      entry = price; side = 1; reasonMa = enterMaLong ? 1 : 0; reasonClose = enterCloseLong ? 1 : 0;
      tradeRunup = Math.max(0, (high[i] - price) / price * 100);
    } else if (enterMaShort || enterCloseShort) {
      entry = price; side = -1; reasonMa = enterMaShort ? 1 : 0; reasonClose = enterCloseShort ? 1 : 0;
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

function thresholdGrid(extra) {
  const out = [];
  for (let v = THRESHOLD_MIN; v <= THRESHOLD_MAX + 1e-9; v += THRESHOLD_STEP) {
    out.push(Math.round(v / THRESHOLD_STEP) * THRESHOLD_STEP);
  }
  if (Number.isFinite(extra) && extra >= 0 && !out.some((value) => Math.abs(value - extra) < 1e-9)) {
    out.push(extra);
    out.sort((a, b) => a - b);
  }
  return out;
}

self.onmessage = (event) => {
  try {
    const { close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades, maSpread, closeMin, optimizeThresholds } = event.data;
    const minT = Math.max(1, Number.isFinite(minTrades) ? minTrades : 1);
    const maxT = Number.isFinite(maxTrades) ? maxTrades : Infinity;
    const spread = Number.isFinite(maSpread) && maSpread >= 0 ? maSpread : DEFAULT_MA_SPREAD;
    const closeDistance = Number.isFinite(closeMin) && closeMin >= 0 ? closeMin : DEFAULT_CLOSE_MIN;
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
    const spreads = optimizeThresholds ? thresholdGrid(spread) : [spread];
    const closeMins = optimizeThresholds ? thresholdGrid(closeDistance) : [closeDistance];
    const threshTrials = optimizeThresholds ? spreads.length * closeMins.length : 0;
    const totalTrials = pairs.length + threshTrials;
    let best = null;
    let lastPost = 0;
    const postProgress = (tested, force, message) => {
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
        message: message || "Testing EMA parameter pairs",
      });
    };
    postProgress(0, true, "Testing EMA parameter pairs");
    for (let i = 0; i < pairs.length; i++) {
      const [fastLen, slowLen] = pairs[i];
      const stats = optimizeThresholds
        ? scoreDualMaTrades(series[fastLen], series[slowLen], close, high, low, masks, spread, closeDistance)
        : scoreCrossoverTrades(series[fastLen], series[slowLen], close, high, low, masks);
      const value = metricValue(metric, stats);
      if (stats.closed >= minT && stats.closed <= maxT && (!best || value > best.value)) {
        best = { value, fastLen, slowLen, stats, maSpread: spread, closeMin: closeDistance };
      }
      if (i % 50 === 0) postProgress(i + 1, false, "Testing EMA parameter pairs");
    }
    if (optimizeThresholds && best) {
      let tested = pairs.length;
      postProgress(tested, true, "Testing EMA thresholds");
      for (let s = 0; s < spreads.length; s++) {
        for (let c = 0; c < closeMins.length; c++) {
          const stats = scoreDualMaTrades(series[best.fastLen], series[best.slowLen], close, high, low, masks, spreads[s], closeMins[c]);
          const value = metricValue(metric, stats);
          if (stats.closed >= minT && stats.closed <= maxT && (!best || value > best.value)) {
            best = { value, fastLen: best.fastLen, slowLen: best.slowLen, stats, maSpread: spreads[s], closeMin: closeMins[c] };
          }
          tested += 1;
          if (tested % 20 === 0) postProgress(tested, false, "Testing EMA thresholds");
        }
      }
      postProgress(totalTrials, true, "Testing EMA thresholds");
    } else {
      postProgress(pairs.length, true, "Testing EMA parameter pairs");
    }
    if (!best) throw new Error("No EMA combination produced enough closed trades");
    const s = best.stats;
    self.postMessage({
      type: "done",
      result: {
        symbol, timeframe, metric,
        params: {
          fast_length: best.fastLen, fast_sigma: 0,
          slow_length: best.slowLen, slow_sigma: 0,
          ma_spread: best.maSpread, close_min: best.closeMin,
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
  dualMa?: DualMaOptimizeOptions,
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
    const thresholds = normalizeDualMaThresholds(dualMa);
    worker.postMessage(
      {
        close, high, low, times, symbol, timeframe, metric, minTrades, maxTrades,
        maSpread: thresholds.maSpread,
        closeMin: thresholds.closeMin,
        optimizeThresholds: Boolean(dualMa?.optimizeThresholds),
      },
      [close.buffer, high.buffer, low.buffer, times.buffer],
    );
  });
}
