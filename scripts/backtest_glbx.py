#!/usr/bin/env python3
"""Historic Dual-GMA search on a local Databento GLBX.MDP3 dump.

Caches stitched RTH trades and aggregated tick bars under results/cache/.
Defaults to 2 process workers (max 4) so an M1 Pro 16GB stays responsive.
Tick timeframes only; already-written result files are skipped.
"""

from __future__ import annotations
from backend.glbx import cache_dir_for, load_glbx_trades, load_or_build_bars
from backend.gma import EMA_COL, SMA_COL
from backend.optimize import FrameSeries, optimize as run_optimize, params_equity_stats
from backend.session import session_masks
from backend.viz import split_viz, write_json
import numpy as np
import csv
import gc
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


# Must be set before numpy/BLAS load in this process and in spawn children.
os.environ.setdefault("OPTIMIZE_WORKERS", "2")
for _key in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
):
    os.environ.setdefault(_key, "1")


METRIC = "total_win_rate"
# Allow overriding the symbol via BACKTEST_SYMBOL env var (e.g. ES.n.0)
SYMBOL = os.environ.get("BACKTEST_SYMBOL", "ES.FUT")
DUMP = ROOT / "GLBX-20260817-SSH4KRG4MK"
RESULTS = ROOT / "results"
SPECS = ["25t", "50t", "100t", "200t", "400t", "800t", "1200t"]
# Allow running a single timeframe via BACKTEST_FRAME environment variable.
_env_frame = os.environ.get("BACKTEST_FRAME")
if _env_frame:
    SPECS = [_env_frame]


CSV_FIELDS = [
    "timeframe",
    "fast_length",
    "fast_sigma",
    "slow_length",
    "slow_sigma",
    "closed_trades",
    "wins",
    "Total %",
    "Total win rate",
    "Max drawdown %",
    "Max runup %",
    "Average Profit %",
]


def csv_row(result: dict) -> dict:
    params = result.get("params") or result
    blank = "" if "error" in result and "win_rate" not in result else None

    def cell(key, fallback=None):
        if blank is not None and key not in ("timeframe",):
            return ""
        value = result.get(key, fallback)
        return "" if value is None else value

    return {
        "timeframe": result.get("timeframe", ""),
        "fast_length": params.get("fast_length", ""),
        "fast_sigma": params.get("fast_sigma", ""),
        "slow_length": params.get("slow_length", ""),
        "slow_sigma": params.get("slow_sigma", ""),
        "closed_trades": cell("closed_trades", result.get("closed")),
        "wins": cell("wins"),
        "Total %": cell("profit_pct"),
        "Total win rate": cell("win_rate"),
        "Max drawdown %": cell("max_drawdown_pct"),
        "Max runup %": cell("max_runup_pct"),
        "Average Profit %": cell("average_profit_pct"),
    }


def write_results_csv(
    paths: list[Path], rows: list[dict], timeframe: str | None = None
) -> None:
    payload = [
        csv_row({**row, "timeframe": timeframe}) if timeframe else csv_row(row)
        for row in rows
    ]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            writer.writeheader()
            writer.writerows(payload)
            handle.flush()
            os.fsync(handle.fileno())
        tmp.replace(path)


def ranked_rows(summary: list[dict]) -> list[dict]:
    return sorted(
        [row for row in summary if "win_rate" in row],
        key=lambda row: (
            round(row["win_rate"], 2),
            round(row.get("profit_pct", 0), 4),
            row.get("closed_trades", 0),
        ),
        reverse=True,
    )


def _fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return "--"
    total = max(0, int(round(float(seconds))))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def progress_line(event: dict, spec: str = "") -> str:
    name = spec or str(event.get("timeframe", ""))
    pct = float(event.get("pct") or 0)
    tested = int(event.get("tested") or 0)
    total = int(event.get("total") or 0)
    elapsed = event.get("elapsed_s")
    eta = event.get("eta_s")
    message = str(event.get("message", "")).replace(f" {name}", "").strip()
    combo = f"{tested:,}/{total:,}" if total else f"{tested:,}"
    eta_txt = "ETA calculating" if eta is None and pct < 100 else f"ETA {_fmt_duration(eta)}"
    return (
        f"  {name:<6} {pct:5.1f}%  {combo:<21}  "
        f"{_fmt_duration(elapsed)} elapsed  {eta_txt}  {message}"
    )


