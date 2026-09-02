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
  const labeled = runGma([{ close: 100.2, fast: 100.2, slow: 100 }]);
  assert(!labeled[0]?.actions?.includes("open_call"), "GMA long blocked when neither MA spread nor close 1.5 is met");
}

{
  const labeled = runGma([{ close: 100.5, fast: 100.75, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "GMA long when fast is 0.75+ above slow");
}

{
  const labeled = runGma([{ close: 101.5, fast: 100.4, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "GMA long when close is 1.5+ above slow");
}

{
  const labeled = runGma([{ close: 99.8, fast: 99.8, slow: 100 }]);
  assert(!labeled[0]?.actions?.includes("open_put"), "GMA short blocked when neither MA spread nor close 1.5 is met");
}

{
  const labeled = runGma([{ close: 99.8, fast: 99.25, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "GMA short when fast is 0.75+ below slow");
}

{
  const labeled = runGma([{ close: 98.4, fast: 102, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "GMA short when close is 1.5+ below slow even if MAs are bullish");
}

{
  const labeled = runGma([{ close: 97.75, fast: 99.25, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "GMA short when close is 1.5+ below fast");
}

{
  const labeled = runGma([
    { close: 100.5, fast: 100.75, slow: 100 },
    { close: 98.4, fast: 100.75, slow: 100 },
  ]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "MA-spread long opens");
  assert(!labeled[1]?.actions?.includes("close_call"), "MA-spread long does not exit when only close goes 1.5 below slow");
}

{
  const labeled = runGma([
    { close: 100.5, fast: 100.75, slow: 100 },
    { close: 100.5, fast: 99.25, slow: 100 },
  ]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "MA-spread long opens");
  assert(Boolean(labeled[1]?.actions?.includes("close_call")), "MA-spread long exits when fast flips 0.75 below slow");
  assert(Boolean(labeled[1]?.actions?.includes("open_put")), "MA flip to short reverses into a put");
}

{
  const labeled = runGma([
    { close: 101.5, fast: 100.4, slow: 100 },
    { close: 101.5, fast: 99.25, slow: 100 },
  ]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "Close-distance long opens");
  assert(!labeled[1]?.actions?.includes("close_call"), "Close-distance long does not exit when only MAs flip");
}

{
  const labeled = runGma([
    { close: 101.5, fast: 100.4, slow: 100 },
    { close: 98.4, fast: 100.4, slow: 100 },
  ]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "Close-distance long opens");
  assert(Boolean(labeled[1]?.actions?.includes("close_call")), "Close-distance long exits when close flips 1.5 below slow");
}

{
  const labeled = runGma([
    { close: 101.5, fast: 100.75, slow: 100 },
    { close: 101.5, fast: 99.25, slow: 100 },
    { close: 98.4, fast: 99.25, slow: 100 },
  ]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "Dual-reason long opens");
  assert(!labeled[1]?.actions?.includes("close_call"), "Dual-reason long stays open after only the MA reason flips");
  assert(Boolean(labeled[2]?.actions?.includes("close_call")), "Dual-reason long exits after the close reason also flips");
}

{
  const labeled = runEma([{ close: 100.5, fast: 100.75, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "EMA long when fast is 0.75+ above slow");
}

{
  const labeled = runEma([{ close: 98.4, fast: 102, slow: 100 }]);
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "EMA short when close is 1.5+ below slow");
}

{
  const labeled = runEma([
    { close: 100.5, fast: 100.75, slow: 100 },
    { close: 100.5, fast: 99.25, slow: 100 },
  ]);
  assert(Boolean(labeled[1]?.actions?.includes("close_call")), "EMA MA-spread long exits when fast flips 0.75 below slow");
}

{
  const labeled = withActions(
    [{ close: 100.5, fast: 100.75, slow: 100 }].map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false, maSpreadMin: 1, maCloseMin: 2 },
  );
  assert(!labeled[0]?.actions?.includes("open_call"), "Raising MA spread to 1 blocks a 0.75 MA-spread long");
}

{
  const labeled = withActions(
    [{ close: 101, fast: 101, slow: 100 }].map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false, maSpreadMin: 1, maCloseMin: 2 },
  );
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "Custom 1.0 MA-spread long still opens when fast is 1+ above slow");
}

{
  const labeled = withActions(
    [{ close: 102, fast: 100.4, slow: 100 }].map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false, maSpreadMin: 1, maCloseMin: 2 },
  );
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "Custom 2.0 close-distance long opens when close is 2+ above slow");
}

{
  const labeled = withActions(
    [{ close: 100.2, fast: 100.2, slow: 100 }].map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false, useMaThresholds: false },
  );
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "GMA crossover long when fast is above slow, even if thresholds are not met");
}

{
  const labeled = withActions(
    [{ close: 101.5, fast: 99.9, slow: 100 }].map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false, useMaThresholds: false },
  );
  assert(Boolean(labeled[0]?.actions?.includes("open_put")), "GMA crossover ignores close-distance long and follows fast below slow");
}

{
  const labeled = withActions(
    [
      { close: 100.2, fast: 100.2, slow: 100 },
      { close: 99.8, fast: 99.8, slow: 100 },
    ].map((row, i) => makeBar(i, row.close, row.fast, row.slow)),
    { useGma: true, useMacd: false, useMaThresholds: false },
  );
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "GMA crossover long opens");
  assert(Boolean(labeled[1]?.actions?.includes("close_call")), "GMA crossover long exits on the opposite cross");
  assert(Boolean(labeled[1]?.actions?.includes("open_put")), "GMA crossover reverses into a put");
}

{
  const labeled = withActions(
    [{ close: 100.2, fast: 100.2, slow: 100 }].map((row, i) => makeBar(i, row.close, 0, 0)),
    {
      useGma: false,
      useMacd: false,
      useEma: true,
      useMaThresholds: false,
      emaFast: [100.2],
      emaSlow: [100],
    },
  );
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "EMA crossover long when fast is above slow");
}

console.log("tradeStats.maEntry tests passed");
