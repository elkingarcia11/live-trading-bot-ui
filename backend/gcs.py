"""GCS helpers for continuous timeframe CSV data and legacy OHLCV data."""

from __future__ import annotations

import io
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Callable

from backend.aggregate import aggregate_trades, attach_source_mas
import pandas as pd
import pyarrow.parquet as pq
from google.cloud import storage

ProgressFn = Callable[[dict], None]

BUCKET_NAME = os.environ.get("GCS_BUCKET", "live-trading-bot")
OHLCV_PREFIX = "ohlcv/"
TRADES_PREFIX = "trades/"
CONTINUOUS_PREFIX = "continuous_data/"
MARK_FILES = {"call": "call.csv", "put": "put.csv"}
_LOCAL_KEY = Path(__file__).resolve().parent.parent / "gcs-sa.json"


@lru_cache(maxsize=1)
def _client() -> storage.Client:
    """Use ADC on Cloud Run; fall back to repo-root gcs-sa.json for local testing."""
    env_key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if env_key and Path(env_key).is_file():
        return storage.Client.from_service_account_json(env_key)
    if _LOCAL_KEY.is_file():
        return storage.Client.from_service_account_json(str(_LOCAL_KEY))
    return storage.Client()


def _prefixes(bucket: storage.Bucket, prefix: str) -> list[str]:
    iterator = bucket.list_blobs(prefix=prefix, delimiter="/")
    # Prefixes are populated only after the iterator is consumed.
    list(iterator)
    names = []
    for raw in iterator.prefixes:
        name = raw[len(prefix):].rstrip("/")
        if name:
            names.append(name)
    return sorted(names)


def _resolve_name(names: list[str], symbol: str) -> str | None:
    for name in names:
        if name == symbol:
            return name
    lowered = symbol.lower()
    for name in names:
        if name.lower() == lowered:
            return name
    return None


def _timeframe_sort_key(timeframe: str) -> tuple[int, int, str]:
    match = re.fullmatch(r"(\d+)([a-zA-Z]+)", timeframe)
    if not match:
        return (1, 0, timeframe)
    unit_order = {"t": 0, "s": 1, "m": 2, "h": 3, "d": 4}
    return (0, int(match.group(1)) * 100 + unit_order.get(match.group(2).lower(), 99), timeframe)


def list_ohlcv_symbols() -> list[str]:
    return _prefixes(_client().bucket(BUCKET_NAME), OHLCV_PREFIX)


def list_trade_symbols() -> list[str]:
    return _prefixes(_client().bucket(BUCKET_NAME), TRADES_PREFIX)


def _continuous_symbol_from_name(name: str) -> str | None:
    filename = name.rsplit("/", 1)[-1]
    if not filename.lower().endswith(".csv") or "_" not in filename:
        return None
    prefix = filename.rsplit("_", 1)[0].lower()
    return "ES.FUT" if prefix == "es" else None


def list_continuous_symbols() -> list[str]:
    bucket = _client().bucket(BUCKET_NAME)
    symbols = {
        symbol
        for blob in bucket.list_blobs(prefix=CONTINUOUS_PREFIX)
        if (symbol := _continuous_symbol_from_name(blob.name))
    }
    return sorted(symbols)


def list_continuous_timeframes(symbol: str) -> list[str]:
    if symbol.lower() != "es.fut":
        return []
    bucket = _client().bucket(BUCKET_NAME)
    prefix = f"{CONTINUOUS_PREFIX}es_"
    timeframes = []
    for blob in bucket.list_blobs(prefix=prefix):
        filename = blob.name.rsplit("/", 1)[-1]
        if not filename.lower().endswith(".csv"):
            continue
        timeframes.append(filename[3:-4])
    return sorted(set(timeframes), key=_timeframe_sort_key)


def list_symbols() -> list[str]:
    return list_continuous_symbols()