def packed_to_series(packed) -> FrameSeries:
    close, ema_source, sma_source, timestamps = packed
    if timestamps is None:
        n_bars = int(close.size)
        rth = np.ones(n_bars, dtype=bool)
        session_open = np.zeros(n_bars, dtype=bool)
        session_close = np.zeros(n_bars, dtype=bool)
    else:
        rth, session_open, session_close = session_masks(timestamps)
    return FrameSeries(
        close=close,
        ema=ema_source,
        sma=sma_source,
        rth=rth,
        session_open=session_open,
        session_close=session_close,
    )


def enrich_result(result: dict, load_series) -> dict:
    if "error" in result and "params" not in result:
        return result
    if all(
        key in result
        for key in ("max_drawdown_pct", "max_runup_pct", "average_profit_pct")
    ):
        return result
    params = result.get("params")
    spec = result.get("timeframe")
    if not params or not spec:
        return result
    packed = load_series(spec)
    if packed is None or packed[0] is None or packed[1] is None or packed[2] is None:
        return result
    equity = params_equity_stats(
        packed_to_series(packed),
        params["fast_length"],
        params["fast_sigma"],
        params["slow_length"],
        params["slow_sigma"],
    )
    result["max_drawdown_pct"] = round(equity["max_drawdown_pct"], 4)
    result["max_runup_pct"] = round(equity["max_runup_pct"], 4)
    result["average_profit_pct"] = round(equity["average_profit_pct"], 4)
    if "profit_pct" not in result:
        result["profit_pct"] = round(equity["profit_pct"], 4)
    if "win_rate" not in result:
        result["win_rate"] = round(equity["win_rate"], 2)
    return result


