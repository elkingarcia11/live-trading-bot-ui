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

from backend.aggregate import aggregate_ohlcv, aggregate_trades, attach_source_mas, parse_spec
import pandas as pd
import pyarrow.parquet as pq
from google.api_core.exceptions import NotFound
from google.cloud import storage

ProgressFn = Callable[[dict], None]

BUCKET_NAME = os.environ.get("GCS_BUCKET", "live-trading-bot")
OHLCV_PREFIX = "ohlcv/"
TRADES_PREFIX = "trades/"
CONTINUOUS_PREFIX = "continuous_data/"
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
    if not filename.lower().endswith(".csv"):
        return None
    stem = filename[:-4].lower()
    if stem == "es":
        return "ES.FUT"
    if "_" not in filename:
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
        if filename.lower() == "es.csv" or "_" not in filename:
            continue
        spec = filename[3:-4]
        if spec:
            timeframes.append(spec)
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


def list_continuous_base_objects(symbol: str) -> list[ObjectMeta]:
    if symbol.lower() != "es.fut":
        return []
    bucket = _client().bucket(BUCKET_NAME)
    out = []
    for blob in bucket.list_blobs(prefix=f"{CONTINUOUS_PREFIX}es"):
        filename = blob.name.rsplit("/", 1)[-1]
        if filename.lower() != "es.csv":
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


def has_continuous_base(symbol: str) -> bool:
    return bool(list_continuous_base_objects(symbol))


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


