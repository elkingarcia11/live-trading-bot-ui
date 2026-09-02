/** Pine-style MACD: MACD = EMA(close, fast) − EMA(close, slow), signal = EMA(MACD, signal). */

import { computeEma } from "./ema";

export interface MacdSeries {
  macd: Array<number | null>;
  signal: Array<number | null>;
  hist: Array<number | null>;
}

export function computeMacd(
  closes: number[],
  fast: number,
  slow: number,
  signal: number,
): MacdSeries {
  const n = closes.length;
  const empty: MacdSeries = {
    macd: Array(n).fill(null),
    signal: Array(n).fill(null),
    hist: Array(n).fill(null),
  };
  if (n === 0 || fast < 1 || slow < 1 || signal < 1) return empty;

  const src: Array<number | null> = closes.map((value) =>
    Number.isFinite(value) ? value : null,
  );
  const fastEma = computeEma(src, fast);
  const slowEma = computeEma(src, slow);
  const macd: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = fastEma[i];
    const b = slowEma[i];
    if (a == null || b == null) continue;
    macd[i] = a - b;
  }
  const signalLine = computeEma(macd, signal);
  const hist: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const m = macd[i];
    const s = signalLine[i];
    if (m == null || s == null) continue;
    hist[i] = m - s;
  }
  return { macd, signal: signalLine, hist };
}