def result_complete(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return False
    trials = payload.get("trials")
    return (
        "win_rate" in payload
        and "error" not in payload
        and isinstance(trials, list)
        and bool(trials)
        and all(
            key in trials[0]
            for key in (
                "fast_length",
                "fast_sigma",
                "slow_length",
                "slow_sigma",
                "max_drawdown_pct",
                "max_runup_pct",
                "average_profit_pct",
            )
        )
    )


def series_from_frame(frame):
    if frame is None or frame.empty or "close" not in frame.columns:
        return None
    close = frame["close"].to_numpy(dtype=np.float64)
    ema_source = (
        frame[EMA_COL].to_numpy(
            dtype=np.float64) if EMA_COL in frame.columns else None
    )
    sma_source = (
        frame[SMA_COL].to_numpy(
            dtype=np.float64) if SMA_COL in frame.columns else None
    )
    timestamps = frame["timestamp"] if "timestamp" in frame.columns else None
    return close, ema_source, sma_source, timestamps


def main() -> int:
    workers = os.environ.get("OPTIMIZE_WORKERS", "2")
    if not DUMP.is_dir():
        print(f"Missing dump {DUMP}", file=sys.stderr)
        return 1

    cache_dir = cache_dir_for(DUMP, RESULTS)
    out_dir = RESULTS / SYMBOL / METRIC
    out_dir.mkdir(parents=True, exist_ok=True)

    print(
        f"GLBX historic search · workers={workers} (max 4) · metric={METRIC} · "
        f"RTH 9:30–4:00 ET · aggregates={', '.join(SPECS)}",
        flush=True,
    )
    print(f"Dump {DUMP}", flush=True)
    print(f"Cache {cache_dir}", flush=True)

    started = time.perf_counter()
    trades = load_glbx_trades(
        DUMP, cache_dir, on_progress=lambda msg: print(f"  {msg}", flush=True))
    print(f"  Front-month RTH trades: {len(trades):,}", flush=True)

    print("\nCaching bars", flush=True)
    for spec in SPECS:
        frame = load_or_build_bars(
            trades,
            spec,
            cache_dir,
            load_trades=lambda: trades,
            on_progress=lambda msg: print(f"  {msg}", flush=True),
        )
        print(f"  {spec}: {len(frame):,} bars", flush=True)
        del frame
        gc.collect()

    trades = None
    gc.collect()

    def load_series(spec: str):
        frame = load_or_build_bars(
            None,
            spec,
            cache_dir,
            load_trades=lambda: load_glbx_trades(DUMP, cache_dir),
        )
        packed = series_from_frame(frame)
        del frame
        return packed

    summary: list[dict] = []
    live_line = False
    csv_paths = [out_dir / "results.csv", RESULTS / "results.csv"]

    def flush_outputs(spec: str | None = None, result: dict | None = None) -> None:
        if spec is not None and result is not None:
            slim, viz = split_viz(result)
            write_json(out_dir / f"{spec}.json", slim)
            if viz:
                write_json(out_dir / f"{spec}.viz.json", viz, compact=True)
            # If optimizer returned full trials, write them all for this timeframe.
            if isinstance(result.get("trials"), list) and result.get("trials"):
                write_results_csv(
                    [out_dir / f"{spec}.csv"], result.get("trials"), spec)
            else:
                # fallback: write the slim single-row summary
                write_results_csv([out_dir / f"{spec}.csv"], [slim])
        write_results_csv(csv_paths, summary)
        ranked = ranked_rows(summary)
        write_json(
            out_dir / "summary.json",
            {
                "symbol": SYMBOL,
                "metric": METRIC,
                "workers": int(float(workers)),
                "source": str(DUMP),
                "session": "09:30-16:00 America/New_York",
                "aggregates": SPECS,
                "elapsed_s": round(time.perf_counter() - started, 1),
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "best_overall": ranked[0] if ranked else None,
                "by_timeframe": summary,
            },
        )
        if spec is not None:
            print(f"  wrote {out_dir / f'{spec}.json'}", flush=True)
            print(f"  wrote {out_dir / f'{spec}.csv'}", flush=True)
            print(f"  wrote {out_dir / 'results.csv'}", flush=True)

    def end_live_line() -> None:
        nonlocal live_line
        if live_line:
            print(flush=True)
            live_line = False

    def on_progress(event: dict, spec: str = "") -> None:
        nonlocal live_line
        if event.get("type") != "progress":
            return
        message = str(event.get("message", ""))
        line = progress_line(event, spec)
        searching = message.startswith("Searching")
        if searching:
            print(f"\r{line:<120}", end="", flush=True)
            live_line = True
            return
        end_live_line()
        print(line, flush=True)

    for spec in SPECS:
        dest = out_dir / f"{spec}.json"
        print(f"\n[{SYMBOL}] {spec}", flush=True)
        if result_complete(dest):
            payload = enrich_result(json.loads(dest.read_text()), load_series)
            write_json(dest, payload)
            summary.append(payload)
            flush_outputs(spec, payload)
            params = payload.get("params", {})
            print(
                f"  skip cache {spec} · WR {payload.get('win_rate')}% "
                f"({payload.get('wins')}/{payload.get('closed_trades')}) · "
                f"fast {params.get('fast_length')}/{params.get('fast_sigma')} · "
                f"slow {params.get('slow_length')}/{params.get('slow_sigma')}",
                flush=True,
            )
            continue

        spec_started = time.perf_counter()
        try:
            result = run_optimize(
                SYMBOL,
                METRIC,
                load_series,
                on_progress=lambda event, spec=spec: on_progress(event, spec),
                timeframe=spec,
            )
        except Exception as exc:
            payload = {
                "symbol": SYMBOL,
                "metric": METRIC,
                "timeframe": spec,
                "error": str(exc),
                "elapsed_s": round(time.perf_counter() - spec_started, 1),
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "source": str(DUMP),
            }
            write_json(dest, payload)
            summary.append(payload)
            flush_outputs(spec, payload)
            end_live_line()
            print(f"  FAILED {spec}: {exc}", flush=True)
            gc.collect()
            continue

        result["elapsed_s"] = round(time.perf_counter() - spec_started, 1)
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        result["workers"] = int(float(workers))
        result["source"] = str(DUMP)
        slim, _viz = split_viz(result)
        summary.append(slim)
        flush_outputs(spec, result)
        params = result["params"]
        end_live_line()
        print(
            f"  BEST {spec} · WR {result['win_rate']}% "
            f"({result['wins']}/{result['closed_trades']}) · "
            f"Total {result['profit_pct']}% · "
            f"DD {result['max_drawdown_pct']}% · "
            f"RU {result['max_runup_pct']}% · "
            f"Avg {result['average_profit_pct']}% · "
            f"fast {params['fast_length']}/{params['fast_sigma']} · "
            f"slow {params['slow_length']}/{params['slow_sigma']} · "
            f"{result['elapsed_s']}s",
            flush=True,
        )
        gc.collect()

    ranked = ranked_rows(summary)
    print(f"\nWrote {out_dir / 'summary.json'}", flush=True)
    print(f"Wrote {out_dir / 'results.csv'}", flush=True)
    if ranked:
        top = ranked[0]
        print(
            f"Best overall {SYMBOL}: {top['timeframe']} · WR {top['win_rate']}% "
            f"({top['wins']}/{top['closed_trades']})",
            flush=True,
        )
    print(
        f"\nDone in {time.perf_counter() - started:.1f}s · results in {out_dir}", flush=True)
    return 0


if __name__ == "__main__":
    from multiprocessing import freeze_support

    freeze_support()
    raise SystemExit(main())
