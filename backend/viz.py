"""Compact heatmap / correlation payload from a full GMA grid search."""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

RESULTS_ROOT = Path(__file__).resolve().parent.parent / "results"
SAFE_NAME = re.compile(r"^[\w.\-]+$")

PARAM_FIELDS = ("fast_length", "fast_sigma", "slow_length", "slow_sigma")
METRIC_FIELDS = (
    "win_rate",
    "profit_pct",
    "call_win_rate",
    "put_win_rate",
    "call_profit_pct",
    "put_profit_pct",
    "max_runup_pct",
    "avg_max_runup_pct",
    "closed",
)
PARAM_PAIRS = (
    ("fast_length", "slow_length"),
    ("fast_sigma", "slow_sigma"),
    ("fast_length", "fast_sigma"),
    ("slow_length", "slow_sigma"),
    ("fast_length", "slow_sigma"),
    ("fast_sigma", "slow_length"),
)
METRIC_DIGITS = {
    "win_rate": 2,
    "call_win_rate": 2,
    "put_win_rate": 2,
    "profit_pct": 4,
    "call_profit_pct": 4,
    "put_profit_pct": 4,
    "max_runup_pct": 4,
    "avg_max_runup_pct": 4,
    "closed": 0,
}
SEARCH_METRIC_FIELD = {
    "total_win_rate": "win_rate",
    "call_win_rate": "call_win_rate",
    "put_win_rate": "put_win_rate",
    "total_profit_pct": "profit_pct",
    "call_profit_pct": "call_profit_pct",
    "put_profit_pct": "put_profit_pct",
    "max_runup_pct": "max_runup_pct",
    "avg_max_runup_pct": "avg_max_runup_pct",
}

TOP_N = 40

TRIAL_DTYPE = np.dtype(
    [
        ("fast_length", np.int16),
        ("fast_sigma", np.float32),
        ("slow_length", np.int16),
        ("slow_sigma", np.float32),
        ("win_rate", np.float32),
        ("profit_pct", np.float32),
        ("call_win_rate", np.float32),
        ("put_win_rate", np.float32),
        ("call_profit_pct", np.float32),
        ("put_profit_pct", np.float32),
        ("closed", np.int32),
        ("wins", np.int32),
        ("close_calls", np.int32),
        ("close_puts", np.int32),
        ("max_drawdown_pct", np.float32),
        ("max_runup_pct", np.float32),
        ("avg_max_runup_pct", np.float32),
        ("average_profit_pct", np.float32),
    ]
)


def empty_trials() -> np.ndarray:
    return np.empty(0, dtype=TRIAL_DTYPE)


def trial_row(
    flen: int,
    fsig: float,
    slen: int,
    ssig: float,
    win_rate: float,
    profit_pct: float,
    call_win_rate: float,
    put_win_rate: float,
    call_profit_pct: float,
    put_profit_pct: float,
    closed: int,
    wins: int,
    close_calls: int,
    close_puts: int,
    max_drawdown_pct: float,
    max_runup_pct: float,
    avg_max_runup_pct: float,
    average_profit_pct: float,
) -> tuple:
    return (
        int(flen),
        float(fsig),
        int(slen),
        float(ssig),
        float(win_rate),
        float(profit_pct),
        float(call_win_rate),
        float(put_win_rate),
        float(call_profit_pct),
        float(put_profit_pct),
        int(closed),
        int(wins),
        int(close_calls),
        int(close_puts),
        float(max_drawdown_pct),
        float(max_runup_pct),
        float(avg_max_runup_pct),
        float(average_profit_pct),
    )


def trials_from_rows(rows: list[tuple]) -> np.ndarray:
    if not rows:
        return empty_trials()
    return np.array(rows, dtype=TRIAL_DTYPE)


def concat_trials(chunks: list[np.ndarray]) -> np.ndarray:
    present = [chunk for chunk in chunks if chunk is not None and chunk.size]
    if not present:
        return empty_trials()
    return np.concatenate(present)


def _num(value, digits: int):
    if value is None or not np.isfinite(value):
        return None
    if digits == 0:
        return int(round(float(value)))
    return round(float(value), digits)


