import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartZone } from "./Chart";
import { fetchCatalog, fetchMeta, streamChart, watchUrl } from "./api";
import { runFrontendOptimization } from "./gmaOptimizer";
import { DEFAULT_PARAMS, GMA_LENGTH_MAX, GMA_LENGTH_MIN, GMA_SIGMA_MAX, GMA_SIGMA_MIN, gmaScale, isValidGmaPair, OPTIMIZE_OPTIONS, type Bar, type GmaParams, type LoadProgress, type OptimizeMetric, type OptimizeProgress, type OptimizeResult } from "./types";

import { computeTradeStats, formatActions, formatPct, formatPoints, formatWinRateLine, isUpAction, withActions } from "./tradeStats";

function formatPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatClock(iso: string | null, zone: ChartZone): string {
  if (!iso) return "—";
  return formatChartTime(Math.floor(new Date(iso).getTime() / 1000), zone, true);
}

function optimizationScore(result: OptimizeResult, metric: OptimizeMetric): string {
  const value = {
    total_win_rate: result.win_rate,
    call_win_rate: result.call_win_rate,
    put_win_rate: result.put_win_rate,
    total_profit_pct: result.profit_pct,
    call_profit_pct: result.call_profit_pct,
    put_profit_pct: result.put_profit_pct,
  }[metric];
  return value == null ? "—" : `${value.toFixed(metric.includes("win_rate") ? 1 : 2)}%`;
}

