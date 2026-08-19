"""Load Databento GLBX.MDP3 trade dumps into RTH front-month ES prints."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from backend.session import filter_rth

CACHE_VERSION = 1
CACHE_KEY = "rth_0930_1600_et_front_month"
_USECOLS = ["ts_event", "action", "price", "size", "symbol"]


def cache_dir_for(root: Path, results_root: Path) -> Path:
    return results_root / "cache" / root.name


def trade_files(root: Path) -> list[Path]:
    return sorted(root.glob("*.trades.csv.zst"))


def load_glbx_trades(
    root: Path,
    cache_dir: Path,
    on_progress=None,
) -> pd.DataFrame:
    """Return front-month RTH trades, building parquet caches as needed.

    Reads one weekly zst at a time so peak RAM stays near a single file.
    """
    root = Path(root)
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    trades_path = cache_dir / "trades.parquet"
    manifest_path = cache_dir / "manifest.json"
    expected = _source_fingerprint(root)
    if trades_path.exists() and _manifest_matches(manifest_path, expected):
        _note(on_progress, f"Cache hit {trades_path}")
        return pd.read_parquet(trades_path)

    files = trade_files(root)
    if not files:
        raise FileNotFoundError(f"No *.trades.csv.zst in {root}")

    chunk_dir = cache_dir / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    chunk_paths: list[Path] = []
    daily_parts: list[pd.DataFrame] = []
    for index, path in enumerate(files, start=1):
        chunk_path = chunk_dir / f"{path.name.replace('.csv.zst', '')}.parquet"
        _note(on_progress, f"Loading {path.name} ({index}/{len(files)})")
        if chunk_path.exists():
            vol = _daily_volume_from_parquet(chunk_path)
        else:
            frame = _read_trade_file(path)
            frame.to_parquet(chunk_path, index=False)
            vol = _daily_volume(frame)
            del frame
        chunk_paths.append(chunk_path)
        if not vol.empty:
            daily_parts.append(vol)

    if not daily_parts:
        raise LookupError(f"No outright ES trades in {root}")

    daily = pd.concat(daily_parts, ignore_index=True)
    daily = daily.groupby(["et_date", "symbol"], as_index=False, sort=False)["size"].sum()
    rolls = (
        daily.sort_values(["et_date", "size", "symbol"], ascending=[True, False, False])
        .drop_duplicates("et_date", keep="first")
        .set_index("et_date")["symbol"]
        .to_dict()
    )
    (cache_dir / "rolls.json").write_text(
        json.dumps({str(k): v for k, v in rolls.items()}, indent=2) + "\n"
    )

    parts: list[pd.DataFrame] = []
    for index, chunk_path in enumerate(chunk_paths, start=1):
        _note(on_progress, f"Stitching front month ({index}/{len(chunk_paths)})")
        frame = pd.read_parquet(chunk_path)
        et_date = frame["timestamp"].dt.tz_convert("America/New_York").dt.strftime("%Y-%m-%d")
        front = et_date.map(rolls)
        keep = front.notna() & (frame["symbol"].astype(str) == front.astype(str))
        frame = frame.loc[keep]
        if not frame.empty:
            parts.append(frame[["timestamp", "price", "size"]])
        del frame

    trades = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(
        columns=["timestamp", "price", "size"]
    )
    del parts
    trades = trades.sort_values("timestamp").reset_index(drop=True)
    before = len(trades)
    trades = filter_rth(trades)
    _note(on_progress, f"RTH 9:30–4:00 ET: {len(trades):,} of {before:,} front-month trades")
    trades.to_parquet(trades_path, index=False)
    bars_dir = cache_dir / "bars"
    if bars_dir.exists():
        for stale in bars_dir.glob("*.parquet"):
            stale.unlink()
    manifest_path.write_text(json.dumps(expected, indent=2) + "\n")
    return trades


def load_or_build_bars(
    trades: pd.DataFrame | None,
    spec: str,
    cache_dir: Path,
    load_trades,
    on_progress=None,
) -> pd.DataFrame:
    from backend.aggregate import aggregate_trades

    bars_dir = Path(cache_dir) / "bars"
    bars_dir.mkdir(parents=True, exist_ok=True)
    path = bars_dir / f"{spec}.parquet"
    if path.exists():
        _note(on_progress, f"Cache hit bars {spec}")
        return pd.read_parquet(path)
    if trades is None:
        trades = load_trades()
    _note(on_progress, f"Aggregating {spec}")
    frame = aggregate_trades(trades, spec, on_progress=lambda msg, _frac: _note(on_progress, msg))
    frame.to_parquet(path, index=False)
    return frame


def _source_fingerprint(root: Path) -> dict:
    files = []
    for path in trade_files(root):
        stat = path.stat()
        files.append({"name": path.name, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
    return {
        "version": CACHE_VERSION,
        "cache_key": CACHE_KEY,
        "root": str(root.resolve()),
        "files": files,
    }


def _manifest_matches(path: Path, expected: dict) -> bool:
    if not path.exists():
        return False
    try:
        saved = json.loads(path.read_text())
    except json.JSONDecodeError:
        return False
    return (
        saved.get("version") == expected["version"]
        and saved.get("cache_key") == expected["cache_key"]
        and saved.get("files") == expected["files"]
    )


def _read_trade_file(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(
        path,
        compression="zstd",
        usecols=_USECOLS,
        dtype={"action": "string", "symbol": "string"},
    )
    frame = frame[frame["action"].astype(str).str.upper().eq("T")]
    frame = frame[~frame["symbol"].astype(str).str.contains("-", regex=False)]
    frame = frame.rename(columns={"ts_event": "timestamp"})
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame["price"] = pd.to_numeric(frame["price"], errors="coerce")
    frame["size"] = pd.to_numeric(frame["size"], errors="coerce")
    frame = frame.dropna(subset=["timestamp", "price"])
    frame["size"] = frame["size"].fillna(0.0)
    return frame[["timestamp", "price", "size", "symbol"]].reset_index(drop=True)


def _daily_volume(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return pd.DataFrame(columns=["et_date", "symbol", "size"])
    et_date = frame["timestamp"].dt.tz_convert("America/New_York").dt.strftime("%Y-%m-%d")
    out = (
        frame.assign(et_date=et_date)
        .groupby(["et_date", "symbol"], as_index=False, sort=False)["size"]
        .sum()
    )
    return out


def _daily_volume_from_parquet(path: Path) -> pd.DataFrame:
    frame = pd.read_parquet(path, columns=["timestamp", "size", "symbol"])
    out = _daily_volume(frame)
    del frame
    return out


def _note(on_progress, message: str) -> None:
    if on_progress is not None:
        on_progress(message)
