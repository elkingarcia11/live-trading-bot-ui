from __future__ import annotations

import asyncio
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from typing import Literal
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.gcs import (
    OhlcvStore,
    ProgressClock,
    fingerprint,
    has_ohlcv,
    list_symbols,
    list_timeframes,
    list_continuous_timeframes,
    list_trade_symbols,
)
from backend.aggregate import PRESETS, parse_spec
from backend.gma import EMA_COL, SMA_COL, dual_gma
from backend.optimize import optimize as run_optimize
from backend.session import rth_trade_indices, session_masks
from backend.viz import list_results, load_result, load_summary, save_optimize_result, split_viz

DataSource = Literal["ohlcv", "trades", "continuous"]

store = OhlcvStore()
app = FastAPI(title="Live Trading Bot UI", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


class GmaParams(BaseModel):
    fast_length: int = Field(20, ge=5, le=100)
    fast_sigma: float = Field(3.0, ge=1, le=10)
    slow_length: int = Field(50, ge=5, le=100)
    slow_sigma: float = Field(3.0, ge=1, le=10)


def _finite(value: float) -> float | None:
    if value is None or math.isnan(value) or math.isinf(value):
        return None
    return float(value)


def _marks_after(candle_timestamps, marks) -> np.ndarray:
    values = np.full(len(candle_timestamps), np.nan)
    if marks.empty:
        return values
    candle_ns = candle_timestamps.astype("int64").to_numpy()
    mark_ns = marks["timestamp"].astype("int64").to_numpy()
    indices = np.searchsorted(mark_ns, candle_ns, side="left")
    valid = indices < len(marks)
    if valid.any():
        values[valid] = marks["mark_price"].to_numpy()[indices[valid]]
    return values


def _json_default(value):
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(
        f"Object of type {type(value).__name__} is not JSON serializable")


def _chart_payload(
    symbol: str,
    timeframe: str,
    params: GmaParams,
    refresh: bool,
    on_progress=None,
    source: DataSource | None = None,
) -> dict:
    clock = ProgressClock(on_progress=on_progress, timeframe=timeframe)
    clock.emit(0, f"Loading {symbol}/{timeframe}", stage="start")
    if source == "trades" or (source != "continuous" and not has_ohlcv(symbol, timeframe)):
        try:
            parse_spec(timeframe)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        entry = store.get(symbol, timeframe, refresh=refresh,
                          progress=clock, source=source)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to read GCS: {exc}") from exc

    clock.source = entry.source
    frame = entry.frame
    call_marks, put_marks, mark_fingerprint = store.get_mark_prices(
        refresh=refresh)
    call_prices = _marks_after(frame["timestamp"], call_marks)
    put_prices = _marks_after(frame["timestamp"], put_marks)
    response_fingerprint = f"{entry.fingerprint}|{mark_fingerprint}"
    if frame.empty:
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "fingerprint": response_fingerprint,
            "updated": entry.updated.isoformat() if entry.updated else None,
            "loaded_at": entry.loaded_at.isoformat(),
            "bar_count": 0,
            "source": entry.source,
            "path": entry.path,
            "params": params.model_dump(),
            "bars": [],
            "signals": [],
        }

    clock.emit(82, "Computing GMA", stage="gma")
    close = frame["close"].to_numpy()
    ema_source = frame[EMA_COL].to_numpy(
    ) if EMA_COL in frame.columns else None
    sma_source = frame[SMA_COL].to_numpy(
    ) if SMA_COL in frame.columns else None
    fast, slow = dual_gma(
        close,
        params.fast_length,
        params.fast_sigma,
        params.slow_length,
        params.slow_sigma,
        ema_source=ema_source,
        sma_source=sma_source,
    )
    rth, session_open, session_close = session_masks(frame["timestamp"])
    buy_idx, sell_idx, _flatten_idx = rth_trade_indices(
        fast, slow, rth, session_open, session_close
    )
    buy = np.zeros(len(frame), dtype=bool)
    sell = np.zeros(len(frame), dtype=bool)
    buy[buy_idx] = True
    sell[sell_idx] = True

    n = len(frame)
    clock.emit(
        88, f"Updating session from {n:,} bars", stage="session", done=0, total=n)
    chunk_size = 2_500
    chunk_start = 0
    bars = []
    signals = []
    for i, row in enumerate(frame.itertuples(index=False)):
        ts = row.timestamp
        if getattr(ts, "tzinfo", None) is None:
            ts = ts.replace(tzinfo=timezone.utc)
        unix = int(ts.timestamp())
        signal = "buy" if buy[i] else "sell" if sell[i] else None
        bars.append(
            {
                "time": unix,
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "volume": float(row.volume),
                "gma_fast": _finite(float(fast[i])),
                "gma_slow": _finite(float(slow[i])),
                "signal": signal,
                "call_mark_price": _finite(float(call_prices[i])),
                "put_mark_price": _finite(float(put_prices[i])),
            }
        )
        if signal:
            signals.append({"time": unix, "side": signal,
                           "price": float(row.close)})
        done = i + 1
        if on_progress is not None and (done % chunk_size == 0 or done == n):
            chunk = bars[chunk_start:]
            chunk_start = done
            clock.emit(
                88 + 11 * done / n,
                f"Updating session {done:,}/{n:,} bars",
                stage="session",
                done=done,
                total=n,
                extra={"bars": chunk, "append": True},
            )

    clock.emit(99, f"Ready {len(bars):,} bars",
               stage="session", done=n, total=n)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "fingerprint": response_fingerprint,
        "updated": entry.updated.isoformat() if entry.updated else None,
        "loaded_at": entry.loaded_at.isoformat(),
        "bar_count": len(bars),
        "source": entry.source,
        "path": entry.path,
        "params": params.model_dump(),
        "bars": bars,
        "signals": signals,
    }


