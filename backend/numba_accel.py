from __future__ import annotations

try:
    import numba
    import numpy as np
except Exception:  # pragma: no cover - optional
    raise


@numba.njit
def score_events_nb(
    close: np.ndarray,
    buy_idx: np.ndarray,
    sell_idx: np.ndarray,
    flatten_idx: np.ndarray,
) -> tuple:
    bi = 0
    si = 0
    fi = 0
    nb = buy_idx.size
    ns = sell_idx.size
    nf = flatten_idx.size
    if nb + ns + nf < 2:
        return (0, 0, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 0)
    entry = 0.0
    side = 0
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
        b = buy_idx[bi] if bi < nb else inf
        s = sell_idx[si] if si < ns else inf
        f = flatten_idx[fi] if fi < nf else inf
        idx = b
        if s < idx:
            idx = s
        if f < idx:
            idx = f
        price = float(close[idx])
        if f == idx:
            fi += 1
            if b == idx:
                bi += 1
            if s == idx:
                si += 1
            if side == 1:
                pnl = (price - entry)
                pct = pnl / entry * 100.0 if entry != 0.0 else 0.0
                call_profit += pnl
                call_pct_sum += pct
                close_calls += 1
                if pnl > 0:
                    wins += 1
                    call_wins += 1
                side = 0
            elif side == -1:
                pnl = (entry - price) * -1.0
                pct = pnl / price * 100.0 if price != 0.0 else 0.0
                put_profit += pnl
                put_pct_sum += pct
                close_puts += 1
                if pnl > 0:
                    wins += 1
                    put_wins += 1
                side = 0
            continue
        if b == idx:
            bi += 1
            if side == -1:
                pnl = (entry - price) * -1.0
                pct = pnl / price * 100.0 if price != 0.0 else 0.0
                put_profit += pnl
                put_pct_sum += pct
                close_puts += 1
                if pnl > 0:
                    wins += 1
                    put_wins += 1
                side = 0
            if side == 0:
                entry = price
                side = 1
        else:
            si += 1
            if side == 1:
                pnl = (price - entry)
                pct = pnl / entry * 100.0 if entry != 0.0 else 0.0
                call_profit += pnl
                call_pct_sum += pct
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


@numba.njit
def equity_stats_nb(
    close: np.ndarray,
    buy_idx: np.ndarray,
    sell_idx: np.ndarray,
    flatten_idx: np.ndarray,
) -> tuple:
    n = close.size
    is_buy = np.zeros(n, dtype=np.uint8)
    is_sell = np.zeros(n, dtype=np.uint8)
    is_flat = np.zeros(n, dtype=np.uint8)
    if n:
        for i in range(buy_idx.size):
            is_buy[buy_idx[i]] = 1
        for i in range(sell_idx.size):
            is_sell[sell_idx[i]] = 1
        for i in range(flatten_idx.size):
            is_flat[flatten_idx[i]] = 1
    entry = 0.0
    side = 0
    wins = 0
    call_pct_sum = 0.0
    put_pct_sum = 0.0
    close_calls = 0
    close_puts = 0
    peak = 0.0
    trough = 0.0
    max_drawdown_pct = 0.0
    max_runup_pct = 0.0
    for i in range(n):
        price = float(close[i])
        if is_flat[i]:
            if side == 1:
                pnl = price - entry
                pct = pnl / entry * 100.0 if entry != 0.0 else 0.0
                call_pct_sum += pct
                close_calls += 1
                if pnl > 0:
                    wins += 1
                side = 0
            elif side == -1:
                pnl = (entry - price) * -1.0
                pct = pnl / price * 100.0 if price != 0.0 else 0.0
                put_pct_sum += pct
                close_puts += 1
                if pnl > 0:
                    wins += 1
                side = 0
        elif is_buy[i]:
            if side == -1:
                pnl = (entry - price) * -1.0
                pct = pnl / price * 100.0 if price != 0.0 else 0.0
                put_pct_sum += pct
                close_puts += 1
                if pnl > 0:
                    wins += 1
                side = 0
            if side == 0:
                entry = price
                side = 1
        elif is_sell[i]:
            if side == 1:
                pnl = price - entry
                pct = pnl / entry * 100.0 if entry != 0.0 else 0.0
                call_pct_sum += pct
                close_calls += 1
                if pnl > 0:
                    wins += 1
                side = 0
            if side == 0:
                entry = price
                side = -1
        equity = call_pct_sum + put_pct_sum
        if side == 1:
            equity += (price - entry) / entry * 100.0 if entry != 0.0 else 0.0
        elif side == -1:
            equity += ((entry - price) * -1.0) / price * \
                100.0 if price != 0.0 else 0.0
        if equity > peak:
            peak = equity
        if equity < trough:
            trough = equity
        drawdown = equity - peak
        runup = equity - trough
        if drawdown < max_drawdown_pct:
            max_drawdown_pct = drawdown
        if runup > max_runup_pct:
            max_runup_pct = runup
    closed = close_calls + close_puts
    profit_pct = call_pct_sum + put_pct_sum
    win_rate = (wins / closed) * 100.0 if closed else 0.0
    avg = profit_pct / closed if closed else 0.0
    return (profit_pct, win_rate, max_drawdown_pct, max_runup_pct, avg, closed, wins)