def _vec(values: np.ndarray, digits: int) -> list:
    return [_num(v, digits) for v in values]


def _grid(values: np.ndarray, digits: int) -> list[list]:
    return [_vec(row, digits) for row in values]


def _axis(values: np.ndarray, field: str) -> tuple[np.ndarray, np.ndarray]:
    if field.endswith("length"):
        snapped = values.astype(np.int32, copy=False)
        uniq = np.unique(snapped)
        return uniq, snapped
    snapped = np.round(values.astype(np.float64), 1)
    uniq = np.unique(snapped)
    return uniq, snapped


def _axis_json(values: np.ndarray, field: str) -> list:
    digits = 0 if field.endswith("length") else 1
    return [_num(v, digits) for v in values]


def _pearson(x: np.ndarray, y: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if x.size < 3:
        return 0.0
    x = x - x.mean()
    y = y - y.mean()
    den = np.sqrt(np.dot(x, x) * np.dot(y, y))
    if den == 0:
        return 0.0
    return round(float(np.dot(x, y) / den), 4)


def _winners(trials: np.ndarray, cell: np.ndarray, n_cells: int, field: str) -> np.ndarray:
    order = np.argsort(-trials[field], kind="mergesort")
    cells_sorted = cell[order]
    uniq, first = np.unique(cells_sorted, return_index=True)
    winner = np.full(n_cells, -1, dtype=np.int64)
    winner[uniq] = order[first]
    return winner


def _reshape(values: np.ndarray, ny: int, nx: int) -> np.ndarray:
    return values.reshape(ny, nx)


def _heatmap(trials: np.ndarray, x_field: str, y_field: str) -> dict:
    x_vals, x_snapped = _axis(trials[x_field], x_field)
    y_vals, y_snapped = _axis(trials[y_field], y_field)
    nx = int(x_vals.size)
    ny = int(y_vals.size)
    xi = np.searchsorted(x_vals, x_snapped)
    yi = np.searchsorted(y_vals, y_snapped)
    cell = yi * nx + xi
    n_cells = nx * ny
    count = np.bincount(cell, minlength=n_cells).astype(np.int32)
    metrics = {}
    winners = {}
    for field in METRIC_FIELDS:
        digits = METRIC_DIGITS[field]
        totals = np.bincount(cell, weights=trials[field].astype(
            np.float64), minlength=n_cells)
        mean = np.full(n_cells, np.nan, dtype=np.float64)
        np.divide(totals, count, out=mean, where=count > 0)
        best = np.full(n_cells, -np.inf, dtype=np.float64)
        np.maximum.at(best, cell, trials[field].astype(np.float64))
        best[count == 0] = np.nan
        metrics[field] = {
            "best": _grid(_reshape(best, ny, nx), digits),
            "mean": _grid(_reshape(mean, ny, nx), digits),
        }
        winner = _winners(trials, cell, n_cells, field)
        packed = {}
        for param in PARAM_FIELDS:
            raw = np.full(n_cells, np.nan, dtype=np.float64)
            valid = winner >= 0
            raw[valid] = trials[param][winner[valid]].astype(np.float64)
            digits_p = 0 if param.endswith("length") else 1
            packed[param] = _grid(_reshape(raw, ny, nx), digits_p)
        winners[field] = packed
    return {
        "x": x_field,
        "y": y_field,
        "x_values": _axis_json(x_vals, x_field),
        "y_values": _axis_json(y_vals, y_field),
        "count": _grid(_reshape(count.astype(np.float64), ny, nx), 0),
        "metrics": metrics,
        "winners": winners,
    }


def _curves(trials: np.ndarray) -> dict:
    out = {}
    for field in PARAM_FIELDS:
        values, snapped = _axis(trials[field], field)
        index = np.searchsorted(values, snapped)
        n = int(values.size)
        count = np.bincount(index, minlength=n).astype(np.int32)
        payload = {
            "values": _axis_json(values, field),
            "count": [int(v) for v in count],
        }
        for metric in METRIC_FIELDS:
            digits = METRIC_DIGITS[metric]
            totals = np.bincount(
                index, weights=trials[metric].astype(np.float64), minlength=n)
            mean = np.full(n, np.nan, dtype=np.float64)
            np.divide(totals, count, out=mean, where=count > 0)
            best = np.full(n, -np.inf, dtype=np.float64)
            np.maximum.at(best, index, trials[metric].astype(np.float64))
            best[count == 0] = np.nan
            payload[metric] = {"best": _vec(
                best, digits), "mean": _vec(mean, digits)}
        out[field] = payload
    return out


def _correlations(trials: np.ndarray) -> dict:
    return {
        metric: {param: _pearson(trials[param], trials[metric])
                 for param in PARAM_FIELDS}
        for metric in METRIC_FIELDS
    }


def _top_trials(trials: np.ndarray, metric: str) -> list[dict]:
    field = SEARCH_METRIC_FIELD.get(metric, "win_rate")
    n = min(TOP_N, int(trials.size))
    if n == 0:
        return []
    order = np.argsort(-trials[field], kind="mergesort")[:n]
    rows = []
    for idx in order:
        row = trials[idx]
        rows.append(
            {
                "fast_length": int(row["fast_length"]),
                "fast_sigma": round(float(row["fast_sigma"]), 1),
                "slow_length": int(row["slow_length"]),
                "slow_sigma": round(float(row["slow_sigma"]), 1),
                "win_rate": round(float(row["win_rate"]), 2),
                "profit_pct": round(float(row["profit_pct"]), 4),
                "call_win_rate": round(float(row["call_win_rate"]), 2),
                "put_win_rate": round(float(row["put_win_rate"]), 2),
                "call_profit_pct": round(float(row["call_profit_pct"]), 4),
                "put_profit_pct": round(float(row["put_profit_pct"]), 4),
                "closed": int(row["closed"]),
                "wins": int(row["wins"]),
                "close_calls": int(row["close_calls"]),
                "close_puts": int(row["close_puts"]),
                "max_drawdown_pct": round(float(row["max_drawdown_pct"]), 4),
                "max_runup_pct": round(float(row["max_runup_pct"]), 4),
                "avg_max_runup_pct": round(float(row["avg_max_runup_pct"]), 4),
                "average_profit_pct": round(float(row["average_profit_pct"]), 4),
            }
        )
    return rows


def trials_to_list(trials: np.ndarray) -> list[dict]:
    """Convert a trials ndarray into a list of JSONable dicts for every tested combo."""
    if trials is None or trials.size == 0:
        return []
    out: list[dict] = []
    for row in trials:
        out.append(
            {
                "fast_length": int(row["fast_length"]),
                "fast_sigma": round(float(row["fast_sigma"]), 1),
                "slow_length": int(row["slow_length"]),
                "slow_sigma": round(float(row["slow_sigma"]), 1),
                "win_rate": round(float(row["win_rate"]), 2),
                "profit_pct": round(float(row["profit_pct"]), 4),
                "call_win_rate": round(float(row["call_win_rate"]), 2),
                "put_win_rate": round(float(row["put_win_rate"]), 2),
                "call_profit_pct": round(float(row["call_profit_pct"]), 4),
                "put_profit_pct": round(float(row["put_profit_pct"]), 4),
                "closed": int(row["closed"]),
                "wins": int(row["wins"]),
                "close_calls": int(row["close_calls"]),
                "close_puts": int(row["close_puts"]),
                "max_drawdown_pct": round(float(row["max_drawdown_pct"]), 4),
                "max_runup_pct": round(float(row["max_runup_pct"]), 4),
                "avg_max_runup_pct": round(float(row["avg_max_runup_pct"]), 4),
                "average_profit_pct": round(float(row["average_profit_pct"]), 4),
            }
        )
    return out


def build_viz(trials: np.ndarray, metric: str) -> dict | None:
    if trials is None or trials.size == 0:
        return None
    return {
        "n_trials": int(trials.size),
        "metric": metric,
        "params": list(PARAM_FIELDS),
        "metrics": list(METRIC_FIELDS),
        "heatmaps": [_heatmap(trials, x, y) for x, y in PARAM_PAIRS],
        "curves": _curves(trials),
        "correlations": _correlations(trials),
        "top_trials": _top_trials(trials, metric),
    }


def _jsonable(value):
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, Path):
        return str(value)
    raise TypeError(type(value).__name__)


