import { computeDualGma, computeGaussianMa, computeSma } from "./gma";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

{
  const source = [1, 2, 3, 4, 5];
  const sma = computeSma(source, 3);
  assert(sma[0] == null && sma[1] == null, "SMA warms up for period-1 bars");
  assert(sma[2] === 2, "SMA(3) at index 2 is (1+2+3)/3");
  assert(sma[4] === 4, "SMA(3) at index 4 is (3+4+5)/3");
}

{
  const source = [10, 20, 30, 40];
  const gma = computeGaussianMa(source, 1, 1);
  assert(gma[0] === 10 && gma[3] === 40, "length-1 GMA equals the source");
}

{
  const closes = [10, 11, 12, 13, 14, 20, 21, 22, 8, 7, 6, 5];
  const series = computeDualGma(closes, {
    fastLength: 2,
    fastSigma: 1,
    slowLength: 4,
    slowSigma: 2,
  });
  const lastFast = series.fast.at(-1);
  const lastSlow = series.slow.at(-1);
  assert(lastFast != null && lastSlow != null, "dual GMA produces values after warmup");
  assert(lastFast !== lastSlow, "fast and slow GMA differ");

  const other = computeDualGma(closes, {
    fastLength: 3,
    fastSigma: 1,
    slowLength: 6,
    slowSigma: 2,
  });
  assert(other.fast.at(-1) !== lastFast, "changing length changes the overlay");
}

console.log("gma tests passed");
