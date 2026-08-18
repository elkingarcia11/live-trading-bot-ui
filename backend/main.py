from __future__ import annotations

import asyncio
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.gcs import (
    OhlcvStore,
    fingerprint,
    has_ohlcv,
    list_symbols,
    list_timeframes,
    list_trade_symbols,
)
from backend.aggregate import PRESETS, parse_spec
from backend.gma import detect_crosses, gaussian_ma
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
    fast_length: int = Field(20, ge=2, le=500)
    fast_sigma: float = Field(3.0, gt=0, le=50)
    slow_length: int = Field(50, ge=2, le=500)
    slow_sigma: float = Field(3.0, gt=0, le=50)


def _finite(value: float) -> float | None:
    if value is None or math.isnan(value) or math.isinf(value):
        return None
    return float(value)


def _chart_payload(symbol: str, timeframe: str, params: GmaParams, refresh: bool) -> dict:
    try:
        parse_spec(timeframe)
    except ValueError as exc:
        if not has_ohlcv(symbol, timeframe):
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        entry = store.get(symbol, timeframe, refresh=refresh)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to read GCS: {exc}") from exc

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

    close = frame["close"].to_numpy()
    fast = gaussian_ma(close, params.fast_length, params.fast_sigma)
    slow = gaussian_ma(close, params.slow_length, params.slow_sigma)
    buy, sell = detect_crosses(fast, slow)

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
def chart(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    refresh: bool = False,
    fast_length: int = Query(20, ge=2, le=500),
    fast_sigma: float = Query(3.0, gt=0, le=50),
    slow_length: int = Query(50, ge=2, le=500),
    slow_sigma: float = Query(3.0, gt=0, le=50),
) -> dict:
    params = GmaParams(
        fast_length=fast_length,
        fast_sigma=fast_sigma,
        slow_length=slow_length,
        slow_sigma=slow_sigma,
    )
    return _chart_payload(symbol, timeframe, params, refresh)


@app.post("/api/refresh")
def refresh(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query(..., min_length=1),
    fast_length: int = Query(20, ge=2, le=500),
    fast_sigma: float = Query(3.0, gt=0, le=50),
    slow_length: int = Query(50, ge=2, le=500),
    slow_sigma: float = Query(3.0, gt=0, le=50),
) -> dict:
    params = GmaParams(
        fast_length=fast_length,
        fast_sigma=fast_sigma,
        slow_length=slow_length,
        slow_sigma=slow_sigma,
    )
    return _chart_payload(symbol, timeframe, params, refresh=True)


@app.get("/api/optimize")
def optimize(
    symbol: str = Query(..., min_length=1),
    metric: Literal[
        "total_profit",
        "call_profit",
        "put_profit",
        "total_pct",
        "call_pct",
        "put_pct",
    ] = Query(...),
    refresh: bool = False,
) -> dict:
    def load_close(spec: str):
        try:
            entry = store.get(symbol, spec, refresh=refresh)
        except FileNotFoundError:
            return None
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Failed to read {spec}: {exc}") from exc
        if entry.frame.empty or "close" not in entry.frame.columns:
            return None
        return entry.frame["close"].to_numpy(dtype=np.float64)

    try:
        return run_optimize(symbol, metric, load_close)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Optimize failed: {exc}") from exc


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
