/** Pine `ta.ema`: seed with SMA of the first `period` finite values, then α = 2 / (period + 1). */

export function computeEma(source: Array<number | null>, period: number): Array<number | null> {
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

export function computeDualEma(
  closes: number[],
  fast: number,
  slow: number,
): { fast: Array<number | null>; slow: Array<number | null> } {
  const n = closes.length;
  const empty = { fast: Array(n).fill(null), slow: Array(n).fill(null) };
  if (n === 0 || fast < 1 || slow < 1) return empty;
  const src: Array<number | null> = closes.map((value) =>
    Number.isFinite(value) ? value : null,
  );
  return { fast: computeEma(src, fast), slow: computeEma(src, slow) };
}
