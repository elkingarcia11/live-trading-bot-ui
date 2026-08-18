"""Gaussian moving average matching the Dual GMA Pine script in gmaxo.rtf."""

from __future__ import annotations

import numpy as np


def gaussian_weights(length: int, sigma_div: float) -> np.ndarray:
    if length < 2:
        raise ValueError("length must be >= 2")
    if sigma_div <= 0:
        raise ValueError("sigma_div must be > 0")
    i = np.arange(length, dtype=np.float64)
    x = i / (length / sigma_div)
    weights = np.exp(-0.5 * x * x)
    total = weights.sum()
    if total == 0:
        raise ValueError("gaussian weights summed to 0")
    return weights / total


def gaussian_ma(close: np.ndarray, length: int, sigma_div: float) -> np.ndarray:
    """Causal GMA: at bar t, weight close[t], close[t-1], ... close[t-length+1]."""
    close = np.asarray(close, dtype=np.float64)
    n = close.size
    out = np.full(n, np.nan, dtype=np.float64)
    if n < length:
        return out
    weights = gaussian_weights(length, sigma_div)
    windows = np.lib.stride_tricks.sliding_window_view(close, length)
    # windows[i] is close[i:i+length] (oldest -> newest). Pine uses newest first.
    out[length - 1 :] = windows[:, ::-1] @ weights
    return out


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