def write_json(path: Path, payload: dict, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    text = json.dumps(
        payload,
        default=_jsonable,
        indent=None if compact else 2,
        separators=(",", ":") if compact else None,
    )
    tmp.write_text(text + "\n")
    tmp.replace(path)


def split_viz(result: dict) -> tuple[dict, dict | None]:
    slim = {key: value for key, value in result.items() if key != "viz"}
    viz = result.get("viz")
    return slim, viz if isinstance(viz, dict) else None


def save_optimize_result(result: dict) -> Path:
    slim, viz = split_viz(result)
    symbol = str(slim.get("symbol") or "")
    metric = str(slim.get("metric") or "")
    timeframe = str(slim.get("timeframe") or "")
    if not (SAFE_NAME.match(symbol) and SAFE_NAME.match(metric) and SAFE_NAME.match(timeframe)):
        raise ValueError("invalid results path")
    out_dir = RESULTS_ROOT / symbol / metric
    write_json(out_dir / f"{timeframe}.json", slim)
    if viz:
        write_json(out_dir / f"{timeframe}.viz.json", viz, compact=True)
    return out_dir


def results_dir(symbol: str, metric: str) -> Path:
    if not (SAFE_NAME.match(symbol) and SAFE_NAME.match(metric)):
        raise ValueError("invalid results path")
    return RESULTS_ROOT / symbol / metric


def list_results() -> dict:
    symbols: dict[str, dict[str, list[dict]]] = {}
    if not RESULTS_ROOT.exists():
        return {"symbols": symbols}
    for symbol_dir in sorted(RESULTS_ROOT.iterdir()):
        if not symbol_dir.is_dir() or symbol_dir.name in {"cache", ".cache"}:
            continue
        if not SAFE_NAME.match(symbol_dir.name):
            continue
        metrics: dict[str, list[dict]] = {}
        for metric_dir in sorted(symbol_dir.iterdir()):
            if not metric_dir.is_dir() or not SAFE_NAME.match(metric_dir.name):
                continue
            frames = []
            for path in sorted(metric_dir.glob("*.json")):
                if path.name in {"summary.json"} or path.name.endswith(".viz.json"):
                    continue
                stem = path.stem
                if not SAFE_NAME.match(stem):
                    continue
                frames.append(
                    {
                        "timeframe": stem,
                        "has_viz": (metric_dir / f"{stem}.viz.json").exists(),
                    }
                )
            if frames:
                metrics[metric_dir.name] = frames
        if metrics:
            symbols[symbol_dir.name] = metrics
    return {"symbols": symbols}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def load_result(symbol: str, metric: str, timeframe: str) -> dict:
    folder = results_dir(symbol, metric)
    if not SAFE_NAME.match(timeframe):
        raise ValueError("invalid results path")
    result_path = folder / f"{timeframe}.json"
    viz_path = folder / f"{timeframe}.viz.json"
    if not result_path.exists():
        raise FileNotFoundError(f"No result for {symbol}/{metric}/{timeframe}")
    result = load_json(result_path)
    viz = load_json(viz_path) if viz_path.exists() else None
    return {"result": result, "viz": viz}


def load_summary(symbol: str, metric: str) -> dict:
    folder = results_dir(symbol, metric)
    path = folder / "summary.json"
    if path.exists():
        return load_json(path)
    frames = []
    catalog = list_results()["symbols"].get(symbol, {}).get(metric, [])
    for item in catalog:
        payload = load_json(folder / f"{item['timeframe']}.json")
        payload.pop("grid", None)
        frames.append(payload)
    if not frames:
        raise FileNotFoundError(f"No results for {symbol}/{metric}")
    ranked = sorted(
        [row for row in frames if "error" not in row],
        key=lambda row: (
            round(float(row.get("win_rate") or 0), 2),
            round(float(row.get("profit_pct") or 0), 4),
            int(row.get("closed_trades") or 0),
        ),
        reverse=True,
    )
    return {
        "symbol": symbol,
        "metric": metric,
        "best_overall": ranked[0] if ranked else None,
        "by_timeframe": frames,
    }