def _load_continuous_objects(
    objects: list[ObjectMeta],
    on_file: Callable[[int, int, str], None] | None = None,
    on_bytes: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    if not objects:
        return pd.DataFrame(
            columns=["timestamp", "open", "high", "low", "close", "volume"]
        ), "", None
    bucket = _client().bucket(BUCKET_NAME)
    obj = objects[0]
    if on_file is not None:
        on_file(0, 1, obj.name)
    total = max(int(obj.size or 0), 0)
    raw = _chunked_download(
        bucket.blob(obj.name),
        on_delta=(lambda done: on_bytes(done, total, obj.name))
        if on_bytes is not None
        else None,
        refresh_blob=lambda: bucket.blob(obj.name),
    )
    frame = pd.read_csv(io.BytesIO(raw))
    frame = _normalize_continuous_csv(frame, obj.name)
    if on_file is not None:
        on_file(1, 1, obj.name)
    return frame, f"{obj.name}:{obj.generation}", obj.updated


def load_continuous(
    symbol: str,
    timeframe: str,
    on_file: Callable[[int, int, str], None] | None = None,
    on_bytes: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    return _load_continuous_objects(
        list_continuous_objects(symbol, timeframe),
        on_file=on_file,
        on_bytes=on_bytes,
    )


def load_continuous_base(
    symbol: str,
    on_file: Callable[[int, int, str], None] | None = None,
    on_bytes: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_continuous_base_objects(symbol)
    if not objects:
        return pd.DataFrame(
            columns=["timestamp", "price", "size"]
        ), "", None
    bucket = _client().bucket(BUCKET_NAME)
    obj = objects[0]
    if on_file is not None:
        on_file(0, 1, obj.name)
    total = max(int(obj.size or 0), 0)
    raw = _chunked_download(
        bucket.blob(obj.name),
        on_delta=(lambda done: on_bytes(done, total, obj.name))
        if on_bytes is not None
        else None,
        refresh_blob=lambda: bucket.blob(obj.name),
    )
    frame = pd.read_csv(io.BytesIO(raw))
    frame = _normalize_continuous_source(frame, obj.name)
    if on_file is not None:
        on_file(1, 1, obj.name)
    return frame, f"{obj.name}:{obj.generation}", obj.updated


def _normalize_continuous_source(frame: pd.DataFrame, name: str) -> pd.DataFrame:
    """Accept either OHLCV bars or tick rows (timestamp + price)."""
    frame.columns = [str(column).lower() for column in frame.columns]
    if {"open", "high", "low", "close"}.issubset(frame.columns):
        return _normalize_continuous_csv(frame, name)
    if "timestamp" not in frame.columns or "price" not in frame.columns:
        raise ValueError(
            f"{name} must include open/high/low/close or timestamp and price"
        )
    frame["timestamp"] = _parse_csv_timestamp(frame["timestamp"])
    frame["price"] = pd.to_numeric(frame["price"], errors="coerce")
    if "size" in frame.columns:
        frame["size"] = pd.to_numeric(frame["size"], errors="coerce")
    elif "volume" in frame.columns:
        frame["size"] = pd.to_numeric(frame["volume"], errors="coerce")
    keep = [column for column in ("timestamp", "price", "size", "action") if column in frame.columns]
    return frame.dropna(subset=["timestamp", "price"]).sort_values(
        "timestamp"
    ).reset_index(drop=True)[keep]


def has_ohlcv(symbol: str, timeframe: str) -> bool:
    return bool(list_parquet_objects(symbol, timeframe))


def fingerprint(symbol: str, timeframe: str, source: str | None = None) -> str:
    if source == "continuous":
        objects = list_continuous_objects(symbol, timeframe)
        if not objects:
            objects = list_continuous_base_objects(symbol)
    else:
        use_trades = source == "trades" or (
            source != "ohlcv" and not has_ohlcv(symbol, timeframe))
        objects = list_trade_objects(
            symbol) if use_trades else list_parquet_objects(symbol, timeframe)
    if not objects:
        return ""
    return "|".join(f"{item.name}:{item.generation}" for item in objects)


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


_DOWNLOAD_CHUNK = 1 << 20  # 1 MiB


def _fmt_bytes(n: int | float) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def _chunked_download(
    blob: storage.Blob,
    on_delta: Callable[[int], None] | None = None,
    chunk_size: int = _DOWNLOAD_CHUNK,
    refresh_blob: Callable[[], storage.Blob] | None = None,
    attempts: int = 3,
) -> bytes:
    """Stream a blob in chunks, reporting cumulative bytes via ``on_delta``.

    The storage client pins the object generation on the first chunk, so if
    the pipeline replaces the object mid-transfer the remaining chunks 404.
    In that case the whole transfer restarts against a fresh handle, yielding
    a consistent snapshot of whichever generation is current.
    """
    for attempt in range(attempts):
        buffer = bytearray()
        try:
            with blob.open("rb", chunk_size=chunk_size) as reader:
                while True:
                    chunk = reader.read(chunk_size)
                    if not chunk:
                        return bytes(buffer)
                    buffer += chunk
                    if on_delta is not None:
                        on_delta(len(buffer))
        except NotFound:
            if refresh_blob is None or attempt + 1 >= attempts:
                raise
            blob = refresh_blob()
    raise RuntimeError("unreachable")  # pragma: no cover


def _download_parquet(
    blob: storage.Blob,
    on_delta: Callable[[int], None] | None = None,
    refresh_blob: Callable[[], storage.Blob] | None = None,
) -> pd.DataFrame:
    raw = _chunked_download(blob, on_delta=on_delta, refresh_blob=refresh_blob)
    table = pq.read_table(io.BytesIO(raw))
    frame = table.to_pandas()
    frame.attrs["gcs_name"] = blob.name
    return frame


def _file_label(name: str) -> str:
    return name.rsplit("/", 1)[-1]


def _download_callbacks(
    progress: ProgressClock | None,
    lo: float,
    span: float,
    prefix: str = "",
) -> tuple[
    Callable[[int, int, str], None] | None,
    Callable[[int, int, str], None] | None,
]:
    """Build download-stage callbacks mapped onto the [lo, lo + span] % band.

    ``on_bytes(done, total, name)`` receives cumulative downloaded bytes and
    drives the percentage so it tracks real transfer volume. ``on_file`` fires
    once per completed file; it refreshes the status message but never moves
    the percentage backwards. Non-final emits are throttled to ~5/s.
    """
    if progress is None:
        return None, None
    floor = {"pct": lo}
    last = {"t": 0.0}

    def on_file(done: int, total: int, name: str) -> None:
        now = time.perf_counter()
        if done < total and now - last["t"] < 0.2:
            return
        last["t"] = now
        progress.emit(
            floor["pct"],
            f"{prefix}{_file_label(name)} ({done}/{total})",
            stage="download",
            done=done,
            total=total,
        )

    def on_bytes(done: int, total: int, name: str) -> None:
        # The pipeline can append rows between listing and download, so the
        # transferred size may exceed the stale listed size; clamp for display.
        if total > 0:
            done = min(done, total)
        pct = lo + span * done / max(total, 1)
        if pct > floor["pct"]:
            floor["pct"] = pct
        now = time.perf_counter()
        if done < total and now - last["t"] < 0.2:
            return
        last["t"] = now
        progress.emit(
            floor["pct"],
            f"{prefix}{_file_label(name)} · {_fmt_bytes(done)} / {_fmt_bytes(total)}",
            stage="download",
            done=done,
            total=total,
        )

    return on_file, on_bytes


def _concat_parquets(
    objects: list[ObjectMeta],
    on_file: Callable[[int, int, str], None] | None = None,
    on_bytes: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    if not objects:
        empty = pd.DataFrame()
        return empty, "", None
    bucket = _client().bucket(BUCKET_NAME)
    blobs = [bucket.blob(item.name) for item in objects]
    frames: list[pd.DataFrame | None] = [None] * len(blobs)
    total_bytes = sum(max(int(item.size or 0), 0) for item in objects)
    progress_by_index = [0] * len(objects)
    lock = Lock()

    def download(index: int) -> None:
        meta = objects[index]

        def on_delta(cumulative: int) -> None:
            if on_bytes is None:
                return
            with lock:
                # Absolute per-file progress: a mid-stream retry resets the
                # file's counter, and the sum must reflect that.
                progress_by_index[index] = cumulative
                overall = sum(progress_by_index)
            on_bytes(overall, total_bytes, meta.name)

        frames[index] = _download_parquet(
            blobs[index],
            on_delta=on_delta,
            refresh_blob=lambda: bucket.blob(meta.name),
        )

    with ThreadPoolExecutor(max_workers=min(8, len(blobs))) as pool:
        futures = {pool.submit(download, i): i for i in range(len(blobs))}
        finished = 0
        for fut in as_completed(futures):
            idx = futures[fut]
            fut.result()
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
    on_bytes: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_parquet_objects(symbol, timeframe)
    if not objects:
        empty = pd.DataFrame(
            columns=["timestamp", "open", "high", "low", "close", "volume"])
        return empty, "", None
    data, fp, latest = _concat_parquets(
        objects, on_file=on_file, on_bytes=on_bytes
    )
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
    on_bytes: Callable[[int, int, str], None] | None = None,
) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_trade_objects(symbol)
    if not objects:
        empty = pd.DataFrame(columns=["timestamp", "price", "size"])
        return empty, "", None
    data, fp, latest = _concat_parquets(
        objects, on_file=on_file, on_bytes=on_bytes
    )
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
    _continuous_base: dict[str, CacheEntry] = field(default_factory=dict)
    _continuous_base_locks: dict[str, Lock] = field(default_factory=dict)

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
        on_file, on_bytes = _download_callbacks(progress, 8.0, 65.0)
        frame, fp, updated = load_continuous(
            symbol, timeframe, on_file=on_file, on_bytes=on_bytes
        )
        if not frame.empty:
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
        return self._aggregate_continuous(symbol, timeframe, refresh, progress)

    def _base_lock(self, symbol: str) -> Lock:
        with self._lock:
            lock = self._continuous_base_locks.get(symbol)
            if lock is None:
                lock = Lock()
                self._continuous_base_locks[symbol] = lock
            return lock

    def _get_continuous_base(
        self,
        symbol: str,
        refresh: bool,
        progress: ProgressClock | None = None,
    ) -> CacheEntry:
        with self._base_lock(symbol):
            with self._lock:
                cached = self._continuous_base.get(symbol)
            if cached is not None:
                if not refresh:
                    if progress is not None:
                        progress.emit(
                            46,
                            f"Using cached es.csv ({len(cached.frame):,} bars)",
                            stage="cache",
                        )
                    return cached
                objects = list_continuous_base_objects(symbol)
                current_fp = "|".join(
                    f"{item.name}:{item.generation}" for item in objects
                )
                if current_fp and current_fp == cached.fingerprint:
                    if progress is not None:
                        progress.emit(
                            46,
                            f"Using cached es.csv ({len(cached.frame):,} bars)",
                            stage="cache",
                        )
                    return cached
            if progress is not None:
                progress.emit(5, "Reading continuous_data/es.csv", stage="lookup")
            on_file, on_bytes = _download_callbacks(
                progress, 8.0, 38.0, prefix="Downloading "
            )
            frame, fp, updated = load_continuous_base(
                symbol, on_file=on_file, on_bytes=on_bytes
            )
            if frame.empty:
                raise FileNotFoundError(f"No continuous_data/es.csv for {symbol}")
            if progress is not None:
                progress.emit(
                    48, f"Loaded {len(frame):,} es.csv bars", stage="prepare")
            entry = CacheEntry(
                frame=frame,
                fingerprint=fp,
                updated=updated,
                loaded_at=datetime.now(timezone.utc),
                source="continuous",
                path=f"{CONTINUOUS_PREFIX}es.csv",
            )
            with self._lock:
                self._continuous_base[symbol] = entry
            return entry

    def _aggregate_continuous(
        self,
        symbol: str,
        timeframe: str,
        refresh: bool,
        progress: ProgressClock | None = None,
    ) -> CacheEntry:
        parse_spec(timeframe)
        base = self._get_continuous_base(symbol, refresh, progress)
        key = (symbol, timeframe)
        with self._lock:
            cached = self._continuous.get(key)
        if cached is not None and cached.fingerprint == base.fingerprint:
            if progress is not None:
                progress.emit(
                    75,
                    f"Using cached {timeframe} aggregate ({len(cached.frame):,} bars)",
                    stage="cache",
                )
            return cached

        def on_agg(message: str, frac: float) -> None:
            if progress is not None:
                progress.emit(50 + 28 * frac, message, stage="aggregate")

        if progress is not None:
            progress.emit(
                50,
                f"Aggregating es.csv ({len(base.frame):,} rows) to {timeframe}",
                stage="aggregate",
            )
        if {"open", "high", "low", "close"}.issubset(base.frame.columns):
            frame = aggregate_ohlcv(base.frame, timeframe, on_progress=on_agg)
        else:
            frame = aggregate_trades(base.frame, timeframe, on_progress=on_agg)
        if frame.empty:
            raise FileNotFoundError(
                f"No bars after aggregating continuous_data/es.csv to {timeframe}"
            )
        if progress is not None:
            progress.emit(
                80, f"Built {len(frame):,} {timeframe} bars from es.csv", stage="aggregate")
        entry = CacheEntry(
            frame=frame,
            fingerprint=base.fingerprint,
            updated=base.updated,
            loaded_at=datetime.now(timezone.utc),
            source="continuous",
            path=f"{CONTINUOUS_PREFIX}es.csv → {timeframe}",
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

        on_file, on_bytes = _download_callbacks(progress, 8.0, 62.0)
        if progress is not None:
            progress.emit(
                5, f"Listing ohlcv for {symbol}/{timeframe}", stage="lookup")
        frame, fp, updated = load_ohlcv(
            symbol, timeframe, on_file=on_file, on_bytes=on_bytes
        )
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

        on_file, on_bytes = _download_callbacks(
            progress, 8.0, 38.0, prefix="Downloading trades "
        )
        if progress is not None:
            progress.emit(4, f"Listing trades for {symbol}", stage="lookup")
        frame, fp, updated = load_trades(
            symbol, on_file=on_file, on_bytes=on_bytes
        )
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
