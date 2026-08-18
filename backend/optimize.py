"""Grid-search aggregates and GMA params for win rate or closed profit %."""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import product
from threading import Lock
from typing import Callable

import numpy as np

from backend.gma import gaussian_ma
from backend.session import rth_trade_indices, session_masks

# Length 5–30 every integer; above 30 only multiples of 5. Sigma 1–10 step 0.5.
# Fast vs slow is length/sigma, not raw length: a valid pair has
# (fast_length / fast_sigma) < (slow_length / slow_sigma).
LENGTHS = list(range(5, 31)) + list(range(35, 101, 5))
SIGMAS = [round(x * 0.5, 1) for x in range(2, 21)]  # 1.0 .. 10.0
MIN_TRADES = 3


@dataclass
class Trial:
    timeframe: str
    fast_length: int
    fast_sigma: float
    slow_length: int
    slow_sigma: float
    closed: int
    wins: int
    win_rate: float
    profit: float
    call_profit: float
    put_profit: float
    profit_pct: float
    call_profit_pct: float
    put_profit_pct: float
    close_calls: int
    close_puts: int
    call_wins: int
    put_wins: int
    call_win_rate: float
    put_win_rate: float
    bars: int


METRICS = {
    "total_win_rate",
    "call_win_rate",
    "put_win_rate",
    "total_profit_pct",
    "call_profit_pct",
    "put_profit_pct",
}


def call_pnl(buy_price: float, sell_price: float) -> float:
    """Open call then close call. Profit = sell − buy."""
    return sell_price - buy_price


def put_pnl(sell_price: float, buy_price: float) -> float:
    """Open put then close put. Profit = (buy − sell) × −1."""
    return (buy_price - sell_price) * -1.0


def call_pct(buy_price: float, sell_price: float) -> float:
    if buy_price == 0:
        return 0.0
    return call_pnl(buy_price, sell_price) / buy_price * 100.0


def put_pct(sell_price: float, buy_price: float) -> float:
    if sell_price == 0:
        return 0.0
    return put_pnl(sell_price, buy_price) / sell_price * 100.0


def _close_put(entry: float, price: float) -> tuple[float, float, bool]:
    pnl = put_pnl(entry, price)
    return pnl, put_pct(entry, price), pnl > 0


def _close_call(entry: float, price: float) -> tuple[float, float, bool]:
    pnl = call_pnl(entry, price)
    return pnl, call_pct(entry, price), pnl > 0


def score_events(
    close: np.ndarray,
    buy_idx: np.ndarray,
    sell_idx: np.ndarray,
    flatten_idx: np.ndarray | None = None,
) -> tuple[int, int, float, float, float, float, int, int, int, int]:
    """Always in during RTH: GMA up holds a call, GMA down holds a put.

    Flatten indices close without opening the other side (session close).
    Close call (up = win) and close put (down = win) both count toward
    win rate and combined profit.
    """
    buy_idx = np.asarray(buy_idx, dtype=np.int64)
    sell_idx = np.asarray(sell_idx, dtype=np.int64)
    flatten_idx = np.asarray(
        np.zeros(0, dtype=np.int64) if flatten_idx is None else flatten_idx,
        dtype=np.int64,
    )
    bi = 0
    si = 0
    fi = 0
    nb = buy_idx.size
    ns = sell_idx.size
    nf = flatten_idx.size
    if nb + ns + nf < 2:
        return 0, 0, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 0
    entry = 0.0
    side = 0  # 1 = open call, -1 = open put
    wins = 0
    call_wins = 0
    put_wins = 0
    call_profit = 0.0
    put_profit = 0.0
    call_pct_sum = 0.0
    put_pct_sum = 0.0
    close_calls = 0
    close_puts = 0
    inf = close.size + 1
    while bi < nb or si < ns or fi < nf:
        b = int(buy_idx[bi]) if bi < nb else inf
        s = int(sell_idx[si]) if si < ns else inf
        f = int(flatten_idx[fi]) if fi < nf else inf
        idx = min(b, s, f)
        price = float(close[idx])
        if f == idx:
            fi += 1
            if b == idx:
                bi += 1
            if s == idx:
                si += 1
            if side == 1:
                pnl, pct, won = _close_call(entry, price)
                call_profit += pnl
                call_pct_sum += pct
                close_calls += 1
                if won:
                    wins += 1
                    call_wins += 1
                side = 0
            elif side == -1:
                pnl, pct, won = _close_put(entry, price)
                put_profit += pnl
                put_pct_sum += pct
                close_puts += 1
                if won:
                    wins += 1
                    put_wins += 1
                side = 0
            continue
        if b == idx:
            bi += 1
            if side == -1:
                pnl, pct, won = _close_put(entry, price)
                put_profit += pnl
                put_pct_sum += pct
                close_puts += 1
                if won:
                    wins += 1
                    put_wins += 1
                side = 0
            if side == 0:
                entry = price
                side = 1
        else:
            si += 1
            if side == 1:
                pnl, pct, won = _close_call(entry, price)
                call_profit += pnl
                call_pct_sum += pct
                close_calls += 1
                if won:
                    wins += 1
                    call_wins += 1
                side = 0
            if side == 0:
                entry = price
                side = -1
    return (
        close_calls + close_puts,
        wins,
        call_profit,
        put_profit,
        call_pct_sum,
        put_pct_sum,
        close_calls,
        close_puts,
        call_wins,
        put_wins,
    )


