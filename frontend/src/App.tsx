import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartHandle, type ChartZone } from "./Chart";
import { fetchCatalog, fetchChart, fetchMeta, fetchTimeframes, streamChart, watchUrl } from "./api";
import { runFrontendOptimization, runMultiTimeframeOptimization, type CrossTfProgress, type CrossTfResult, type LabelScoringOptions } from "./gmaOptimizer";
import { CROSS_TF_OPTIMIZE_OPTIONS, DEFAULT_MANUAL_WINDOW, DEFAULT_PARAMS, GMA_LENGTH_MAX, GMA_LENGTH_MIN, GMA_SIGMA_MAX, GMA_SIGMA_MIN, clampGmaParams, gmaScale, isValidGmaPair, OPTIMIZE_OPTIONS, type Bar, type GmaParams, type LoadProgress, type ManualEntryWindow, type ManualPoint, type ManualSelectionMode, type OptimizeMetric, type OptimizeProgress, type OptimizeResult } from "./types";

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
  if (metric === "label_score") {
    const total = result.label_score?.totalScore;
    if (total == null || !Number.isFinite(total)) return "—";
    const sign = total > 0 ? "+" : "";
    return `${sign}${total.toFixed(2)}`;
  }
  const value = {
    total_win_rate: result.win_rate,
    call_win_rate: result.call_win_rate,
    put_win_rate: result.put_win_rate,
    total_profit_pct: result.profit_pct,
    call_profit_pct: result.call_profit_pct,
    put_profit_pct: result.put_profit_pct,
    max_runup_pct: result.max_runup_pct,
    avg_max_runup_pct: result.avg_max_runup_pct,
  }[metric];
  return value == null ? "—" : `${value.toFixed(metric.includes("win_rate") ? 1 : 2)}%`;
}

function optimizationLabel(metric: OptimizeMetric): string {
  return OPTIMIZE_OPTIONS.find((option) => option.id === metric)?.label.replace("Maximize ", "") ?? metric;
}