def list_timeframes(symbol: str) -> list[str]:
    continuous = list_continuous_timeframes(symbol)
    if continuous:
        return continuous
    bucket = _client().bucket(BUCKET_NAME)
    resolved = _resolve_name(list_ohlcv_symbols(), symbol) or symbol
    return _prefixes(bucket, f"{OHLCV_PREFIX}{resolved}/")


@dataclass
class ObjectMeta:
    name: str
    generation: str
    updated: datetime
    size: int


def list_parquet_objects(symbol: str, timeframe: str) -> list[ObjectMeta]:
    bucket = _client().bucket(BUCKET_NAME)
    resolved = _resolve_name(list_ohlcv_symbols(), symbol) or symbol
    prefix = f"{OHLCV_PREFIX}{resolved}/{timeframe}/"
    return _list_parquets(bucket, prefix)


def list_trade_objects(symbol: str) -> list[ObjectMeta]:
    bucket = _client().bucket(BUCKET_NAME)
    resolved = _resolve_name(list_trade_symbols(), symbol)
    if not resolved:
        return []
    return _list_parquets(bucket, f"{TRADES_PREFIX}{resolved}/")


def _list_parquets(bucket: storage.Bucket, prefix: str) -> list[ObjectMeta]:
    out: list[ObjectMeta] = []
    for blob in bucket.list_blobs(prefix=prefix):
        if not blob.name.endswith(".parquet"):
            continue
        updated = blob.updated
        if updated is not None and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        out.append(
            ObjectMeta(
                name=blob.name,
                generation=str(blob.generation),
                updated=updated or datetime.now(timezone.utc),
                size=int(blob.size or 0),
            )
        )
    out.sort(key=lambda item: item.name)
    return out


def list_continuous_objects(symbol: str, timeframe: str) -> list[ObjectMeta]:
    if symbol.lower() != "es.fut":
        return []
    bucket = _client().bucket(BUCKET_NAME)
    target = f"{CONTINUOUS_PREFIX}es_{timeframe}.csv".lower()
    out = []
    for blob in bucket.list_blobs(prefix=f"{CONTINUOUS_PREFIX}es_"):
        if blob.name.lower() != target:
            continue
        updated = blob.updated
        if updated is not None and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        out.append(
            ObjectMeta(
                name=blob.name,
                generation=str(blob.generation),
                updated=updated or datetime.now(timezone.utc),
                size=int(blob.size or 0),
            )
        )
    return out


def _parse_csv_timestamp(values: pd.Series) -> pd.Series:
    if pd.api.types.is_numeric_dtype(values):
        numeric = values.dropna().abs()
        maximum = numeric.max() if not numeric.empty else 0
        unit = "ns" if maximum > 10**16 else "us" if maximum > 10**13 else "ms"
        parsed = pd.to_datetime(values, unit=unit, utc=True)
    else:
        parsed = pd.to_datetime(values, format="mixed", utc=True)
    return parsed.astype("datetime64[ns, UTC]")


