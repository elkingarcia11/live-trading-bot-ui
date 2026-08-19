#!/usr/bin/env python3
"""Local win-rate search over every aggregated timeframe.

Uses raw trades (not streamed ohlcv). Sets OPTIMIZE_WORKERS=3 for this
process only; Cloud Run still stays at 1 worker via K_SERVICE.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("OPTIMIZE_WORKERS", "3")

import numpy as np

from backend.aggregate import PRESETS
from backend.gcs import OhlcvStore, list_trade_symbols
from backend.gma import EMA_COL, SMA_COL
from backend.optimize import optimize as run_optimize
from backend.viz import split_viz, write_json

METRIC = "total_win_rate"
RESULTS = ROOT / "results"


def load_series_fn(store: OhlcvStore, symbol: str):
    def load_series(spec: str):
        entry = store.get(symbol, spec, source="trades")
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

    return load_series


def main() -> int:
    workers = os.environ.get("OPTIMIZE_WORKERS", "3")
    symbols = list_trade_symbols()
    if not symbols:
        print("No symbols in gs://live-trading-bot/trades/", file=sys.stderr)
        return 1

    print(
        f"Local win-rate search · workers={workers} · metric={METRIC} · "
        f"aggregates={', '.join(PRESETS)} · symbols={', '.join(symbols)}"
    )
    store = OhlcvStore()
    started = time.perf_counter()

    for symbol in symbols:
        out_dir = RESULTS / symbol / METRIC
        summary: list[dict] = []
        load_series = load_series_fn(store, symbol)
        last_line = ""
        last_print = 0.0

        def on_progress(event: dict, spec: str = "") -> None:
            nonlocal last_line, last_print
            if event.get("type") != "progress":
                return
            message = str(event.get("message", ""))
            pct = event.get("pct", 0)
            eta = event.get("eta_s")
            eta_txt = "calculating…" if eta is None else f"{eta:.0f}s left"
            line = f"  {spec or event.get('timeframe', '')} · {message} · {pct}% · {eta_txt}"
            now = time.monotonic()
            searching = message.startswith("Searching")
            if searching and now - last_print < 5 and line == last_line:
                return
            if searching and now - last_print < 5:
                return
            last_print = now
            last_line = line
            print(line, flush=True)

        for spec in PRESETS:
            print(f"\n[{symbol}] {spec}", flush=True)
            spec_started = time.perf_counter()
            try:
                result = run_optimize(
                    symbol,
                    METRIC,
                    load_series,
                    on_progress=lambda event, spec=spec: on_progress(event, spec),
                    timeframe=spec,
                )
            except Exception as exc:
                payload = {
                    "symbol": symbol,
                    "metric": METRIC,
                    "timeframe": spec,
                    "error": str(exc),
                    "elapsed_s": round(time.perf_counter() - spec_started, 1),
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                }
                write_json(out_dir / f"{spec}.json", payload)
                summary.append(payload)
                print(f"  FAILED {spec}: {exc}", flush=True)
                continue

            result["elapsed_s"] = round(time.perf_counter() - spec_started, 1)
            result["finished_at"] = datetime.now(timezone.utc).isoformat()
            result["workers"] = int(float(workers))
            slim, viz = split_viz(result)
            write_json(out_dir / f"{spec}.json", slim)
            if viz:
                write_json(out_dir / f"{spec}.viz.json", viz, compact=True)
            summary.append(slim)
            params = result["params"]
            print(
                f"  BEST {spec} · WR {result['win_rate']}% "
                f"({result['wins']}/{result['closed_trades']}) · "
                f"fast {params['fast_length']}/{params['fast_sigma']} · "
                f"slow {params['slow_length']}/{params['slow_sigma']} · "
                f"{result['elapsed_s']}s",
                flush=True,
            )

        ranked = sorted(
            [row for row in summary if "win_rate" in row],
            key=lambda row: (
                round(row["win_rate"], 2),
                round(row.get("profit_pct", 0), 4),
                row.get("closed_trades", 0),
            ),
            reverse=True,
        )
        write_json(
            out_dir / "summary.json",
            {
                "symbol": symbol,
                "metric": METRIC,
                "workers": int(float(workers)),
                "source": "trades",
                "aggregates": PRESETS,
                "elapsed_s": round(time.perf_counter() - started, 1),
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "best_overall": ranked[0] if ranked else None,
                "by_timeframe": summary,
            },
        )
        print(f"\nWrote {out_dir / 'summary.json'}", flush=True)
        if ranked:
            top = ranked[0]
            print(
                f"Best overall {symbol}: {top['timeframe']} · WR {top['win_rate']}% "
                f"({top['wins']}/{top['closed_trades']})",
                flush=True,
            )

    print(f"\nDone in {time.perf_counter() - started:.1f}s · results in {RESULTS}", flush=True)
    return 0


if __name__ == "__main__":
    from multiprocessing import freeze_support

    freeze_support()
    raise SystemExit(main())
