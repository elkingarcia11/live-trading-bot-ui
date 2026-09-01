import { computeTradeStats, withActions } from "./tradeStats";
import type { Bar } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** 09:35 ET on Tue Jan 2, 2024 — regular RTH session. */
const RTH_OPEN = 1_704_206_100;

function makeBar(index: number, close: number, timeOffset = index * 60): Bar {
  return {
    time: RTH_OPEN + timeOffset,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    gma_fast: null,
    gma_slow: null,
    signal: null,
  };
}

function runHistSignals(hist: Array<number | null>): Bar[] {
  const bars = hist.map((_, i) => makeBar(i, 100 + i));
  return withActions(bars, {
    useGma: false,
    useMacd: false,
    useGmaMacd: true,
    gmaMacdHist: hist,
  });
}

// Histogram crosses from negative to positive → open long
{
  const hist: Array<number | null> = [null, -1, -0.5, 0.5, 1];
  const labeled = runHistSignals(hist);
  assert(
    Boolean(labeled[3]?.actions?.includes("open_call")),
    "long opens on hist cross above zero",
  );
}

// Histogram crosses from positive to negative → open short
{
  const hist: Array<number | null> = [null, 1, 0.5, -0.5, -1];
  const labeled = runHistSignals(hist);
  assert(
    Boolean(labeled[3]?.actions?.includes("open_put")),
    "short opens on hist cross below zero",
  );
}

// Session close flattens open position
{
  const sessionStart = 1_704_205_800; // 09:30 ET Jan 2, 2024
  const rthMinutes = 390; // 09:30 through 15:59
  const hist: Array<number | null> = Array(rthMinutes + 1).fill(0.5);
  const bars = hist.map((_, i) => makeBar(i, 100, i * 60));
  bars[0] = { ...bars[0], time: sessionStart };
  for (let i = 0; i < bars.length; i++) {
    bars[i] = { ...bars[i], time: sessionStart + i * 60 };
  }
  const labeled = withActions(bars, {
    useGma: false,
    useMacd: false,
    useGmaMacd: true,
    gmaMacdHist: hist,
  });
  const hasClose = labeled.some((bar) => bar.actions?.includes("close_call"));
  assert(hasClose, "session close flattens long position");
}

// computeTradeStats aggregates closed trades from histogram signals
{
  const hist: Array<number | null> = [null, -1, 0.5, 0.5, -0.5, -1];
  const labeled = runHistSignals(hist);
  const stats = computeTradeStats(labeled);
  assert(stats.closedTrades >= 1, "at least one closed trade");
  assert(typeof stats.winRate === "number", "winRate is number");
  assert(typeof stats.profitPct === "number", "profitPct is number");
  assert(typeof stats.maxRunupPct === "number", "maxRunupPct is number");
}

console.log("tradeStats.gmaMacd tests passed");