def _metric_value(trial: Trial, metric: str) -> tuple[float, float, int]:
    """Primary metric, then total profit % vs total win rate on ties."""
    win_rate = round(trial.win_rate, 2)
    profit_pct = round(trial.profit_pct, 4)
    if metric == "total_win_rate":
        return win_rate, profit_pct, trial.closed
    if metric == "call_win_rate":
        return round(trial.call_win_rate, 2), profit_pct, trial.close_calls
    if metric == "put_win_rate":
        return round(trial.put_win_rate, 2), profit_pct, trial.close_puts
    if metric == "total_profit_pct":
        return profit_pct, win_rate, trial.closed
    if metric == "call_profit_pct":
        return round(trial.call_profit_pct, 4), win_rate, trial.close_calls
    return round(trial.put_profit_pct, 4), win_rate, trial.close_puts


def _enough_trades(metric: str, close_calls: int, close_puts: int, closed: int) -> bool:
    if metric.startswith("call_"):
        return close_calls >= MIN_TRADES
    if metric.startswith("put_"):
        return close_puts >= MIN_TRADES
    return closed >= MIN_TRADES


def _better(metric: str, cand: Trial, best: Trial | None) -> bool:
    if best is None:
        return True
    return _metric_value(cand, metric) > _metric_value(best, metric)


@dataclass
class FrameSeries:
    close: np.ndarray
    ema: np.ndarray
    sma: np.ndarray
    rth: np.ndarray
    session_open: np.ndarray
    session_close: np.ndarray


ProgressFn = Callable[[dict], None]


def _is_fast_slow(flen: int, fsig: float, slen: int, ssig: float) -> bool:
    return flen / fsig < slen / ssig


def _pair_count(n: int) -> int:
    configs = [(length, sigma) for length, sigma in product(LENGTHS, SIGMAS) if length <= n]
    return sum(
        1
        for (flen, fsig), (slen, ssig) in product(configs, configs)
        if _is_fast_slow(flen, fsig, slen, ssig)
    )


def _emit(on_progress: ProgressFn | None, payload: dict) -> None:
    if on_progress is not None:
        on_progress(payload)


def _gma_configs(source: np.ndarray, n: int) -> list[tuple[int, float, np.ndarray]]:
    configs: list[tuple[int, float, np.ndarray]] = []
    for length, sigma in product(LENGTHS, SIGMAS):
        if length > n:
            continue
        configs.append((length, sigma, gaussian_ma(source, length, sigma)))
    return configs


def _allocated_cpus() -> int:
    raw = os.environ.get("OPTIMIZE_WORKERS")
    if raw:
        return max(1, int(float(raw)))
    # Cloud Run sets K_SERVICE; os.cpu_count() is the host, not --cpu.
    if os.environ.get("K_SERVICE"):
        return 1
    return os.cpu_count() or 1


def _worker_count(tasks: int) -> int:
    if tasks <= 1:
        return 1
    return max(1, min(8, _allocated_cpus(), tasks))


def _split(items: list, parts: int) -> list[list]:
    if not items:
        return []
    parts = max(1, min(parts, len(items)))
    size = (len(items) + parts - 1) // parts
    return [items[i : i + size] for i in range(0, len(items), size)]