export default function App() {
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [path, setPath] = useState("");
  const [source, setSource] = useState<"ohlcv" | "trades" | "continuous" | "">("");
  const [chartZone, setChartZone] = useState<ChartZone>("local");
  const [params, setParams] = useState<GmaParams>(DEFAULT_PARAMS);
  const [draft, setDraft] = useState<GmaParams>(DEFAULT_PARAMS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "stale">("idle");
  const [busy, setBusy] = useState(false);
  const [applyingGma, setApplyingGma] = useState(false);
  const [chartProgress, setChartProgress] = useState<LoadProgress | null>(null);
  const [optimizationFeature, setOptimizationFeature] = useState<OptimizeMetric>("total_profit_pct");
  const [optimizationProgress, setOptimizationProgress] = useState<OptimizeProgress | null>(null);
  const [optimizationResult, setOptimizationResult] = useState<OptimizeResult | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [gmaApplied, setGmaApplied] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const fingerprintRef = useRef("");
  const paramsRef = useRef(params);
  const requestRef = useRef(0);
  paramsRef.current = params;
  const locked = false;

  const symbols = useMemo(() => Object.keys(catalog).sort(), [catalog]);
  const timeframes = catalog[symbol] ?? [];
  const effectiveTf = timeframe;
  const dataSource = "continuous" as const;
  const last = bars.at(-1) ?? null;
  const labeledBars = useMemo(() => withActions(bars), [bars]);
  const tradeStats = useMemo(
    () => (gmaApplied ? computeTradeStats(labeledBars) : computeTradeStats([])),
    [gmaApplied, labeledBars]
  );
  const fastScale = gmaScale(draft.fastLength, draft.fastSigma);
  const slowScale = gmaScale(draft.slowLength, draft.slowSigma);
  const gmaPairOk = isValidGmaPair(draft);

  const loadCatalog = useCallback(async () => {
    const data = await fetchCatalog();
    setCatalog(data.symbols);
    const nextSymbol =
      symbol && data.symbols[symbol] ? symbol : Object.keys(data.symbols).sort()[0] ?? "";
    const nextFrames = data.symbols[nextSymbol] ?? [];
    const keepTf = nextFrames.includes(timeframe);
    setSymbol(nextSymbol);
    if (keepTf) {
      setTimeframe(timeframe);
    } else {
      setTimeframe(nextFrames[0] ?? "");
    }
  }, [symbol, timeframe]);

  const loadChart = useCallback(
    async (
      refresh: boolean,
      nextSymbol = symbol,
      nextTf = effectiveTf,
      nextParams = paramsRef.current
    ) => {
      if (!nextSymbol || !nextTf) return;
      const requestId = ++requestRef.current;
      setBusy(true);
      try {
        const data = await streamChart(
          nextSymbol,
          nextTf,
          nextParams,
          refresh,
          (progress) => setChartProgress(progress),
          dataSource
        );
        if (requestId !== requestRef.current) return;
        fingerprintRef.current = data.fingerprint;
        setBars(data.bars);
        setUpdated(data.updated);
        setLoadedAt(data.loaded_at);
        setPath(data.path);
        setSource(data.source);
        setStatus("live");
        setError(null);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message === "Stream closed before it finished") {
          setError(null);
          setStatus("loading");
        } else {
          setError(message);
          setStatus("stale");
        }
      } finally {
        if (requestId === requestRef.current) {
          setBusy(false);
          setChartProgress(null);
          setApplyingGma(false);
        }
      }
    },
    [symbol, effectiveTf, dataSource]
  );

  useEffect(() => {
    loadCatalog().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // Catalog is loaded once; symbol/timeframe then drive chart fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pairRef = useRef("");
  useEffect(() => {
    if (!symbol || !effectiveTf) return;
    const pair = `${symbol}|${effectiveTf}|${dataSource}`;
    const refresh = pairRef.current !== pair;
    pairRef.current = pair;
    if (refresh) setStatus("loading");
    loadChart(refresh, symbol, effectiveTf, params).catch(() => undefined);
  }, [symbol, effectiveTf, dataSource, params, loadChart]);

  useEffect(() => {
    if (locked || !symbol || !effectiveTf) return;
    const sourceStream = new EventSource(watchUrl(symbol, effectiveTf, dataSource));
    sourceStream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type: string;
          fingerprint?: string;
        };
        if (
          payload.type === "update" &&
          payload.fingerprint !== fingerprintRef.current
        ) {
          loadChart(true).catch(() => undefined);
        }
      } catch {
        /* ignore malformed events */
      }
    };
    sourceStream.onerror = () => {
      if (sourceStream.readyState === EventSource.CLOSED) {
        setStatus((prev) => (prev === "loading" ? prev : "stale"));
      }
    };
    const poll = window.setInterval(() => {
      fetchMeta(symbol, effectiveTf, dataSource)
        .then((meta) => {
          if (
            meta.fingerprint &&
            meta.fingerprint !== fingerprintRef.current
          ) {
            loadChart(true).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 8000);
    return () => {
      sourceStream.close();
      window.clearInterval(poll);
    };
  }, [symbol, effectiveTf, dataSource, loadChart, locked]);

  const resetSeriesControls = () => {
    setDraft(DEFAULT_PARAMS);
    setParams(DEFAULT_PARAMS);
    setGmaApplied(false);
    setOptimizationProgress(null);
    setOptimizationResult(null);
  };

  const applyGma = () => {
    if (!locked && gmaPairOk) {
      setApplyingGma(true);
      setStatus("loading");
      setParams(draft);
      setGmaApplied(true);
    }
  };

  const optimizeGmas = async () => {
    if (locked || !symbol || !effectiveTf || busy || optimizing) return;
    setOptimizing(true);
    setOptimizationProgress(null);
    setOptimizationResult(null);
    setError(null);
    try {
      const result = await runFrontendOptimization(
        bars,
        symbol,
        effectiveTf,
        optimizationFeature,
        (progress) => setOptimizationProgress(progress),
      );
      setOptimizationResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
      setOptimizationProgress(null);
    }
  };

  const applyOptimizedGmas = () => {
    if (!optimizationResult) return;
    const best: GmaParams = {
      fastLength: optimizationResult.params.fast_length,
      fastSigma: optimizationResult.params.fast_sigma,
      slowLength: optimizationResult.params.slow_length,
      slowSigma: optimizationResult.params.slow_sigma,
    };
    setDraft(best);
    setParams(best);
    setGmaApplied(true);
    setApplyingGma(true);
    setStatus("loading");
  };

  return (
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">GMAXO</span>
          <span className="brand-sub">Dual Gaussian MA</span>
        </div>
        <label className="field">
          <span>Symbol</span>
          <select
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
              resetSeriesControls();
            }}
            disabled={locked || !symbols.length}
          >
            {symbols.length === 0 && <option value="">No symbols</option>}
            {symbols.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Timeframe</span>
          <select
            value={timeframe}
            onChange={(e) => {
              setTimeframe(e.target.value);
              resetSeriesControls();
            }}
            disabled={locked || !timeframes.length}
          >
            <option value="">Select timeframe</option>
            {timeframes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button
          className="refresh"
          type="button"
          onClick={() => loadChart(true)}
          disabled={locked || busy || !symbol || !effectiveTf}
        >
          {locked
            ? "Locked"
            : busy
                ? chartProgress?.total
                  ? `Loading ${Math.round(chartProgress.pct)}%`
                  : "Loading…"
                : "Refresh GCS"}
        </button>
        <div className={`live-pill ${locked ? "paused" : status}`}>
          <span className="dot" />
          {locked
            ? "Paused"
            : status === "live"
                ? "Listening"
                : status === "loading"
                  ? "Loading"
                  : status === "stale"
                    ? "Reconnect"
                    : "Idle"}
        </div>
      </header>

      <aside className="sidebar">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
        <section>
          <h2>Fast GMA</h2>
          <p className="hint">EMA 3 · Length {draft.fastLength} · σ {draft.fastSigma.toFixed(1)} · L/σ {fastScale.toFixed(2)}</p>
          <label>
            Length
            <input
              type="range"
              min={GMA_LENGTH_MIN}
              max={GMA_LENGTH_MAX}
              value={draft.fastLength}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, fastLength: Number(e.target.value) })}
            />
            <input
              type="number"
              min={GMA_LENGTH_MIN}
              max={GMA_LENGTH_MAX}
              value={draft.fastLength}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, fastLength: Number(e.target.value) })}
            />
          </label>
          <label>
            Sigma
            <input
              type="range"
              min={GMA_SIGMA_MIN}
              max={GMA_SIGMA_MAX}
              step={0.5}
              value={draft.fastSigma}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, fastSigma: Number(e.target.value) })}
            />
            <input
              type="number"
              min={GMA_SIGMA_MIN}
              max={GMA_SIGMA_MAX}
              step={0.5}
              value={draft.fastSigma}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, fastSigma: Number(e.target.value) })}
            />
          </label>
        </section>
        <section>
          <h2>Slow GMA</h2>
          <p className="hint">SMA 3 · Length {draft.slowLength} · σ {draft.slowSigma.toFixed(1)} · L/σ {slowScale.toFixed(2)}</p>
          <label>
            Length
            <input
              type="range"
              min={GMA_LENGTH_MIN}
              max={GMA_LENGTH_MAX}
              value={draft.slowLength}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, slowLength: Number(e.target.value) })}
            />
            <input
              type="number"
              min={GMA_LENGTH_MIN}
              max={GMA_LENGTH_MAX}
              value={draft.slowLength}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, slowLength: Number(e.target.value) })}
            />
          </label>
          <label>
            Sigma
            <input
              type="range"
              min={GMA_SIGMA_MIN}
              max={GMA_SIGMA_MAX}
              step={0.5}
              value={draft.slowSigma}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, slowSigma: Number(e.target.value) })}
            />
            <input
              type="number"
              min={GMA_SIGMA_MIN}
              max={GMA_SIGMA_MAX}
              step={0.5}
              value={draft.slowSigma}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, slowSigma: Number(e.target.value) })}
            />
          </label>
          {!gmaPairOk && (
            <p className="hint warn">Invalid pair: fast L/σ must be less than slow L/σ</p>
          )}
          <button
            type="button"
            className="optimize apply-gma"
            disabled={locked || !gmaPairOk || !symbol || !effectiveTf || busy || optimizing}
            onClick={applyGma}
          >
            {applyingGma
              ? chartProgress?.total
                ? `Applying GMAs ${Math.round(chartProgress.pct)}%`
                : "Applying GMAs…"
              : "Apply GMAs"}
          </button>
        </section>
        <section className="gma-optimizer">
          <h2>Optimize GMAs</h2>
          <label>
            Feature
            <select
              value={optimizationFeature}
              disabled={locked || busy || optimizing || !symbol || !effectiveTf}
              onChange={(event) => {
                setOptimizationFeature(event.target.value as OptimizeMetric);
                setOptimizationResult(null);
              }}
            >
              {OPTIMIZE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label.replace("Maximize ", "")}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="optimize"
            disabled={locked || busy || optimizing || !symbol || !effectiveTf}
            onClick={optimizeGmas}
          >
            {optimizing
              ? optimizationProgress
                ? `Optimizing ${Math.round(optimizationProgress.pct)}%`
                : "Starting optimization…"
              : "Optimize GMAs"}
          </button>
          {optimizationProgress && (
            <p className="hint optimizer-status">
              {optimizationProgress.message}
            </p>
          )}
          {optimizationResult && (
            <div className="optimizer-result">
              <p className="hint">
                Best {optimizationFeature.replaceAll("_", " ")}: {optimizationScore(optimizationResult, optimizationFeature)}
              </p>
              <p className="optimizer-params">
                F {optimizationResult.params.fast_length}/{optimizationResult.params.fast_sigma.toFixed(1)} · S {optimizationResult.params.slow_length}/{optimizationResult.params.slow_sigma.toFixed(1)}
              </p>
              <button
                type="button"
                className="optimize apply-gma"
                disabled={busy || optimizing}
                onClick={applyOptimizedGmas}
              >
                Apply Best GMAs
              </button>
            </div>
          )}
        </section>
        <section className="stats">
          <h2>Session</h2>
          {bars.length < Math.max(params.fastLength, params.slowLength) && (
            <p className="hint">
              GMA lines appear after {Math.max(params.fastLength, params.slowLength)} bars
              ({bars.length} loaded).
            </p>
          )}
          <dl>
            <div>
              <dt>Last</dt>
              <dd>{formatPrice(last?.close)}</dd>
            </div>
            <div><dt>Bars</dt><dd>{bars.length}</dd></div>
            <div>
              <dt>Last action</dt>
              <dd className={tradeStats.lastActions.some(isUpAction) ? "buy" : tradeStats.lastActions.length ? "sell" : ""}>
                {formatActions(tradeStats.lastActions)}
              </dd>
            </div>
            <div className="group-start">
              <dt>Total %</dt>
              <dd className={tradeStats.profitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.profitPct)}
              </dd>
            </div>
            <div>
              <dt>Total win rate</dt>
              <dd>
                {formatWinRateLine(tradeStats.winRate, tradeStats.wins, tradeStats.closedTrades)}
              </dd>
            </div>
            <div>
              <dt>Max drawdown %</dt>
              <dd className={tradeStats.maxDrawdownPct < 0 ? "sell" : ""}>
                {formatPct(tradeStats.maxDrawdownPct)}
              </dd>
            </div>
            <div>
              <dt>Max runup %</dt>
              <dd className={tradeStats.maxRunupPct > 0 ? "buy" : ""}>
                {formatPct(tradeStats.maxRunupPct)}
              </dd>
            </div>
            <div className="group-start">
              <dt>Long %</dt>
              <dd className={tradeStats.callProfitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.callProfitPct)}
              </dd>
            </div>
            <div>
              <dt>Long win rate</dt>
              <dd>
                {formatWinRateLine(tradeStats.callWinRate, tradeStats.callWins, tradeStats.closeCalls)}
              </dd>
            </div>
            <div><dt>Open longs</dt><dd className="buy">{tradeStats.openCalls}</dd></div>
            <div><dt>Close longs</dt><dd className="buy">{tradeStats.closeCalls}</dd></div>
            <div className="group-start">
              <dt>Short %</dt>
              <dd className={tradeStats.putProfitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.putProfitPct)}
              </dd>
            </div>
            <div>
              <dt>Short win rate</dt>
              <dd>
                {formatWinRateLine(tradeStats.putWinRate, tradeStats.putWins, tradeStats.closePuts)}
              </dd>
            </div>
            <div><dt>Open shorts</dt><dd className="sell">{tradeStats.openPuts}</dd></div>
            <div><dt>Close shorts</dt><dd className="sell">{tradeStats.closePuts}</dd></div>
            {tradeStats.openPosition && tradeStats.unrealized != null && tradeStats.unrealizedPct != null && (
              <div className="group-start">
                <dt>Open {tradeStats.openSide === "long" ? "long" : "short"}</dt>
                <dd className={tradeStats.unrealized >= 0 ? "buy" : "sell"}>
                  {formatPoints(tradeStats.unrealized)} / {formatPct(tradeStats.unrealizedPct)}
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section className="timezone">
          <h2>Timezone</h2>
          <select value={chartZone} onChange={(e) => setChartZone(e.target.value as ChartZone)}>
            {CHART_ZONES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </section>
      </aside>

      <main className="stage">
        {error && <div className="banner">{error}</div>}
        <div className="chart-panel">
          <Chart
            bars={labeledBars}
            fitKey={`${symbol}|${effectiveTf}`}
            timeZone={chartZone}
            showIndicators={gmaApplied}
          />
        </div>
        <section className="legend">
          <h2>Legend</h2>
          <div><i className="swatch fast" /> Fast GMA (EMA 3)</div>
          <div><i className="swatch slow" /> Slow GMA (SMA 3)</div>
          <div><i className="arrow buy" /> Long entry / short exit</div>
          <div><i className="arrow sell" /> Short entry / long exit</div>
        </section>
      </main>

      <footer className="status">
        <span>gs://live-trading-bot/{path || `${symbol || "—"}/${effectiveTf || "—"}`}</span>
        <span>
          {source === "continuous" ? "Continuous timeframe CSV" : ""}
        </span>
        <span>Object updated {formatClock(updated, chartZone)}</span>
        <span>Cached {formatClock(loadedAt, chartZone)}</span>
        <span>
          Last bar {last ? formatChartTime(last.time, chartZone, true) : "—"} · UTC
        </span>
      </footer>
    </div>
  );
}