SSE_HEADERS = {
    "Cache-Control": "no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "identity",
}


def _sse(event: dict) -> str:
    try:
        payload = json.dumps(event, allow_nan=False, default=_json_default)
    except (TypeError, ValueError) as exc:
        payload = json.dumps(
            {"type": "error", "detail": f"Result not serializable: {exc}"})
    return f"data: {payload}\n\n"


def _sse_job(work) -> StreamingResponse:
    queue: asyncio.Queue[dict] = asyncio.Queue()

    async def generate():
        loop = asyncio.get_running_loop()

        def emit(event: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, event)

        def run() -> None:
            try:
                work(emit)
            except HTTPException as exc:
                detail = exc.detail if isinstance(
                    exc.detail, str) else str(exc.detail)
                emit({"type": "error", "detail": detail})
            except Exception as exc:
                emit({"type": "error", "detail": str(exc)})

        # Flush Google Frontend's buffer so the browser sees bytes immediately.
        yield ":" + (" " * 4096) + "\n\n"
        yield _sse({"type": "ping"})
        worker = asyncio.create_task(asyncio.to_thread(run))
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    yield _sse({"type": "ping"})
                    continue
                yield _sse(event)
                if event.get("type") in ("done", "error"):
                    yield ": bye\n\n"
                    break
        finally:
            await worker

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/catalog")
def catalog() -> dict:
    try:
        symbols = list_symbols()
        trade_names = list_trade_symbols()
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to list symbols: {exc}") from exc
    trade_lower = {name.lower() for name in trade_names}
    ohlcv: dict[str, list[str]] = {}
    continuous: dict[str, list[str]] = {}
    dropdown: dict[str, list[str]] = {}
    has_trades: dict[str, bool] = {}
    for symbol in symbols:
        try:
            existing = list_timeframes(symbol)
        except Exception:
            existing = []
        ohlcv[symbol] = existing
        continuous[symbol] = list_continuous_timeframes(symbol)
        dropdown[symbol] = existing
        has_trades[symbol] = symbol.lower() in trade_lower
    return {
        "bucket": "live-trading-bot",
        "prefix": "ohlcv",
        "symbols": dropdown,
        "ohlcv_timeframes": ohlcv,
        "continuous_timeframes": continuous,
        "has_trades": has_trades,
        "aggregates": PRESETS,
    }


@app.get("/api/symbols")
def symbols() -> dict:
    try:
        return {"symbols": list_symbols()}
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to list symbols: {exc}") from exc


@app.get("/api/timeframes")
def timeframes(symbol: str = Query(..., min_length=1)) -> dict:
    try:
        return {"symbol": symbol, "timeframes": list_timeframes(symbol)}
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to list timeframes: {exc}") from exc


@app.get("/api/meta")
def meta(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    source: DataSource | None = None,
) -> dict:
    try:
        fp = fingerprint(symbol, timeframe, source)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Failed to stat GCS: {exc}") from exc
    cached = store.peek(symbol, timeframe, source)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "fingerprint": fp,
        "cached_fingerprint": cached.fingerprint if cached else None,
        "stale": cached is None or cached.fingerprint != fp,
        "source": source,
    }