export default function App() {
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [timeframesBySymbol, setTimeframesBySymbol] = useState<Record<string, string[]>>({});
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("");
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
  const [minTrades, setMinTrades] = useState(1);
  const [maxTrades, setMaxTrades] = useState<number | null>(null);
  const [optimizationProgress, setOptimizationProgress] = useState<OptimizeProgress | null>(null);
  const [optimizationResult, setOptimizationResult] = useState<OptimizeResult | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [crossTfFeature, setCrossTfFeature] = useState<OptimizeMetric>("total_win_rate");
  const [crossTfProgress, setCrossTfProgress] = useState<CrossTfProgress | null>(null);
  const [crossTfResult, setCrossTfResult] = useState<CrossTfResult | null>(null);
  const [crossTfOptimizing, setCrossTfOptimizing] = useState(false);
  const [gmaApplied, setGmaApplied] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [manualMode, setManualMode] = useState<ManualSelectionMode>("off");
  const [entryPoints, setEntryPoints] = useState<ManualPoint[]>([]);
  const [exitPoints, setExitPoints] = useState<ManualPoint[]>([]);
  const [entryWindow, setEntryWindow] = useState<ManualEntryWindow>(DEFAULT_MANUAL_WINDOW);
  const fingerprintRef = useRef("");
  const paramsRef = useRef(params);
  const requestRef = useRef(0);
  const chartHandleRef = useRef<ChartHandle | null>(null);
  paramsRef.current = params;
  const locked = false;

  const symbols = useMemo(() => Object.keys(catalog).sort(), [catalog]);
  const timeframes = timeframesBySymbol[symbol] ?? [];
  const timeframesLoading = Boolean(symbol) && !timeframesBySymbol[symbol];
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
    setSymbol(nextSymbol);
    // Timeframes resolve on demand below; clearing forces the default pick.
    setTimeframe("");
  }, [symbol]);

  // Fetch timeframes for the selected symbol on demand; default to the first
  // option so the chart loads immediately without preloading other series.
  useEffect(() => {
    if (!symbol) return;
    const cached = timeframesBySymbol[symbol];
    if (cached) {
      setTimeframe((current) =>
        current && cached.includes(current) ? current : cached[0] ?? ""
      );
      return;
    }
    let cancelled = false;
    fetchTimeframes(symbol)
      .then((frames) => {
        if (cancelled) return;
        setTimeframesBySymbol((prev) => ({ ...prev, [symbol]: frames }));
        setTimeframe((current) =>
          current && frames.includes(current) ? current : frames[0] ?? ""
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframesBySymbol]);

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
    }, 60000);
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

  /** Toggle a manual entry/exit point on or off, keeping the list sorted by time. */
  const toggleManualPoint = (
    kind: "entry" | "exit",
    index: number,
    time: number,
  ) => {
    const setter = kind === "entry" ? setEntryPoints : setExitPoints;
    setter((current) => {
      const exists = current.some(
        (point) => point.index === index || point.time === time,
      );
      if (exists) {
        return current.filter(
          (point) => point.index !== index && point.time !== time,
        );
      }
      return [...current, { index, time }].sort((a, b) => a.index - b.index);
    });
  };

  const removeManualPoint = (
    kind: "entry" | "exit",
    index: number,
    time: number,
  ) => {
    const setter = kind === "entry" ? setEntryPoints : setExitPoints;
    setter((current) =>
      current.filter(
        (point) => point.index !== index || point.time !== time,
      ),
    );
  };

  const clearManualPoints = (kind: "entry" | "exit") => {
    const setter = kind === "entry" ? setEntryPoints : setExitPoints;
    setter([]);
  };

  // Bar indices/timestamps are only meaningful for the currently loaded series;
  // drop stale manual points whenever the symbol or timeframe changes.
  useEffect(() => {
    setEntryPoints([]);
    setExitPoints([]);
    setManualMode("off");
  }, [symbol, effectiveTf]);

  // The captured entry/exit points + acceptable window form the ground-truth
  // labels the optimizer scores against when `label_score` is the objective.
  const hasManualLabels = entryPoints.length > 0 || exitPoints.length > 0;
  const labelScoring: LabelScoringOptions = useMemo(
    () => ({
      labels: {
        entries: entryPoints.map((p) => ({ barIndex: p.index, time: p.time })),
        exits: exitPoints.map((p) => ({ barIndex: p.index, time: p.time })),
      },
      window: { preSignal: entryWindow.preSignal, lag: entryWindow.lag },
    }),
    [entryPoints, exitPoints, entryWindow],
  );

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
        minTrades,
        maxTrades,
        (progress) => setOptimizationProgress(progress),
        labelScoring,
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
    const best: GmaParams = clampGmaParams({
      fastLength: optimizationResult.params.fast_length,
      fastSigma: optimizationResult.params.fast_sigma,
      slowLength: optimizationResult.params.slow_length,
      slowSigma: optimizationResult.params.slow_sigma,
    });
    setDraft(best);
    setParams(best);
    setGmaApplied(true);
    setApplyingGma(true);
    setStatus("loading");
  };

  const optimizeCrossTimeframes = async () => {
    if (locked || !symbol || !timeframes.length || crossTfOptimizing) return;
    setCrossTfOptimizing(true);
    setCrossTfProgress(null);
    setCrossTfResult(null);
    setError(null);
    try {
      const series = await Promise.all(
        timeframes.map(async (tf) => {
          const data = await fetchChart(symbol, tf, dataSource);
          return { timeframe: tf, bars: data.bars };
        }),
      );
      const result = await runMultiTimeframeOptimization(
        series,
        symbol,
        crossTfFeature,
        minTrades,
        maxTrades,
        (progress) => setCrossTfProgress(progress),
        labelScoring,
      );
      setCrossTfResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCrossTfOptimizing(false);
      setCrossTfProgress(null);
    }
  };

  const applyCrossTfResult = () => {
    if (!crossTfResult) return;
    const best: GmaParams = clampGmaParams({
      fastLength: crossTfResult.params.fast_length,
      fastSigma: crossTfResult.params.fast_sigma,
      slowLength: crossTfResult.params.slow_length,
      slowSigma: crossTfResult.params.slow_sigma,
    });
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
              setTimeframe("");
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
            disabled={locked || timeframesLoading || !timeframes.length}
          >
            {timeframesLoading ? (
              <option value="">Loading timeframes…</option>
            ) : timeframes.length === 0 ? (
              <option value="">No timeframes</option>
            ) : (
              <>
                <option value="">Select timeframe</option>
                {timeframes.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </>
            )}
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
          <label className="optimizer-feature">
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
          <div className="trade-filter">
            <label>
              Min trades
              <input
                type="number"
                min={1}
                value={minTrades}
                disabled={locked || busy || optimizing || !symbol || !effectiveTf}
                onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label>
              Max trades
              <input
                type="number"
                min={1}
                value={maxTrades ?? ""}
                placeholder="None"
                disabled={locked || busy || optimizing || !symbol || !effectiveTf}
                onChange={(e) => {
                  const raw = e.target.value;
                  setMaxTrades(raw === "" ? null : Math.max(1, Number(raw) || 1));
                }}
              />
            </label>
          </div>
          <button
            type="button"
            className="optimize"
            disabled={
              locked ||
              busy ||
              optimizing ||
              !symbol ||
              !effectiveTf ||
              (optimizationFeature === "label_score" && !hasManualLabels)
            }
            onClick={optimizeGmas}
          >
            {optimizing
              ? optimizationProgress
                ? `Optimizing ${Math.round(optimizationProgress.pct)}%`
                : "Starting optimization…"
              : "Optimize GMAs"}
          </button>
          {optimizationFeature === "label_score" && !hasManualLabels && (
            <p className="hint optimizer-status">
              Select entry/exit points in Manual Optimization first — the label
              score needs ground-truth bars to optimize against.
            </p>
          )}
          {optimizationProgress && (
            <p className="hint optimizer-status">
              {optimizationProgress.message}
            </p>
          )}
          {optimizationResult && (
            <div className="optimizer-result">
              <div className="optimizer-score">
                <span>Best {optimizationLabel(optimizationFeature)}</span>
                <strong>{optimizationScore(optimizationResult, optimizationFeature)}</strong>
              </div>
              <dl className="optimizer-params">
                <div><dt>Fast GMA</dt><dd>L {optimizationResult.params.fast_length} · σ {optimizationResult.params.fast_sigma.toFixed(1)}</dd></div>
                <div><dt>Slow GMA</dt><dd>L {optimizationResult.params.slow_length} · σ {optimizationResult.params.slow_sigma.toFixed(1)}</dd></div>
              </dl>
              {optimizationFeature === "label_score" &&
                optimizationResult.label_score && (
                  <dl className="optimizer-params label-score-breakdown">
                    <div><dt>Entry proximity</dt><dd>+{optimizationResult.label_score.entryProximitySum.toFixed(2)}</dd></div>
                    <div><dt>Exit proximity</dt><dd>+{optimizationResult.label_score.exitProximitySum.toFixed(2)}</dd></div>
                    <div><dt>Matched E</dt><dd>{optimizationResult.label_score.entryMatches.length}</dd></div>
                    <div><dt>Matched X</dt><dd>{optimizationResult.label_score.exitMatches.length}</dd></div>
                    <div><dt>False positives</dt><dd className="neg">{optimizationResult.label_score.falsePositives}</dd></div>
                    <div><dt>Missed E</dt><dd className="neg">{optimizationResult.label_score.entryFalseNegatives}</dd></div>
                    <div><dt>Missed X</dt><dd className="neg">{optimizationResult.label_score.exitFalseNegatives}</dd></div>
                    <div><dt>Total</dt><dd className="total">{optimizationScore(optimizationResult, "label_score")}</dd></div>
                  </dl>
                )}
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
        <section className="manual-optimizer">
          <h2>Manual Optimization</h2>
          <p className="hint">
            Pick a mode, then click the chart to mark bars. Selected points are
            stored as timestamps and shown below.
          </p>
          <div className="view-toggle manual-mode-toggle">
            <button
              type="button"
              className={manualMode === "off" ? "active" : ""}
              disabled={busy || !symbol || !effectiveTf}
              onClick={() => setManualMode("off")}
            >
              Off
            </button>
            <button
              type="button"
              className={manualMode === "entry" ? "active" : ""}
              disabled={busy || !symbol || !effectiveTf}
              onClick={() => setManualMode("entry")}
            >
              Entry E
            </button>
            <button
              type="button"
              className={manualMode === "exit" ? "active" : ""}
              disabled={busy || !symbol || !effectiveTf}
              onClick={() => setManualMode("exit")}
            >
              Exit X
            </button>
          </div>
          {manualMode !== "off" && (
            <p className="hint manual-mode-hint">
              {manualMode === "entry"
                ? "Click chart to mark target entry points (E)."
                : "Click chart to mark target exit points (X)."}{" "}
              Click an existing point to remove it.
            </p>
          )}
          <fieldset className="manual-window">
            <legend>Acceptable Entry Window</legend>
            <label>
              Pre-Signal
              <input
                type="number"
                min={0}
                value={entryWindow.preSignal}
                disabled={busy}
                onChange={(e) =>
                  setEntryWindow((w) => ({
                    ...w,
                    preSignal: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
              />
            </label>
            <label>
              Lag
              <input
                type="number"
                min={0}
                value={entryWindow.lag}
                disabled={busy}
                onChange={(e) =>
                  setEntryWindow((w) => ({
                    ...w,
                    lag: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
              />
            </label>
            <p className="hint manual-formula">
              Acceptable entry range: [t − {entryWindow.preSignal}, t +{" "}
              {entryWindow.lag}]
            </p>
          </fieldset>
          <div className="manual-points-block">
            <div className="manual-points-head">
              <span className="manual-points-title">Entries (E)</span>
              <span className="manual-points-count">{entryPoints.length}</span>
              <button
                type="button"
                className="manual-clear"
                disabled={entryPoints.length === 0 || busy}
                onClick={() => clearManualPoints("entry")}
              >
                Clear
              </button>
            </div>
            {entryPoints.length === 0 ? (
              <p className="hint manual-empty">
                No target entry points selected.
              </p>
            ) : (
              <ul className="manual-list">
                {entryPoints.map((point, k) => (
                  <li key={`${point.index}-${point.time}`}>
                    <span className="manual-kind entry">E{k + 1}</span>
                    <span className="manual-time">
                      {formatChartTime(point.time, chartZone, true)}
                    </span>
                    <span className="manual-bar">bar {point.index}</span>
                    <button
                      type="button"
                      className="manual-remove"
                      aria-label={`Remove entry ${k + 1}`}
                      onClick={() =>
                        removeManualPoint("entry", point.index, point.time)
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="manual-points-block">
            <div className="manual-points-head">
              <span className="manual-points-title">Exits (X)</span>
              <span className="manual-points-count">{exitPoints.length}</span>
              <button
                type="button"
                className="manual-clear"
                disabled={exitPoints.length === 0 || busy}
                onClick={() => clearManualPoints("exit")}
              >
                Clear
              </button>
            </div>
            {exitPoints.length === 0 ? (
              <p className="hint manual-empty">No target exits selected.</p>
            ) : (
              <ul className="manual-list">
                {exitPoints.map((point, k) => (
                  <li key={`${point.index}-${point.time}`}>
                    <span className="manual-kind exit">X{k + 1}</span>
                    <span className="manual-time">
                      {formatChartTime(point.time, chartZone, true)}
                    </span>
                    <span className="manual-bar">bar {point.index}</span>
                    <button
                      type="button"
                      className="manual-remove"
                      aria-label={`Remove X${k + 1}`}
                      onClick={() =>
                        removeManualPoint("exit", point.index, point.time)
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
              <dt>Avg max drawdown %</dt>
              <dd className={tradeStats.avgMaxDrawdownPct < 0 ? "sell" : ""}>
                {formatPct(tradeStats.avgMaxDrawdownPct)}
              </dd>
            </div>
            <div>
              <dt>Max runup %</dt>
              <dd className={tradeStats.maxRunupPct > 0 ? "buy" : ""}>
                {formatPct(tradeStats.maxRunupPct)}
              </dd>
            </div>
            <div>
              <dt>Avg max runup %</dt>
              <dd className={tradeStats.avgMaxRunupPct > 0 ? "buy" : ""}>
                {formatPct(tradeStats.avgMaxRunupPct)}
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
        <section className="cross-tf-bar">
          <span className="cross-tf-title">Cross-Timeframe Optimize</span>
          <label className="field">
            <span>Feature</span>
            <select
              value={crossTfFeature}
              disabled={locked || crossTfOptimizing || !symbol || !timeframes.length}
              onChange={(event) => {
                setCrossTfFeature(event.target.value as OptimizeMetric);
                setCrossTfResult(null);
              }}
            >
              {CROSS_TF_OPTIMIZE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field trade-filter-field">
            <span>Min trades</span>
            <input
              type="number"
              min={1}
              value={minTrades}
              disabled={locked || crossTfOptimizing || !symbol || !timeframes.length}
              onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label className="field trade-filter-field">
            <span>Max trades</span>
            <input
              type="number"
              min={1}
              value={maxTrades ?? ""}
              placeholder="None"
              disabled={locked || crossTfOptimizing || !symbol || !timeframes.length}
              onChange={(e) => {
                const raw = e.target.value;
                setMaxTrades(raw === "" ? null : Math.max(1, Number(raw) || 1));
              }}
            />
          </label>
          <button
            type="button"
            className="optimize"
            disabled={locked || !symbol || !timeframes.length || crossTfOptimizing || busy}
            onClick={optimizeCrossTimeframes}
          >
            {crossTfOptimizing
              ? crossTfProgress
                ? `Optimizing ${Math.round(crossTfProgress.pct)}%`
                : "Loading timeframes…"
              : "Optimize All Timeframes"}
          </button>
          {crossTfProgress && (
            <span className="cross-tf-status">
              {crossTfProgress.timeframesDone.length > 0 &&
                `Done: ${crossTfProgress.timeframesDone.join(", ")} · `}
              {crossTfProgress.message}
            </span>
          )}
          {crossTfResult && (
            <div className="cross-tf-result">
              <span>
                Best <strong className="cross-tf-best-tf">{crossTfResult.timeframe}</strong> ·{" "}
                {optimizationLabel(crossTfFeature)}
              </span>
              <strong>{optimizationScore(crossTfResult, crossTfFeature)}</strong>
              <span>
                Fast L {crossTfResult.params.fast_length} · σ{" "}
                {crossTfResult.params.fast_sigma.toFixed(1)}
              </span>
              <span>
                Slow L {crossTfResult.params.slow_length} · σ{" "}
                {crossTfResult.params.slow_sigma.toFixed(1)}
              </span>
              <button
                type="button"
                className="optimize"
                disabled={busy || optimizing || crossTfOptimizing}
                onClick={applyCrossTfResult}
              >
                Apply
              </button>
            </div>
          )}
        </section>
        <div className="chart-panel">
          <Chart
            ref={chartHandleRef}
            bars={labeledBars}
            fitKey={`${symbol}|${effectiveTf}`}
            timeZone={chartZone}
            showIndicators={gmaApplied}
            selectionMode={manualMode}
            entryPoints={entryPoints}
            exitPoints={exitPoints}
            onSelectPoint={toggleManualPoint}
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
        <span>
          {source === "continuous" ? "Continuous timeframe CSV" : ""}
        </span>
        <span>Object updated {formatClock(updated, chartZone)}</span>
        <span>Cached {formatClock(loadedAt, chartZone)}</span>
        <span>
          Last bar {last ? formatChartTime(last.time, chartZone, true) : "—"} · UTC
          <button
            type="button"
            className="chart-scroll-front"
            title="Jump to latest bar"
            onClick={() => chartHandleRef.current?.scrollToFront()}
          >
            ›
          </button>
        </span>
      </footer>
    </div>
  );
}
