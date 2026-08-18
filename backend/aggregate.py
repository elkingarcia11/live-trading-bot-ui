"""Parse timeframe specs and aggregate raw trades into OHLCV bars."""

from __future__ import annotations

import re
from typing import Callable

from backend.gma import EMA_COL, SMA_COL, SOURCE_PERIOD, ema, sma
from backend.session import et_session_key, filter_rth
import pandas as pd

AggProgressFn = Callable[[str, float], None]

SPEC_RE = re.compile(r"^(\d+)(t|s|m|h)$", re.IGNORECASE)
PRESETS = ["20t", "50t", "100t", "200t", "500t", "1000t", "1m", "5m", "15m", "30m", "1h"]

_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600}


def parse_spec(spec: str) -> tuple[str, int]:
    raw = spec.strip().lower()
    match = SPEC_RE.fullmatch(raw)
    if not match:
        raise ValueError("Timeframe must look like 400t, 1m, 5m, or 1h")
    value = int(match.group(1))
    unit = match.group(2)
    if value < 1:
        raise ValueError("Timeframe size must be >= 1")
    if unit == "t":
        if value < 2 or value > 100_000:
            raise ValueError("Tick aggregate must be between 2 and 100000")
        return "tick", value
    seconds = value * _UNIT_SECONDS[unit]
    if seconds > 86_400:
        raise ValueError("Time aggregate cannot exceed 1 day")
    return "time", seconds


def aggregate_trades(
    trades: pd.DataFrame,
    spec: str,
    on_progress: AggProgressFn | None = None,
) -> pd.DataFrame:
    def note(message: str, frac: float) -> None:
        if on_progress is not None:
            on_progress(message, frac)

    kind, size = parse_spec(spec)
    note(f"Preparing {len(trades):,} trades", 0.05)
    frame = _prepare_trades(trades)
    if frame.empty:
        return _empty_ohlcv()
    note(f"Prepared {len(frame):,} trades", 0.2)
    before = len(frame)
    frame = filter_rth(frame)
    note(f"RTH 9:30–4:00 ET: {len(frame):,} of {before:,} trades", 0.3)
    if frame.empty:
        return _empty_ohlcv()
    if kind == "tick":
        note(f"Grouping every {size} RTH ticks", 0.4)
        bars = _tick_bars(frame, size)
    else:
        note(f"Bucketing RTH trades to {spec}", 0.4)
        bars = _time_bars(frame, size)
    note(f"Computing source MAs on {len(bars):,} bars", 0.8)
    return attach_source_mas(bars)


def attach_source_mas(frame: pd.DataFrame) -> pd.DataFrame:
    """Compute EMA(3) and SMA(3) once on close for chart/optimize reuse."""
    if frame.empty or "close" not in frame.columns:
        return frame
    close = frame["close"].to_numpy(dtype="float64")
    if EMA_COL not in frame.columns:
        frame[EMA_COL] = ema(close, SOURCE_PERIOD)
    if SMA_COL not in frame.columns:
        frame[SMA_COL] = sma(close, SOURCE_PERIOD)
    return frame


def _prepare_trades(trades: pd.DataFrame) -> pd.DataFrame:
    if trades.empty:
        return _empty_trades()
    frame = trades.copy()
    if "action" in frame.columns:
        frame = frame[frame["action"].astype(str).str.upper().eq("T")]
    if "timestamp" not in frame.columns or "price" not in frame.columns:
        raise ValueError("trades parquet must include timestamp and price")
    size_col = "size" if "size" in frame.columns else "volume" if "volume" in frame.columns else None
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame["price"] = pd.to_numeric(frame["price"], errors="coerce")
    frame["size"] = pd.to_numeric(frame[size_col], errors="coerce") if size_col else 1.0
    frame = frame.dropna(subset=["timestamp", "price"])
    frame["size"] = frame["size"].fillna(0.0)
    return frame.sort_values("timestamp").reset_index(drop=True)


def _tick_bars(trades: pd.DataFrame, n: int) -> pd.DataFrame:
    if trades.empty:
        return _empty_ohlcv()
    session = et_session_key(trades["timestamp"])
    bar_i = trades.groupby(session, sort=False).cumcount() // n
    grouped = trades.assign(_session=session, _bar=bar_i).groupby(["_session", "_bar"], sort=True)
    out = grouped.agg(
        timestamp=("timestamp", "first"),
        open=("price", "first"),
        high=("price", "max"),
        low=("price", "min"),
        close=("price", "last"),
        volume=("size", "sum"),
    ).reset_index(drop=True)
    return out


def _time_bars(trades: pd.DataFrame, seconds: int) -> pd.DataFrame:
    if seconds % 3600 == 0:
        freq = f"{seconds // 3600}h"
    elif seconds % 60 == 0:
        freq = f"{seconds // 60}min"
    else:
        freq = f"{seconds}s"
    chicago = trades["timestamp"].dt.tz_convert("America/Chicago")
    bucket = chicago.dt.floor(freq)
    grouped = trades.assign(_bucket=bucket).groupby("_bucket", sort=True)
    out = grouped.agg(
        open=("price", "first"),
        high=("price", "max"),
        low=("price", "min"),
        close=("price", "last"),
        volume=("size", "sum"),
    ).reset_index()
    out = out.rename(columns={"_bucket": "timestamp"})
    out["timestamp"] = out["timestamp"].dt.tz_convert("UTC")
    return out[["timestamp", "open", "high", "low", "close", "volume"]]


def _empty_ohlcv() -> pd.DataFrame:
    return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume", EMA_COL, SMA_COL])


def _empty_trades() -> pd.DataFrame:
    return pd.DataFrame(columns=["timestamp", "price", "size"])
