"""Grid-search aggregates and GMA params for win rate or closed profit %."""

from __future__ import annotations

import time
from dataclasses import dataclass
from itertools import product
from typing import Callable

import numpy as np

from backend.aggregate import PRESETS
from backend.gma import gaussian_ma

# Matches the sidebar sliders: length 2–200, sigma 1–10 step 0.5.
LENGTHS = [
    2, 4, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 50, 60, 80, 100, 125, 150, 200
]
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


def score_events(
    close: np.ndarray, buy_idx: np.ndarray, sell_idx: np.ndarray
) -> tuple[int, int, float, float, float, float, int, int, int, int]:
    """Always in market: GMA up opens/holds a call, GMA down opens/holds a put.

    Close call (up = win) and close put (down = win) both count toward
    win rate and combined profit.
    """
    bi = 0
    si = 0
    nb = buy_idx.size
    ns = sell_idx.size
    if nb + ns < 2:
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
    while bi < nb or si < ns:
        take_buy = si >= ns or (bi < nb and buy_idx[bi] <= sell_idx[si])
        idx = int(buy_idx[bi] if take_buy else sell_idx[si])
        if take_buy:
            bi += 1
        else:
            si += 1
        price = float(close[idx])
        if take_buy:
            if side == -1:
                pnl = put_pnl(entry, price)
                put_profit += pnl
                put_pct_sum += put_pct(entry, price)
                close_puts += 1
                if pnl > 0:
                    wins += 1
                    put_wins += 1
                side = 0
            if side == 0:
                entry = price
                side = 1
        else:
            if side == 1:
                pnl = call_pnl(entry, price)
                call_profit += pnl
                call_pct_sum += call_pct(entry, price)
                close_calls += 1
                if pnl > 0:
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
    if metric == "total_win_rate":
        return trial.win_rate, trial.profit_pct, trial.closed
    if metric == "call_win_rate":
        return trial.call_win_rate, trial.call_profit_pct, trial.close_calls
    if metric == "put_win_rate":
        return trial.put_win_rate, trial.put_profit_pct, trial.close_puts
    if metric == "total_profit_pct":
        return trial.profit_pct, trial.win_rate, trial.closed
    if metric == "call_profit_pct":
        return trial.call_profit_pct, trial.call_win_rate, trial.close_calls
    return trial.put_profit_pct, trial.put_win_rate, trial.close_puts


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


ProgressFn = Callable[[dict], None]


def _config_count(n: int) -> int:
    return sum(1 for length in LENGTHS for _sigma in SIGMAS if length <= n)


def _emit(on_progress: ProgressFn | None, payload: dict) -> None:
    if on_progress is not None:
        on_progress(payload)


def search_timeframe(
    timeframe: str,
    close: np.ndarray,
    metric: str,
    on_tick: Callable[[int], None] | None = None,
) -> tuple[Trial | None, int]:
    n = close.size
    configs: list[tuple[int, float, np.ndarray]] = []
    for length, sigma in product(LENGTHS, SIGMAS):
        if length > n:
            continue
        configs.append((length, sigma, gaussian_ma(close, length, sigma)))

    best: Trial | None = None
    tested = 0
    k = len(configs)
    last_tick = 0.0
    for i in range(k):
        flen, fsig, fast = configs[i]
        for j in range(k):
            if i == j:
                continue
            slen, ssig, slow = configs[j]
            tested += 1
            now = time.perf_counter()
            if on_tick is not None and now - last_tick >= 0.35:
                last_tick = now
                on_tick(tested)
            if max(flen, slen) + 2 > n:
                continue
            f1, f0 = fast[1:], fast[:-1]
            s1, s0 = slow[1:], slow[:-1]
            ok = np.isfinite(f1) & np.isfinite(f0) & np.isfinite(s1) & np.isfinite(s0)
            buy_idx = np.flatnonzero(ok & (f0 <= s0) & (f1 > s1)) + 1
            sell_idx = np.flatnonzero(ok & (f0 >= s0) & (f1 < s1)) + 1
            if buy_idx.size + sell_idx.size < MIN_TRADES:
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
            ) = score_events(close, buy_idx, sell_idx)
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
    if on_tick is not None:
        on_tick(tested)
    return best, tested


def optimize(
    symbol: str,
    metric: str,
    load_close,
    on_progress: ProgressFn | None = None,
) -> dict:
    if metric not in METRICS:
        raise ValueError(f"metric must be one of {sorted(METRICS)}")
    started = time.perf_counter()
    jobs: list[tuple[str, np.ndarray, int]] = []
    for index, spec in enumerate(PRESETS, start=1):
        _emit(
            on_progress,
            {
                "type": "progress",
                "pct": 0.0,
                "elapsed_s": round(time.perf_counter() - started, 1),
                "eta_s": None,
                "timeframe": spec,
                "frame": index,
                "frames": len(PRESETS),
                "tested": 0,
                "total": 0,
                "message": f"Loading {spec}",
            },
        )
        close = load_close(spec)
        if close is None or close.size < MIN_TRADES + 2:
            continue
        k = _config_count(int(close.size))
        pairs = k * (k - 1) if k > 1 else 0
        jobs.append((spec, close, pairs))

    work_total = max(sum(pairs for _spec, _close, pairs in jobs), 1)
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

    for index, (spec, close, _pairs) in enumerate(jobs, start=1):
        frames += 1
        report(spec, index, 0, f"Searching {spec}")
        best, n_tested = search_timeframe(
            spec,
            close,
            metric,
            on_tick=lambda n, spec=spec, index=index: report(
                spec, index, n, f"Searching {spec}"
            ),
        )
        tested += n_tested
        work_done += n_tested
        report(spec, index, 0, f"Finished {spec}")
        if best is not None and _better(metric, best, overall):
            overall = best
    if overall is None:
        raise LookupError(
            f"No combo produced {MIN_TRADES}+ closed trades for {symbol} ({metric})"
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
        "aggregates": PRESETS,
        "frames_searched": frames,
        "min_trades": MIN_TRADES,
        "grid": {"lengths": LENGTHS, "sigmas": SIGMAS},
    }
