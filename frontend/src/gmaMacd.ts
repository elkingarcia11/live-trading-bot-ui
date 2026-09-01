/** GMA MACD: fast GMA − slow GMA on close, signal GMA of MACD line, histogram = MACD − signal. */

import type { MacdSeries } from "./macd";
import type { GmaMacdParams } from "./types";

/** Pine GMA: weights exp(-i²/(2σ²)) on source[0]=current … source[length-1]=oldest. */
function traditionalGma(source: Array<number | null>, length: number, sigma: number): Array<number | null> {
  const n = source.length;
  const out: Array<number | null> = Array(n).fill(null);
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
      if (value == null || !Number.isFinite(value)) {
        gmaSum = NaN;
        break;
      }
      gmaSum += value * weights[lag];
    }
    if (Number.isFinite(gmaSum)) out[t] = gmaSum;
  }
  return out;
}

export function computeGmaMacd(closes: number[], params: GmaMacdParams): MacdSeries {
  const n = closes.length;
  const empty: MacdSeries = {
    macd: Array(n).fill(null),
    signal: Array(n).fill(null),
    hist: Array(n).fill(null),
  };
  if (n === 0) return empty;

  const src = closes.map((value) => (Number.isFinite(value) ? value : null));
  const fastMa = traditionalGma(src, params.fastLength, params.fastSigma);
  const slowMa = traditionalGma(src, params.slowLength, params.slowSigma);

  const macd: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const fast = fastMa[i];
    const slow = slowMa[i];
    if (fast == null || slow == null) continue;
    macd[i] = fast - slow;
  }

  const signalLine = traditionalGma(macd, params.signalLength, params.signalSigma);
  const hist: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const m = macd[i];
    const s = signalLine[i];
    if (m == null || s == null) continue;
    hist[i] = m - s;
  }
  return { macd, signal: signalLine, hist };
}