@app.get("/api/chart")
async def chart(
    request: Request,
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    refresh: bool = False,
    source: DataSource | None = None,
    fast_length: int = Query(20, ge=5, le=100),
    fast_sigma: float = Query(3.0, ge=1, le=10),
    slow_length: int = Query(50, ge=5, le=100),
    slow_sigma: float = Query(3.0, ge=1, le=10),
):
    params = GmaParams(
        fast_length=fast_length,
        fast_sigma=fast_sigma,
        slow_length=slow_length,
        slow_sigma=slow_sigma,
    )
    if "text/event-stream" in request.headers.get("accept", ""):

        def work(emit) -> None:
            result = _chart_payload(
                symbol, timeframe, params, refresh, on_progress=emit, source=source
            )
            emit({"type": "done", "result": result})

        return _sse_job(work)
    return await asyncio.to_thread(
        _chart_payload, symbol, timeframe, params, refresh, None, source
    )


@app.post("/api/refresh")
def refresh(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    source: DataSource | None = None,
    fast_length: int = Query(20, ge=5, le=100),
    fast_sigma: float = Query(3.0, ge=1, le=10),
    slow_length: int = Query(50, ge=5, le=100),
    slow_sigma: float = Query(3.0, ge=1, le=10),
) -> dict:
    params = GmaParams(
        fast_length=fast_length,
        fast_sigma=fast_sigma,
        slow_length=slow_length,
        slow_sigma=slow_sigma,
    )
    return _chart_payload(symbol, timeframe, params, refresh=True, source=source)


@app.get("/api/optimize")
async def optimize(
    symbol: str = Query(..., min_length=1),
    metric: Literal[
        "total_win_rate",
        "call_win_rate",
        "put_win_rate",
        "total_profit_pct",
        "call_profit_pct",
        "put_profit_pct",
    ] = Query(...),
    timeframe: str = Query(..., min_length=1),
    refresh: bool = False,
    source: DataSource | None = None,
):
    if source != "ohlcv":
        try:
            parse_spec(timeframe)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def load_series(spec: str):
        try:
            entry = store.get(symbol, spec, refresh=refresh, source=source)
        except FileNotFoundError:
            return None
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail=f"Failed to read {spec}: {exc}") from exc
        if entry.frame.empty or "close" not in entry.frame.columns:
            return None
        close = entry.frame["close"].to_numpy(dtype=np.float64)
        ema_source = (
            entry.frame[EMA_COL].to_numpy(dtype=np.float64)
            if EMA_COL in entry.frame.columns
            else None
        )
        sma_source = (
            entry.frame[SMA_COL].to_numpy(dtype=np.float64)
            if SMA_COL in entry.frame.columns
            else None
        )
        timestamps = entry.frame["timestamp"] if "timestamp" in entry.frame.columns else None
        return close, ema_source, sma_source, timestamps

    def work(emit) -> None:
        def on_progress(event: dict) -> None:
            emit(event)

        result = run_optimize(
            symbol, metric, load_series, on_progress=on_progress, timeframe=timeframe
        )
        slim, viz = split_viz(result)
        try:
            save_optimize_result(result)
            emit({"type": "done", "result": slim})
        except Exception:
            emit({"type": "done", "result": result if viz else slim})

    return _sse_job(work)


@app.get("/api/results")
def results_catalog() -> dict:
    return list_results()


@app.get("/api/results/summary")
def results_summary(
    symbol: str = Query(..., min_length=1),
    metric: str = Query(..., min_length=1),
) -> dict:
    try:
        return load_summary(symbol, metric)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/results/detail")
def results_detail(
    symbol: str = Query(..., min_length=1),
    metric: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
) -> dict:
    try:
        return load_result(symbol, metric, timeframe)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/events")
async def events(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    source: DataSource | None = None,
):
    async def generate():
        last = None
        yield ":" + (" " * 4096) + "\n\n"
        while True:
            try:
                fp = await asyncio.to_thread(fingerprint, symbol, timeframe, source)
            except Exception as exc:
                payload = {"type": "error", "message": str(exc)}
                yield f"data: {json.dumps(payload)}\n\n"
                await asyncio.sleep(5)
                continue
            if fp != last:
                last = fp
                payload = {
                    "type": "update",
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "fingerprint": fp,
                    "at": datetime.now(timezone.utc).isoformat(),
                }
            else:
                payload = {"type": "ping", "fingerprint": fp}
            yield f"data: {json.dumps(payload)}\n\n"
            await asyncio.sleep(3)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
