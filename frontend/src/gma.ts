/** Dual GMA matching backend/gma.py and the optimizer worker: fast on EMA(close, 3), slow on SMA(close, 3). */

import { computeEma } from "./ema";
import type { GmaParams } from "./types";

const SOURCE_PERIOD = 3;

export function computeSma(source: Array<number | null>, period: number): Array<number | null> {
  const n = source.length;
  const out: Array<number | null> = Array(n).fill(null);
  if (period < 1 || n < period) return out;

  let start = 0;
  while (start < n && source[start] == null) start += 1;
  if (start + period > n) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    const value = source[start + i];
    if (value == null) return out;
    sum += value;
  }
  out[start + period - 1] = sum / period;
  for (let t = start + period; t < n; t++) {
    const incoming = source[t];
    const outgoing = source[t - period];
    const prev = out[t - 1];
    if (incoming == null || outgoing == null || prev == null) continue;
    out[t] = prev + (incoming - outgoing) / period;
  }
  return out;
}

/** Causal GMA: newest bar first, weights exp(-0.5 * (i / (length / sigma))^2). */
export function computeGaussianMa(
  source: Array<number | null>,
  length: number,
  sigma: number,
): Array<number | null> {
  const n = source.length;
  const out: Array<number | null> = Array(n).fill(null);
  if (length < 1 || sigma <= 0 || n < length) return out;

  const weights = new Float64Array(length);
  let total = 0;
  for (let i = 0; i < length; i++) {
    const x = i / (length / sigma);
    const weight = Math.exp(-0.5 * x * x);
    weights[i] = weight;
    total += weight;
  }
  if (total === 0) return out;
  for (let i = 0; i < length; i++) weights[i] /= total;

  for (let t = length - 1; t < n; t++) {
    let value = 0;
    let ok = true;
    for (let lag = 0; lag < length; lag++) {
      const sample = source[t - lag];
      if (sample == null || !Number.isFinite(sample)) {
        ok = false;
        break;
      }
      value += sample * weights[lag];
    }
    if (ok) out[t] = value;
  }
  return out;
}

export function computeDualGma(
  closes: number[],
  params: GmaParams,
): { fast: Array<number | null>; slow: Array<number | null> } {
  const n = closes.length;
  const empty = { fast: Array(n).fill(null) as Array<number | null>, slow: Array(n).fill(null) as Array<number | null> };
  if (
    n === 0 ||
    params.fastLength < 1 ||
    params.slowLength < 1 ||
    params.fastSigma <= 0 ||
    params.slowSigma <= 0
  ) {
    return empty;
  }
  const src: Array<number | null> = closes.map((value) => (Number.isFinite(value) ? value : null));
  const ema3 = computeEma(src, SOURCE_PERIOD);
  const sma3 = computeSma(src, SOURCE_PERIOD);
  return {
    fast: computeGaussianMa(ema3, params.fastLength, params.fastSigma),
    slow: computeGaussianMa(sma3, params.slowLength, params.slowSigma),
  };
}
