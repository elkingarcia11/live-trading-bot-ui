"""GCS helpers for gs://live-trading-bot/ohlcv/{symbol}/{timeframe}/{date}.parquet."""

from __future__ import annotations

import io
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from threading import Lock

import pandas as pd
import pyarrow.parquet as pq
from google.cloud import storage

BUCKET_NAME = os.environ.get("GCS_BUCKET", "live-trading-bot")
OHLCV_PREFIX = "ohlcv/"
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
        name = raw[len(prefix) :].rstrip("/")
        if name:
            names.append(name)
    return sorted(names)


def list_symbols() -> list[str]:
    bucket = _client().bucket(BUCKET_NAME)
    return _prefixes(bucket, OHLCV_PREFIX)


def list_timeframes(symbol: str) -> list[str]:
    bucket = _client().bucket(BUCKET_NAME)
    return _prefixes(bucket, f"{OHLCV_PREFIX}{symbol}/")


@dataclass
class ObjectMeta:
    name: str
    generation: str
    updated: datetime
    size: int


def list_parquet_objects(symbol: str, timeframe: str) -> list[ObjectMeta]:
    bucket = _client().bucket(BUCKET_NAME)
    prefix = f"{OHLCV_PREFIX}{symbol}/{timeframe}/"
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


def fingerprint(symbol: str, timeframe: str) -> str:
    objects = list_parquet_objects(symbol, timeframe)
    if not objects:
        return ""
    return "|".join(f"{item.name}:{item.generation}" for item in objects)


def _download_parquet(blob: storage.Blob) -> pd.DataFrame:
    raw = blob.download_as_bytes()
    table = pq.read_table(io.BytesIO(raw))
    frame = table.to_pandas()
    frame.attrs["gcs_name"] = blob.name
    return frame


def load_ohlcv(symbol: str, timeframe: str) -> tuple[pd.DataFrame, str, datetime | None]:
    objects = list_parquet_objects(symbol, timeframe)
    if not objects:
        empty = pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
        return empty, "", None

    bucket = _client().bucket(BUCKET_NAME)
    blobs = [bucket.blob(item.name) for item in objects]
    with ThreadPoolExecutor(max_workers=min(8, len(blobs))) as pool:
        frames = list(pool.map(_download_parquet, blobs))

    data = pd.concat(frames, ignore_index=True)
    if "timestamp" not in data.columns:
        raise ValueError("parquet files must include a timestamp column")
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True)
    data = data.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="last")
    data = data.reset_index(drop=True)
    fp = "|".join(f"{item.name}:{item.generation}" for item in objects)
    latest = max(item.updated for item in objects)
    return data, fp, latest


@dataclass
class CacheEntry:
    frame: pd.DataFrame
    fingerprint: str
    updated: datetime | None
    loaded_at: datetime


@dataclass
class OhlcvStore:
    _lock: Lock = field(default_factory=Lock)
    _entries: dict[tuple[str, str], CacheEntry] = field(default_factory=dict)

    def get(
        self, symbol: str, timeframe: str, refresh: bool = False
    ) -> CacheEntry:
        key = (symbol, timeframe)
        with self._lock:
            cached = self._entries.get(key)
        if refresh or cached is None:
            frame, fp, updated = load_ohlcv(symbol, timeframe)
            entry = CacheEntry(
                frame=frame,
                fingerprint=fp,
                updated=updated,
                loaded_at=datetime.now(timezone.utc),
            )
            with self._lock:
                self._entries[key] = entry
            return entry
        return cached

    def peek(self, symbol: str, timeframe: str) -> CacheEntry | None:
        with self._lock:
            return self._entries.get((symbol, timeframe))
