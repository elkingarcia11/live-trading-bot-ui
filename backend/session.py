"""Regular-hours window for call/put trades: 09:30–16:00 America/New_York."""

from __future__ import annotations

import numpy as np
import pandas as pd

RTH_TZ = "America/New_York"
RTH_START_MIN = 9 * 60 + 30
RTH_END_MIN = 16 * 60


def _et_index(timestamps) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.to_datetime(timestamps, utc=True)).tz_convert(RTH_TZ)


def rth_mask(timestamps) -> np.ndarray:
    """True when timestamp is in [09:30, 16:00) America/New_York."""
    idx = _et_index(timestamps)
    if len(idx) == 0:
        return np.zeros(0, dtype=bool)
    minutes = idx.hour.to_numpy() * 60 + idx.minute.to_numpy()
    return (minutes >= RTH_START_MIN) & (minutes < RTH_END_MIN)


def filter_rth(frame: pd.DataFrame, column: str = "timestamp") -> pd.DataFrame:
    """Keep rows whose timestamp falls in the RTH window."""
    if frame.empty or column not in frame.columns:
        return frame
    mask = rth_mask(frame[column])
    return frame[mask].reset_index(drop=True)


def et_session_key(timestamps) -> np.ndarray:
    """YYYYMMDD in Eastern, used to keep tick bars inside one RTH session."""
    idx = _et_index(timestamps)
    return idx.year.to_numpy() * 10_000 + idx.month.to_numpy() * 100 + idx.day.to_numpy()


def session_masks(timestamps) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (rth, session_open, session_close) bool arrays.

    A bar is RTH when its timestamp is in [09:30, 16:00) Eastern.
    session_close is False on the last bar so a live RTH position stays open.
    """
    idx = _et_index(timestamps)
    n = len(idx)
    if n == 0:
        empty = np.zeros(0, dtype=bool)
        return empty, empty.copy(), empty.copy()
    rth = rth_mask(idx)
    dates = idx.year.to_numpy() * 10_000 + idx.month.to_numpy() * 100 + idx.day.to_numpy()
    session_open = rth.copy()
    session_open[1:] = rth[1:] & (~rth[:-1] | (dates[1:] != dates[:-1]))
    session_close = np.zeros(n, dtype=bool)
    session_close[:-1] = rth[:-1] & (~rth[1:] | (dates[:-1] != dates[1:]))
    return rth, session_open, session_close


def rth_trade_indices(
    fast: np.ndarray,
    slow: np.ndarray,
    rth: np.ndarray,
    session_open: np.ndarray,
    session_close: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Buy/sell indices for RTH-only always-in, plus flatten-at-close indices.

    Overnight GMA still runs; crosses outside RTH are ignored. Session open
    syncs to the current GMA side. Session close flattens without reopening.
    """
    n = fast.size
    buy = np.zeros(n, dtype=bool)
    sell = np.zeros(n, dtype=bool)
    if n >= 2:
        f1, f0 = fast[1:], fast[:-1]
        s1, s0 = slow[1:], slow[:-1]
        ok = np.isfinite(f1) & np.isfinite(f0) & np.isfinite(s1) & np.isfinite(s0)
        buy[1:] = ok & (f0 <= s0) & (f1 > s1)
        sell[1:] = ok & (f0 >= s0) & (f1 < s1)
    tradable = rth & ~session_close
    buy &= tradable
    sell &= tradable
    finite = np.isfinite(fast) & np.isfinite(slow)
    open_ok = session_open & tradable & finite
    buy = (buy & ~session_open) | (open_ok & (fast > slow))
    sell = (sell & ~session_open) | (open_ok & (fast < slow))
    return np.flatnonzero(buy), np.flatnonzero(sell), np.flatnonzero(session_close)
