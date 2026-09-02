import { withActions } from "./tradeStats";
import type { Bar } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** 09:35 ET on Tue Jan 2, 2024 — regular RTH session. */
const RTH_OPEN = 1_704_206_100;
const MIN = 60;

function makeBar(timeOffset: number, close: number, fast: number, slow: number): Bar {
  return {
    time: RTH_OPEN + timeOffset,
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

function run(offsets: number[]): Bar[] {
  return withActions(
    offsets.map((offset) => makeBar(offset, 101.5, 100.75, 100)),
    { useGma: true, useMacd: false },
  );
}

{
  const labeled = run([0]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "RTH session-open still trades");
}

{
  const at1559 = (15 * 60 + 59 - (9 * 60 + 35)) * MIN;
  const at1600 = (16 * 60 - (9 * 60 + 35)) * MIN;
  const at1605 = (16 * 60 + 5 - (9 * 60 + 35)) * MIN;
  const labeled = run([0, at1559, at1600, at1605]);
  assert(Boolean(labeled[0]?.actions?.includes("open_call")), "opens during RTH");
  assert(Boolean(labeled[1]?.actions?.includes("close_call")), "flattens on last RTH bar (15:59)");
  assert(!labeled[2]?.actions?.length, "16:00 ET is not tradable");
  assert(!labeled[3]?.actions?.length, "16:05 ET is not tradable");
}

console.log("tradeStats.rth tests passed");
