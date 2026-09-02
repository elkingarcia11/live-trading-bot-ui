"""Gaussian moving average matching the Dual GMA Pine script in gmaxo.rtf."""

from __future__ import annotations

import numpy as np

SOURCE_PERIOD = 3
EMA_COL = "ema_3"
SMA_COL = "sma_3"


def sma(source: np.ndarray, period: int = SOURCE_PERIOD) -> np.ndarray:
    source = np.asarray(source, dtype=np.float64)
    n = source.size
    out = np.full(n, np.nan, dtype=np.float64)
    if period < 1:
        raise ValueError("period must be >= 1")
    if n < period:
        return out
    windows = np.lib.stride_tricks.sliding_window_view(source, period)
    out[period - 1 :] = windows.mean(axis=1)
    return out


def ema(source: np.ndarray, period: int = SOURCE_PERIOD) -> np.ndarray:
    """Pine-style EMA: seed with SMA, then alpha = 2 / (period + 1)."""
    source = np.asarray(source, dtype=np.float64)
    n = source.size
    out = np.full(n, np.nan, dtype=np.float64)
    if period < 1:
        raise ValueError("period must be >= 1")
    if n < period:
        return out
    alpha = 2.0 / (period + 1.0)
    out[period - 1] = source[:period].mean()
    for t in range(period, n):
        out[t] = alpha * source[t] + (1.0 - alpha) * out[t - 1]
    return out


def gaussian_weights(length: int, sigma_div: float) -> np.ndarray:
    if length < 1:
        raise ValueError("length must be >= 1")
    if sigma_div <= 0:
        raise ValueError("sigma_div must be > 0")
    i = np.arange(length, dtype=np.float64)
    x = i / (length / sigma_div)
    weights = np.exp(-0.5 * x * x)
    total = weights.sum()
    if total == 0:
        raise ValueError("gaussian weights summed to 0")
    return weights / total


def gaussian_ma(source: np.ndarray, length: int, sigma_div: float) -> np.ndarray:
    """Causal GMA: at bar t, weight source[t], source[t-1], ... source[t-length+1]."""
    source = np.asarray(source, dtype=np.float64)
    n = source.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n < length:
        return out
    weights = gaussian_weights(length, sigma_div)
    windows = np.lib.stride_tricks.sliding_window_view(source, length)
    # windows[i] is source[i:i+length] (oldest -> newest). Pine uses newest first.
    out[length - 1 :] = windows[:, ::-1] @ weights
    return out


def dual_gma(
    close: np.ndarray,
    fast_length: int,
    fast_sigma: float,
    slow_length: int,
    slow_sigma: float,
    *,
    ema_source: np.ndarray | None = None,
    sma_source: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Fast GMA on EMA(close, 3); slow GMA on SMA(close, 3)."""
    fast_src = ema(close, SOURCE_PERIOD) if ema_source is None else ema_source
    slow_src = sma(close, SOURCE_PERIOD) if sma_source is None else sma_source
    fast = gaussian_ma(fast_src, fast_length, fast_sigma)
    slow = gaussian_ma(slow_src, slow_length, slow_sigma)
    return fast, slow


def detect_crosses(
    fast: np.ndarray, slow: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Buy when fast crosses above slow; sell when fast crosses below slow."""
    n = min(len(fast), len(slow))
    buy = np.zeros(n, dtype=bool)
    sell = np.zeros(n, dtype=bool)
    if n < 2:
        return buy, sell
    f0, f1 = fast[1:n], fast[: n - 1]
    s0, s1 = slow[1:n], slow[: n - 1]
    valid = np.isfinite(f0) & np.isfinite(f1) & np.isfinite(s0) & np.isfinite(s1)
    buy[1:] = valid & (f1 <= s1) & (f0 > s0)
    sell[1:] = valid & (f1 >= s1) & (f0 < s0)
    return buy, sell