class _TickCounter:
    """Thread-safe pair counter for SSE progress. Ticks at most every 0.35s."""

    def __init__(self, on_tick: Callable[[int], None] | None) -> None:
        self._on_tick = on_tick
        self._lock = Lock()
        self.value = 0
        self._last_tick = 0.0

    def add(self, n: int) -> None:
        if n <= 0:
            return
        tick_value: int | None = None
        with self._lock:
            self.value += n
            now = time.perf_counter()
            if self._on_tick is not None and now - self._last_tick >= 0.35:
                self._last_tick = now
                tick_value = self.value
        if tick_value is not None:
            self._on_tick(tick_value)


def _search_fast_group(
    timeframe: str,
    series: FrameSeries,
    n: int,
    metric: str,
    fast_group: list[tuple[int, float, np.ndarray]],
    slow_configs: list[tuple[int, float, np.ndarray]],
    ticks: _TickCounter,
) -> tuple[Trial | None, int]:
    best: Trial | None = None
    tested = 0
    pending = 0
    close = series.close
    for flen, fsig, fast in fast_group:
        for slen, ssig, slow in slow_configs:
            if not _is_fast_slow(flen, fsig, slen, ssig):
                continue
            tested += 1
            pending += 1
            if pending >= 256:
                ticks.add(pending)
                pending = 0
            if max(flen, slen) + 2 > n:
                continue
            buy_idx, sell_idx, flatten_idx = rth_trade_indices(
                fast, slow, series.rth, series.session_open, series.session_close
            )
            if buy_idx.size + sell_idx.size + flatten_idx.size < MIN_TRADES:
                continue
            (
                closed,
                wins,
                call_pts,
                put_pts,
                call_p,
                put_p,
                n_calls,
                n_puts,
                call_wins,
                put_wins,
            ) = score_events(close, buy_idx, sell_idx, flatten_idx)
            if not _enough_trades(metric, n_calls, n_puts, closed):
                continue
            trial = Trial(
                timeframe=timeframe,
                fast_length=flen,
                fast_sigma=fsig,
                slow_length=slen,
                slow_sigma=ssig,
                closed=closed,
                wins=wins,
                win_rate=(wins / closed) * 100.0 if closed else 0.0,
                profit=call_pts + put_pts,
                call_profit=call_pts,
                put_profit=put_pts,
                profit_pct=call_p + put_p,
                call_profit_pct=call_p,
                put_profit_pct=put_p,
                close_calls=n_calls,
                close_puts=n_puts,
                call_wins=call_wins,
                put_wins=put_wins,
                call_win_rate=(call_wins / n_calls) * 100.0 if n_calls else 0.0,
                put_win_rate=(put_wins / n_puts) * 100.0 if n_puts else 0.0,
                bars=n,
            )
            if _better(metric, trial, best):
                best = trial
    ticks.add(pending)
    return best, tested


def search_timeframe(
    timeframe: str,
    series: FrameSeries,
    metric: str,
    on_tick: Callable[[int], None] | None = None,
    on_ready: Callable[[], None] | None = None,
) -> tuple[Trial | None, int]:
    close = series.close
    n = close.size
    if _allocated_cpus() <= 1:
        fast_configs = _gma_configs(series.ema, n)
        slow_configs = _gma_configs(series.sma, n)
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            fast_fut = pool.submit(_gma_configs, series.ema, n)
            slow_fut = pool.submit(_gma_configs, series.sma, n)
            fast_configs = fast_fut.result()
            slow_configs = slow_fut.result()
    if on_ready is not None:
        on_ready()

    workers = _worker_count(len(fast_configs))
    groups = _split(fast_configs, workers)
    ticks = _TickCounter(on_tick)
    best: Trial | None = None
    tested = 0
    if workers <= 1:
        parts = [
            _search_fast_group(
                timeframe, series, n, metric, group, slow_configs, ticks
            )
            for group in groups
        ]
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [
                pool.submit(
                    _search_fast_group,
                    timeframe,
                    series,
                    n,
                    metric,
                    group,
                    slow_configs,
                    ticks,
                )
                for group in groups
            ]
            parts = [fut.result() for fut in futures]
    for cand, count in parts:
        tested += count
        if cand is not None and _better(metric, cand, best):
            best = cand
    if on_tick is not None:
        on_tick(tested)
    return best, tested


