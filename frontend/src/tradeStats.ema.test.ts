import { computeDualEma } from "./ema";
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

{
  const closes = [10, 11, 12, 13, 20, 21, 22, 8, 7, 6];
  const bars = closes.map((close, i) => makeBar(i, close));
  const series = computeDualEma(closes, 2, 4);
  const labeled = withActions(bars, {
    useGma: false,
    useMacd: false,
    useEma: true,
    emaFast: series.fast,
    emaSlow: series.slow,
  });
  const opened = labeled.some((bar) => bar.actions?.includes("open_call") || bar.actions?.includes("open_put"));
  assert(opened, "EMA crossovers produce at least one open");
  const stats = computeTradeStats(labeled);
  assert(typeof stats.closedTrades === "number", "trade stats computed");
}

{
  const short = computeDualEma([1, 2, 3], 2, 4);
  assert(short.slow.every((value) => value == null), "slow EMA of 4 needs 4 bars");
}

console.log("tradeStats.ema tests passed");
