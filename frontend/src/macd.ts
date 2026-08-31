/** Pine-style MACD: MACD = EMA(close, fast) − EMA(close, slow), signal = EMA(MACD, signal). */

export interface MacdSeries {
  macd: Array<number | null>;
  signal: Array<number | null>;
  hist: Array<number | null>;
}

/** Pine `ta.ema`: seed with SMA of the first `period` finite values, then α = 2 / (period + 1). */
function ema(source: Array<number | null>, period: number): Array<number | null> {
  const n = source.length;
  const out: Array<number | null> = Array(n).fill(null);
  if (period < 1 || n < period) return out;
  const alpha = 2 / (period + 1);

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
    const value = source[t];
    const prev = out[t - 1];
    if (value == null || prev == null) continue;
    out[t] = alpha * value + (1 - alpha) * prev;
  }
  return out;
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
  const fastEma = ema(src, fast);
  const slowEma = ema(src, slow);
  const macd: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = fastEma[i];
    const b = slowEma[i];
    if (a == null || b == null) continue;
    macd[i] = a - b;
  }
  const signalLine = ema(macd, signal);
  const hist: Array<number | null> = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const m = macd[i];
    const s = signalLine[i];
    if (m == null || s == null) continue;
    hist[i] = m - s;
  }
  return { macd, signal: signalLine, hist };
}