def optimize(
    symbol: str,
    metric: str,
    load_series,
    on_progress: ProgressFn | None = None,
    timeframe: str | None = None,
) -> dict:
    if metric not in METRICS:
        raise ValueError(f"metric must be one of {sorted(METRICS)}")
    if not timeframe:
        raise ValueError("timeframe is required")
    specs = [timeframe]
    started = time.perf_counter()
    jobs: list[tuple[str, FrameSeries, int]] = []
    for index, spec in enumerate(specs, start=1):
        _emit(
            on_progress,
            {
                "type": "progress",
                "pct": 0.0,
                "elapsed_s": round(time.perf_counter() - started, 1),
                "eta_s": None,
                "timeframe": spec,
                "frame": index,
                "frames": len(specs),
                "tested": 0,
                "total": 0,
                "message": f"Loading {spec}",
            },
        )
        packed = load_series(spec)
        if packed is None:
            continue
        close, ema_source, sma_source, timestamps = packed
        if close is None or close.size < MIN_TRADES + 2:
            continue
        if ema_source is None or sma_source is None:
            continue
        if timestamps is None:
            n_bars = int(close.size)
            rth = np.ones(n_bars, dtype=bool)
            session_open = np.zeros(n_bars, dtype=bool)
            session_close = np.zeros(n_bars, dtype=bool)
        else:
            rth, session_open, session_close = session_masks(timestamps)
        series = FrameSeries(
            close=close,
            ema=ema_source,
            sma=sma_source,
            rth=rth,
            session_open=session_open,
            session_close=session_close,
        )
        jobs.append((spec, series, _pair_count(int(close.size))))

    work_total = max(sum(pairs for _spec, _series, pairs in jobs), 1)
    work_done = 0
    overall: Trial | None = None
    tested = 0
    frames = 0

    def report(spec: str, frame: int, frame_tested: int, message: str) -> None:
        done = min(work_done + frame_tested, work_total)
        elapsed = time.perf_counter() - started
        eta = None
        if done > 0 and elapsed > 0:
            eta = (work_total - done) * (elapsed / done)
        _emit(
            on_progress,
            {
                "type": "progress",
                "pct": round(100.0 * done / work_total, 1),
                "elapsed_s": round(elapsed, 1),
                "eta_s": None if eta is None else round(eta, 1),
                "timeframe": spec,
                "frame": frame,
                "frames": len(jobs),
                "tested": done,
                "total": work_total,
                "message": message,
            },
        )

    for index, (spec, series, _pairs) in enumerate(jobs, start=1):
        frames += 1
        report(spec, index, 0, f"Computing GMA {spec}")
        best, n_tested = search_timeframe(
            spec,
            series,
            metric,
            on_tick=lambda n, spec=spec, index=index: report(
                spec, index, n, f"Searching {spec}"
            ),
            on_ready=lambda spec=spec, index=index: report(
                spec, index, 0, f"Searching {spec}"
            ),
        )
        tested += n_tested
        work_done += n_tested
        report(spec, index, 0, f"Finished {spec}")
        if best is not None and _better(metric, best, overall):
            overall = best
    if overall is None:
        raise LookupError(
            f"No combo produced {MIN_TRADES}+ closed trades for {symbol} {timeframe} ({metric})"
        )
    return {
        "symbol": symbol,
        "metric": metric,
        "timeframe": overall.timeframe,
        "params": {
            "fast_length": overall.fast_length,
            "fast_sigma": overall.fast_sigma,
            "slow_length": overall.slow_length,
            "slow_sigma": overall.slow_sigma,
        },
        "profit": round(overall.profit, 4),
        "call_profit": round(overall.call_profit, 4),
        "put_profit": round(overall.put_profit, 4),
        "win_rate": round(overall.win_rate, 2),
        "profit_pct": round(overall.profit_pct, 4),
        "call_profit_pct": round(overall.call_profit_pct, 4),
        "put_profit_pct": round(overall.put_profit_pct, 4),
        "call_win_rate": round(overall.call_win_rate, 2),
        "put_win_rate": round(overall.put_win_rate, 2),
        "closed_trades": overall.closed,
        "close_calls": overall.close_calls,
        "close_puts": overall.close_puts,
        "call_wins": overall.call_wins,
        "put_wins": overall.put_wins,
        "wins": overall.wins,
        "bars": overall.bars,
        "tested": tested,
        "aggregates": [overall.timeframe],
        "frames_searched": frames,
        "min_trades": MIN_TRADES,
        "grid": {"lengths": LENGTHS, "sigmas": SIGMAS},
    }