def _normalize_continuous_csv(frame: pd.DataFrame, name: str) -> pd.DataFrame:
    frame.columns = [str(column).lower() for column in frame.columns]
    if "timestamp" not in frame.columns:
        raise ValueError(f"{name} must include a timestamp column")
    required = {"open", "high", "low", "close"}
    if not required.issubset(frame.columns):
        raise ValueError(
            f"{name} must include open, high, low, and close columns")
    if "volume" not in frame.columns:
        frame["volume"] = 0
    frame["timestamp"] = _parse_csv_timestamp(frame["timestamp"])
    for column in ("open", "high", "low", "close", "volume"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame.dropna(
        subset=["timestamp", "open", "high", "low", "close"]
    ).sort_values("timestamp").drop_duplicates(
        subset=["timestamp"], keep="last"
    ).reset_index(drop=True)[
        ["timestamp", "open", "high", "low", "close", "volume"]
    ]


def _normalize_mark_csv(frame: pd.DataFrame, name: str) -> pd.DataFrame:
    frame.columns = [str(column).lower() for column in frame.columns]
    timestamp_column = next(
        (column for column in ("timestamp", "ts_event", "ts_recv", "datetime", "time")
         if column in frame.columns),
        None,
    )
    mark_column = next(
        (column for column in ("mark_price", "mark", "price", "close")
         if column in frame.columns),
        None,
    )
    if timestamp_column is None or mark_column is None:
        raise ValueError(
            f"{name} must include a timestamp and mark price column")
    result = frame.rename(
        columns={timestamp_column: "timestamp", mark_column: "mark_price"}
    )[["timestamp", "mark_price"]].copy()
    result["timestamp"] = _parse_csv_timestamp(result["timestamp"])
    result["mark_price"] = pd.to_numeric(result["mark_price"], errors="coerce")
    return result.dropna().sort_values("timestamp").drop_duplicates(
        subset=["timestamp"], keep="last"
    ).reset_index(drop=True)


def _load_mark_csv(kind: str) -> tuple[pd.DataFrame, str, datetime | None]:
    bucket = _client().bucket(BUCKET_NAME)
    name = MARK_FILES[kind]
    blobs = list(bucket.list_blobs(prefix=name))
    blob = next((item for item in blobs if item.name == name), None)
    if blob is None:
        return pd.DataFrame(columns=["timestamp", "mark_price"]), "", None
    frame = pd.read_csv(io.BytesIO(blob.download_as_bytes()))
    updated = blob.updated or datetime.now(timezone.utc)
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return _normalize_mark_csv(frame, name), f"{name}:{blob.generation}", updated


def _mark_fingerprint() -> str:
    bucket = _client().bucket(BUCKET_NAME)
    parts = []
    for kind in ("call", "put"):
        name = MARK_FILES[kind]
        blob = next((item for item in bucket.list_blobs(
            prefix=name) if item.name == name), None)
        if blob is not None:
            parts.append(f"{name}:{blob.generation}")
    return "|".join(parts)


def load_continuous(
    symbol: str,
    timeframe: str,
    on_file: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_continuous_objects(symbol, timeframe)
    if not objects:
        return pd.DataFrame(
            columns=["timestamp", "open", "high", "low", "close", "volume"]
        ), "", None
    bucket = _client().bucket(BUCKET_NAME)
    obj = objects[0]
    if on_file is not None:
        on_file(0, 1, obj.name)
    frame = pd.read_csv(io.BytesIO(bucket.blob(obj.name).download_as_bytes()))
    frame = _normalize_continuous_csv(frame, obj.name)
    if on_file is not None:
        on_file(1, 1, obj.name)
    return frame, f"{obj.name}:{obj.generation}", obj.updated


def has_ohlcv(symbol: str, timeframe: str) -> bool:
    return bool(list_parquet_objects(symbol, timeframe))


def fingerprint(symbol: str, timeframe: str, source: str | None = None) -> str:
    if source == "continuous":
        objects = list_continuous_objects(symbol, timeframe)
    else:
        use_trades = source == "trades" or (
            source != "ohlcv" and not has_ohlcv(symbol, timeframe))
        objects = list_trade_objects(
            symbol) if use_trades else list_parquet_objects(symbol, timeframe)
    if not objects:
        return ""
    result = "|".join(f"{item.name}:{item.generation}" for item in objects)
    return f"{result}|{_mark_fingerprint()}" if source == "continuous" else result


@dataclass
class ProgressClock:
    on_progress: ProgressFn | None = None
    timeframe: str = ""
    source: str = ""
    started: float = field(default_factory=time.perf_counter)

    def emit(
        self,
        pct: float,
        message: str,
        *,
        stage: str = "",
        done: int = 0,
        total: int = 0,
        extra: dict | None = None,
    ) -> None:
        if self.on_progress is None:
            return
        elapsed = time.perf_counter() - self.started
        pct = max(0.0, min(99.0, float(pct)))
        eta = None
        if pct > 2.0 and elapsed > 0.25:
            eta = (100.0 - pct) * (elapsed / pct)
        payload = {
            "type": "progress",
            "pct": round(pct, 1),
            "elapsed_s": round(elapsed, 1),
            "eta_s": None if eta is None else round(eta, 1),
            "done": int(done),
            "total": int(total),
            "stage": stage,
            "message": message,
            "timeframe": self.timeframe,
            "source": self.source,
        }
        if extra:
            payload.update(extra)
        self.on_progress(payload)


def _download_parquet(blob: storage.Blob) -> pd.DataFrame:
    raw = blob.download_as_bytes()
    table = pq.read_table(io.BytesIO(raw))
    frame = table.to_pandas()
    frame.attrs["gcs_name"] = blob.name
    return frame


def _file_label(name: str) -> str:
    return name.rsplit("/", 1)[-1]


def _concat_parquets(
    objects: list[ObjectMeta],
    on_file: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    if not objects:
        empty = pd.DataFrame()
        return empty, "", None
    bucket = _client().bucket(BUCKET_NAME)
    blobs = [bucket.blob(item.name) for item in objects]
    frames: list[pd.DataFrame | None] = [None] * len(blobs)
    with ThreadPoolExecutor(max_workers=min(8, len(blobs))) as pool:
        futures = {pool.submit(_download_parquet, blob): i for i, blob in enumerate(blobs)}
        finished = 0
        for fut in as_completed(futures):
            idx = futures[fut]
            frames[idx] = fut.result()
            finished += 1
            if on_file is not None:
                on_file(finished, len(blobs), objects[idx].name)
    ready = [frame for frame in frames if frame is not None]
    if len(ready) != len(frames):
        raise RuntimeError("Failed to download one or more parquet files")
    data = pd.concat(ready, ignore_index=True)
    fp = "|".join(f"{item.name}:{item.generation}" for item in objects)
    latest = max(item.updated for item in objects)
    return data, fp, latest


def load_ohlcv(
    symbol: str,
    timeframe: str,
    on_file: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_parquet_objects(symbol, timeframe)
    if not objects:
        empty = pd.DataFrame(
            columns=["timestamp", "open", "high", "low", "close", "volume"])
        return empty, "", None
    data, fp, latest = _concat_parquets(objects, on_file=on_file)
    if "timestamp" not in data.columns:
        raise ValueError("parquet files must include a timestamp column")
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True)
    data = data.sort_values("timestamp").drop_duplicates(
        subset=["timestamp"], keep="last")
    data = data.reset_index(drop=True)
    return data, fp, latest


def load_trades(
    symbol: str,
    on_file: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_trade_objects(symbol)
    if not objects:
        empty = pd.DataFrame(columns=["timestamp", "price", "size"])
        return empty, "", None
    data, fp, latest = _concat_parquets(objects, on_file=on_file)
    return data, fp, latest


@dataclass
class CacheEntry:
    frame: pd.DataFrame
    fingerprint: str
    updated: datetime | None
    loaded_at: datetime
    source: str = "ohlcv"
    path: str = ""


@dataclass
class OhlcvStore:
    _lock: Lock = field(default_factory=Lock)
    _ohlcv: dict[tuple[str, str], CacheEntry] = field(default_factory=dict)
    _trades: dict[str, CacheEntry] = field(default_factory=dict)
    _agg: dict[tuple[str, str], CacheEntry] = field(default_factory=dict)
    _continuous: dict[tuple[str, str], CacheEntry] = field(
        default_factory=dict)
    _marks: tuple[pd.DataFrame, pd.DataFrame, str] | None = None

    def get_mark_prices(
        self,
        refresh: bool = False,
    ) -> tuple[pd.DataFrame, pd.DataFrame, str]:
        if self._marks is not None and not refresh:
            return self._marks
        call, call_fp, _ = _load_mark_csv("call")
        put, put_fp, _ = _load_mark_csv("put")
        result = (call, put, f"{call_fp}|{put_fp}")
        self._marks = result
        return result

    def get(
        self,
        symbol: str,
        timeframe: str,
        refresh: bool = False,
        progress: ProgressClock | None = None,
        source: str | None = None,
    ) -> CacheEntry:
        clock = progress or ProgressClock(timeframe=timeframe)
        clock.timeframe = timeframe
        clock.emit(1, f"Looking up {symbol}/{timeframe}", stage="lookup")
        if source == "continuous":
            clock.source = "continuous"
            entry = self._get_continuous(symbol, timeframe, refresh, clock)
            attach_source_mas(entry.frame)
            return entry
        use_trades = source == "trades" or (
            source != "ohlcv" and not has_ohlcv(symbol, timeframe)
        )
        if use_trades:
            clock.source = "trades"
            entry = self._get_aggregated(symbol, timeframe, refresh, clock)
        else:
            clock.source = "ohlcv"
            if source == "ohlcv" and not has_ohlcv(symbol, timeframe):
                raise FileNotFoundError(f"No ohlcv/{symbol}/{timeframe}")
            entry = self._get_ohlcv(symbol, timeframe, refresh, clock)
        attach_source_mas(entry.frame)
        return entry

    def peek(self, symbol: str, timeframe: str, source: str | None = None) -> CacheEntry | None:
        with self._lock:
            if source == "continuous":
                return self._continuous.get((symbol, timeframe))
            if source == "trades":
                return self._agg.get((symbol, timeframe))
            if source == "ohlcv":
                return self._ohlcv.get((symbol, timeframe))
            return self._ohlcv.get((symbol, timeframe)) or self._agg.get((symbol, timeframe))

    def _get_continuous(
        self,
        symbol: str,
        timeframe: str,
        refresh: bool,
        progress: ProgressClock | None = None,
    ) -> CacheEntry:
        key = (symbol, timeframe)
        with self._lock:
            cached = self._continuous.get(key)
        if not refresh and cached is not None:
            if progress is not None:
                progress.emit(
                    75, f"Using cached {timeframe} ({len(cached.frame):,} bars)", stage="cache")
            return cached
        if progress is not None:
            progress.emit(
                5, f"Reading continuous_data/{timeframe}", stage="lookup")
        frame, fp, updated = load_continuous(
            symbol, timeframe,
            on_file=(
                lambda done, total, name: progress.emit(
                    8 + 65 * done / max(total, 1),
                    f"Downloading {_file_label(name)} ({done}/{total})",
                    stage="download", done=done, total=total,
                )
                if progress is not None else None
            ),
        )
        if frame.empty:
            raise FileNotFoundError(
                f"No continuous_data/{symbol}_{timeframe}.csv")
        if progress is not None:
            progress.emit(
                78, f"Loaded {len(frame):,} {timeframe} bars", stage="prepare")
        entry = CacheEntry(
            frame=frame,
            fingerprint=fp,
            updated=updated,
            loaded_at=datetime.now(timezone.utc),
            source="continuous",
            path=f"{CONTINUOUS_PREFIX}es_{timeframe}.csv",
        )
        with self._lock:
            self._continuous[key] = entry
        return entry

    def _get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        refresh: bool,
        progress: ProgressClock | None = None,
    ) -> CacheEntry:
        key = (symbol, timeframe)
        with self._lock:
            cached = self._ohlcv.get(key)
        if not refresh and cached is not None:
            if progress is not None:
                progress.emit(
                    75, f"Using cached {timeframe}", stage="cache", done=1, total=1)
            return cached

        def on_file(done: int, total: int, name: str) -> None:
            if progress is None:
                return
            pct = 8 + 62 * done / max(total, 1)
            progress.emit(
                pct,
                f"Downloading {_file_label(name)} ({done}/{total})",
                stage="download",
                done=done,
                total=total,
            )

        if progress is not None:
            progress.emit(
                5, f"Listing ohlcv for {symbol}/{timeframe}", stage="lookup")
        frame, fp, updated = load_ohlcv(symbol, timeframe, on_file=on_file)
        if progress is not None:
            progress.emit(78, f"Loaded {len(frame):,} bars", stage="prepare")
        frame = attach_source_mas(frame)
        resolved = _resolve_name(list_ohlcv_symbols(), symbol) or symbol
        entry = CacheEntry(
            frame=frame,
            fingerprint=fp,
            updated=updated,
            loaded_at=datetime.now(timezone.utc),
            source="ohlcv",
            path=f"ohlcv/{resolved}/{timeframe}",
        )
        with self._lock:
            self._ohlcv[key] = entry
        return entry

    def _get_trades(
        self,
        symbol: str,
        refresh: bool,
        progress: ProgressClock | None = None,
    ) -> CacheEntry:
        with self._lock:
            cached = self._trades.get(symbol)
        if not refresh and cached is not None:
            if progress is not None:
                progress.emit(
                    46,
                    f"Using cached trades ({len(cached.frame):,} ticks)",
                    stage="cache",
                )
            return cached

        def on_file(done: int, total: int, name: str) -> None:
            if progress is None:
                return
            pct = 8 + 38 * done / max(total, 1)
            progress.emit(
                pct,
                f"Downloading trades {_file_label(name)} ({done}/{total})",
                stage="download",
                done=done,
                total=total,
            )

        if progress is not None:
            progress.emit(4, f"Listing trades for {symbol}", stage="lookup")
        frame, fp, updated = load_trades(symbol, on_file=on_file)
        resolved = _resolve_name(list_trade_symbols(), symbol) or symbol
        if progress is not None:
            progress.emit(48, f"Loaded {len(frame):,} trades", stage="prepare")
        entry = CacheEntry(
            frame=frame,
            fingerprint=fp,
            updated=updated,
            loaded_at=datetime.now(timezone.utc),
            source="trades",
            path=f"trades/{resolved}",
        )
        with self._lock:
            self._trades[symbol] = entry
        return entry

    def _get_aggregated(
        self,
        symbol: str,
        timeframe: str,
        refresh: bool,
        progress: ProgressClock | None = None,
    ) -> CacheEntry:
        trades = self._get_trades(symbol, refresh, progress)
        key = (symbol, timeframe)
        with self._lock:
            cached = self._agg.get(key)
        if (
            not refresh
            and cached is not None
            and cached.fingerprint == trades.fingerprint
        ):
            if progress is not None:
                progress.emit(
                    75,
                    f"Using cached {timeframe} aggregate ({len(cached.frame):,} bars)",
                    stage="cache",
                )
            return cached
        if trades.frame.empty:
            raise FileNotFoundError(
                f"No ohlcv/{symbol}/{timeframe} and no trades for {symbol}"
            )

        def on_agg(message: str, frac: float) -> None:
            if progress is not None:
                progress.emit(50 + 28 * frac, message, stage="aggregate")

        if progress is not None:
            progress.emit(
                50,
                f"Aggregating {len(trades.frame):,} trades to {timeframe}",
                stage="aggregate",
            )
        frame = aggregate_trades(trades.frame, timeframe, on_progress=on_agg)
        if progress is not None:
            progress.emit(
                80, f"Built {len(frame):,} {timeframe} bars", stage="aggregate")
        entry = CacheEntry(
            frame=frame,
            fingerprint=trades.fingerprint,
            updated=trades.updated,
            loaded_at=datetime.now(timezone.utc),
            source="trades",
            path=f"{trades.path} → {timeframe}",
        )
        with self._lock:
            self._agg[key] = entry
        return entry
