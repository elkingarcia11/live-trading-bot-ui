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
    list_trade_symbols,
)
from backend.aggregate import PRESETS, parse_spec
from backend.gma import EMA_COL, SMA_COL, detect_crosses, dual_gma
from backend.optimize import optimize as run_optimize

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


def _json_default(value):
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _chart_payload(
    symbol: str,
    timeframe: str,
    params: GmaParams,
    refresh: bool,
    on_progress=None,
) -> dict:
    clock = ProgressClock(on_progress=on_progress, timeframe=timeframe)
    clock.emit(0, f"Loading {symbol}/{timeframe}", stage="start")
    try:
        parse_spec(timeframe)
    except ValueError as exc:
        if not has_ohlcv(symbol, timeframe):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        entry = store.get(symbol, timeframe, refresh=refresh, progress=clock)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to read GCS: {exc}") from exc

    clock.source = entry.source
    frame = entry.frame
    if frame.empty:
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "fingerprint": entry.fingerprint,
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
    ema_source = frame[EMA_COL].to_numpy() if EMA_COL in frame.columns else None
    sma_source = frame[SMA_COL].to_numpy() if SMA_COL in frame.columns else None
    fast, slow = dual_gma(
        close,
        params.fast_length,
        params.fast_sigma,
        params.slow_length,
        params.slow_sigma,
        ema_source=ema_source,
        sma_source=sma_source,
    )
    buy, sell = detect_crosses(fast, slow)

    n = len(frame)
    clock.emit(88, f"Updating session from {n:,} bars", stage="session", done=0, total=n)
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
            }
        )
        if signal:
            signals.append({"time": unix, "side": signal, "price": float(row.close)})
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

    clock.emit(99, f"Ready {len(bars):,} bars", stage="session", done=n, total=n)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "fingerprint": entry.fingerprint,
        "updated": entry.updated.isoformat() if entry.updated else None,
        "loaded_at": entry.loaded_at.isoformat(),
        "bar_count": len(bars),
        "source": entry.source,
        "path": entry.path,
        "params": params.model_dump(),
        "bars": bars,
        "signals": signals,
    }


def _sse(event: dict) -> str:
    try:
        payload = json.dumps(event, allow_nan=False, default=_json_default)
    except (TypeError, ValueError) as exc:
        payload = json.dumps({"type": "error", "detail": f"Result not serializable: {exc}"})
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
                detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
                emit({"type": "error", "detail": detail})
            except Exception as exc:
                emit({"type": "error", "detail": str(exc)})

        worker = asyncio.create_task(asyncio.to_thread(run))
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
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
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
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
        raise HTTPException(status_code=502, detail=f"Failed to list symbols: {exc}") from exc
    trade_lower = {name.lower() for name in trade_names}
    ohlcv: dict[str, list[str]] = {}
    dropdown: dict[str, list[str]] = {}
    has_trades: dict[str, bool] = {}
    for symbol in symbols:
        try:
            existing = list_timeframes(symbol)
        except Exception:
            existing = []
        ohlcv[symbol] = existing
        dropdown[symbol] = existing
        has_trades[symbol] = symbol.lower() in trade_lower
    return {
        "bucket": "live-trading-bot",
        "prefix": "ohlcv",
        "symbols": dropdown,
        "ohlcv_timeframes": ohlcv,
        "has_trades": has_trades,
        "aggregates": PRESETS,
    }


@app.get("/api/symbols")
def symbols() -> dict:
    try:
        return {"symbols": list_symbols()}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to list symbols: {exc}") from exc


@app.get("/api/timeframes")
def timeframes(symbol: str = Query(..., min_length=1)) -> dict:
    try:
        return {"symbol": symbol, "timeframes": list_timeframes(symbol)}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to list timeframes: {exc}") from exc


@app.get("/api/meta")
def meta(symbol: str = Query(..., min_length=1), timeframe: str = Query(..., min_length=1)) -> dict:
    try:
        fp = fingerprint(symbol, timeframe)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to stat GCS: {exc}") from exc
    cached = store.peek(symbol, timeframe)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "fingerprint": fp,
        "cached_fingerprint": cached.fingerprint if cached else None,
        "stale": cached is None or cached.fingerprint != fp,
    }


@app.get("/api/chart")
async def chart(
    request: Request,
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    refresh: bool = False,
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
            result = _chart_payload(symbol, timeframe, params, refresh, on_progress=emit)
            emit({"type": "done", "result": result})

        return _sse_job(work)
    return await asyncio.to_thread(_chart_payload, symbol, timeframe, params, refresh)


@app.post("/api/refresh")
def refresh(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
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
    return _chart_payload(symbol, timeframe, params, refresh=True)


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
):
    try:
        parse_spec(timeframe)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    queue: asyncio.Queue[dict] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def load_series(spec: str):
        try:
            entry = store.get(symbol, spec, refresh=refresh)
        except FileNotFoundError:
            return None
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Failed to read {spec}: {exc}") from exc
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
        return close, ema_source, sma_source

    def on_progress(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    def run() -> None:
        try:
            result = run_optimize(
                symbol, metric, load_series, on_progress=on_progress, timeframe=timeframe
            )
            on_progress({"type": "done", "result": result})
        except LookupError as exc:
            on_progress({"type": "error", "detail": str(exc)})
        except ValueError as exc:
            on_progress({"type": "error", "detail": str(exc)})
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
            on_progress({"type": "error", "detail": detail})
        except Exception as exc:
            on_progress({"type": "error", "detail": f"Optimize failed: {exc}"})

    def _sse(event: dict) -> str:
        try:
            payload = json.dumps(event, allow_nan=False, default=_json_default)
        except (TypeError, ValueError) as exc:
            payload = json.dumps({"type": "error", "detail": f"Optimize result not serializable: {exc}"})
        return f"data: {payload}\n\n"

    async def generate():
        worker = asyncio.create_task(asyncio.to_thread(run))
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
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
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/events")
async def events(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
):
    async def generate():
        last = None
        while True:
            try:
                fp = await asyncio.to_thread(fingerprint, symbol, timeframe)
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
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
