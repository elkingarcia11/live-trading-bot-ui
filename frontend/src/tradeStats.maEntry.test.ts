import { withActions } from "./tradeStats";
import type { Bar } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** 09:35 ET on Tue Jan 2, 2024 — regular RTH session. */
const RTH_OPEN = 1_704_206_100;

function makeBar(index: number, close: number, fast: number, slow: number): Bar {
  return {
    time: RTH_OPEN + index * 60,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    gma_fast: fast,
    gma_slow: slow,
    signal: null,
  };
}

function runGma(rows: { close: number; fast: number; slow: number }[]): Bar[] {
  return withActions(
    rows.map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false },
  );
}

function runEma(rows: { close: number; fast: number; slow: number }[]): Bar[] {
  return withActions(
    rows.map((row, i) => makeBar(i, row.close, 0, 0)),
    {
      useGma: false,
      useMacd: false,
      useEma: true,
      emaFast: rows.map((row) => row.fast),
      emaSlow: rows.map((row) => row.slow),
    },
  );
}

{
  const labeled = runGma([{ close: 100, fast: 101, slow: 99 }]);
  assert(!labeled[0]?.actions?.includes("open_call"), "GMA long blocked when close is only 1.0 above slow");
}

{
  const labeled = runGma([{ close: 100.5, fast: 101, slow: 99 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "GMA long when close is 1.5 above slow");
}

{
  const labeled = runGma([{ close: 99, fast: 100, slow: 101 }]);
  assert(!labeled[0]?.actions?.includes("open_put"), "GMA short blocked when close is only 1.0 below fast");
}

{
  const labeled = runGma([{ close: 98.5, fast: 100, slow: 101 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "GMA short when close is 1.5 below fast");
}

{
  const labeled = runGma([{ close: 96, fast: 102, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "GMA shorts when close is 3+ below slow");
  assert(!labeled[0]?.actions?.includes("open_call"), "3-point short wins over bullish MAs");
}

{
  const labeled = runGma([{ close: 104, fast: 99, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "GMA longs when close is 3+ above slow");
}

{
  const labeled = runEma([{ close: 100.5, fast: 101, slow: 99 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "EMA long when close is 1.5 above slow");
}

{
  const labeled = runEma([{ close: 96, fast: 102, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "EMA shorts when close is 3+ below slow");
}

console.log("tradeStats.maEntry tests passed");
