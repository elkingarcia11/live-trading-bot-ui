import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartHandle, type ChartZone } from "./Chart";
import { fetchCatalog, fetchChart, fetchMeta, fetchTimeframes, streamChart, watchUrl } from "./api";
import { isOptimizationAbort, runFrontendOptimization, runMultiTimeframeOptimization, type CrossTfProgress, type CrossTfResult, type LabelScoringOptions } from "./gmaOptimizer";
import { computeMacd } from "./macd";
import { CROSS_TF_OPTIMIZE_OPTIONS, CUSTOM_TIMEFRAME, DEFAULT_GMA_MACD_PARAMS, DEFAULT_MACD_PARAMS, DEFAULT_MANUAL_WINDOW, DEFAULT_PARAMS, GMA_LENGTH_MAX, GMA_LENGTH_MIN, GMA_MACD_LENGTH_MAX, GMA_MACD_LENGTH_MIN, GMA_MACD_SIGMA_MAX, GMA_MACD_SIGMA_MIN, GMA_SIGMA_MAX, GMA_SIGMA_MIN, MACD_FAST_MAX, MACD_PERIOD_MIN, MACD_SIGNAL_MAX, MACD_SLOW_MAX, clampGmaParams, gmaMacdFastScale, gmaMacdSlowScale, gmaScale, isValidGmaMacdPair, isValidGmaPair, isValidMacdPair, isValidTimeframeSpec, normalizeTimeframeSpec, OPTIMIZE_OPTIONS, type Bar, type GmaMacdParams, type GmaParams, type LoadProgress, type MacdParams, type ManualEntryWindow, type ManualPoint, type ManualSelectionMode, type OptimizeMetric, type OptimizeProgress, type OptimizeResult } from "./types";

import { computeTradeStats, formatActions, formatPct, formatPoints, formatWinRateLine, isUpAction, withActions, type SignalConfig } from "./tradeStats";

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
    average_profit_pct: result.average_profit_pct,
  }[metric];
  return value == null ? "—" : `${value.toFixed(metric.includes("win_rate") ? 1 : 2)}%`;
}

function optimizationLabel(metric: OptimizeMetric): string {
  return OPTIMIZE_OPTIONS.find((option) => option.id === metric)?.label.replace("Maximize ", "") ?? metric;
}

export default function App() {
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [timeframesBySymbol, setTimeframesBySymbol] = useState<Record<string, string[]>>({});
  const [customAvailableBySymbol, setCustomAvailableBySymbol] = useState<Record<string, boolean>>({});
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [source, setSource] = useState<"ohlcv" | "trades" | "continuous" | "">("");
  const [chartZone, setChartZone] = useState<ChartZone>("local");
  const [params, setParams] = useState<GmaParams>(DEFAULT_PARAMS);
  const [draft, setDraft] = useState<GmaParams>(DEFAULT_PARAMS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [chartPath, setChartPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "stale">("idle");
  const [busy, setBusy] = useState(false);
  const [applyingConfig, setApplyingConfig] = useState(false);
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
  const [macdDraft, setMacdDraft] = useState<MacdParams>(DEFAULT_MACD_PARAMS);
  const [macdApplied, setMacdApplied] = useState(false);
  const [gmaMacdDraft, setGmaMacdDraft] = useState<GmaMacdParams>(DEFAULT_GMA_MACD_PARAMS);
  const [gmaMacdApplied, setGmaMacdApplied] = useState(false);
  const [configGma, setConfigGma] = useState(false);
  const [configMacd, setConfigMacd] = useState(false);
  const [configGmaMacd, setConfigGmaMacd] = useState(false);
  const [optimizeGma, setOptimizeGma] = useState(true);
  const [optimizeMacd, setOptimizeMacd] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [manualMode, setManualMode] = useState<ManualSelectionMode>("off");
  const [entryPoints, setEntryPoints] = useState<ManualPoint[]>([]);
  const [exitPoints, setExitPoints] = useState<ManualPoint[]>([]);
  const [entryWindow, setEntryWindow] = useState<ManualEntryWindow>(DEFAULT_MANUAL_WINDOW);
  const fingerprintRef = useRef("");
  const paramsRef = useRef(params);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const chartHandleRef = useRef<ChartHandle | null>(null);
  const gmaOptAbortRef = useRef<AbortController | null>(null);
  const crossTfAbortRef = useRef<AbortController | null>(null);
  const customModeRef = useRef(customMode);
  customModeRef.current = customMode;
  paramsRef.current = params;
  const locked = false;

  const symbols = useMemo(() => Object.keys(catalog).sort(), [catalog]);
  const timeframes = timeframesBySymbol[symbol] ?? [];
  const timeframesLoading = Boolean(symbol) && !timeframesBySymbol[symbol];
  const customAvailable = Boolean(customAvailableBySymbol[symbol]);
  const listedTimeframe = Boolean(timeframe) && timeframes.includes(timeframe);
  const customSelectActive = customMode || Boolean(timeframe && !listedTimeframe);
  const effectiveTf = timeframe;
  const dataSource = "continuous" as const;
  const last = bars.at(-1) ?? null;
  const fastScale = gmaScale(draft.fastLength, draft.fastSigma);
  const slowScale = gmaScale(draft.slowLength, draft.slowSigma);
  const gmaPairOk = isValidGmaPair(draft);
  const macdPairOk = isValidMacdPair(macdDraft);
  const gmaMacdPairOk = isValidGmaMacdPair(gmaMacdDraft);
  const configActive = gmaApplied || macdApplied;
  const optimizeMacdOn = optimizeGma && optimizeMacd;
  const configValid =
    (configGma || configMacd || configGmaMacd) &&
    (!configGma || gmaPairOk) &&
    (!configMacd || macdPairOk) &&
    (!configGmaMacd || gmaMacdPairOk);
  const gmaMacdFastScaleVal = gmaMacdFastScale(gmaMacdDraft);
  const gmaMacdSlowScaleVal = gmaMacdSlowScale(gmaMacdDraft);
  const signalConfig = useMemo((): SignalConfig | undefined => {
    if (!configActive) return undefined;
    return {
      useGma: gmaApplied,
      useMacd: macdApplied,
      macdLine:
        macdApplied && macdPairOk
          ? computeMacd(
              bars.map((bar) => bar.close),
              macdDraft.fast,
              macdDraft.slow,
              macdDraft.signal,
            ).macd
          : undefined,
    };
  }, [bars, configActive, gmaApplied, macdApplied, macdPairOk, macdDraft]);
  const labeledBars = useMemo(
    () => (signalConfig ? withActions(bars, signalConfig) : bars),
    [bars, signalConfig],
  );
  const tradeStats = useMemo(
    () => (configActive ? computeTradeStats(labeledBars) : computeTradeStats([])),
    [configActive, labeledBars],
  );

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
        setTimeframe((current) => {
          if (current && cached.includes(current)) return current;
          if (customModeRef.current) return current;
          if (current && isValidTimeframeSpec(current)) return current;
          return cached[0] ?? "";
        });
      return;
    }
    let cancelled = false;
    fetchTimeframes(symbol)
      .then(({ timeframes: frames, custom }) => {
        if (cancelled) return;
        setTimeframesBySymbol((prev) => ({ ...prev, [symbol]: frames }));
        setCustomAvailableBySymbol((prev) => ({ ...prev, [symbol]: custom }));
        if (!frames.length && custom) setCustomMode(true);
        setTimeframe((current) => {
          if (current && frames.includes(current)) return current;
          if (customModeRef.current) return current;
          if (current && isValidTimeframeSpec(current)) return current;
          return frames[0] ?? "";
        });
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
      busyRef.current = true;
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
        setChartPath(data.path);
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
          busyRef.current = false;
          setBusy(false);
          setChartProgress(null);
          setApplyingConfig(false);
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
          payload.fingerprint !== fingerprintRef.current &&
          !busyRef.current
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
            !busyRef.current &&
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

  const cancelGmaOptimize = useCallback(() => {
    const controller = gmaOptAbortRef.current;
    if (!controller) return;
    gmaOptAbortRef.current = null;
    controller.abort();
    setOptimizing(false);
    setOptimizationProgress(null);
  }, []);

  const cancelCrossTfOptimize = useCallback(() => {
    const controller = crossTfAbortRef.current;
    if (!controller) return;
    crossTfAbortRef.current = null;
    controller.abort();
    setCrossTfOptimizing(false);
    setCrossTfProgress(null);
  }, []);

  const cancelInFlightOptimization = useCallback(() => {
    cancelGmaOptimize();
    cancelCrossTfOptimize();
  }, [cancelGmaOptimize, cancelCrossTfOptimize]);

  const resetSeriesControls = () => {
    setDraft(DEFAULT_PARAMS);
    setParams(DEFAULT_PARAMS);
    setGmaApplied(false);
    setMacdDraft(DEFAULT_MACD_PARAMS);
    setMacdApplied(false);
    setGmaMacdDraft(DEFAULT_GMA_MACD_PARAMS);
    setGmaMacdApplied(false);
    setConfigGma(false);
    setConfigMacd(false);
    setConfigGmaMacd(false);
    setOptimizeGma(true);
    setOptimizeMacd(false);
    setOptimizationProgress(null);
    setOptimizationResult(null);
  };

  const applyCustomTimeframe = () => {
    const spec = normalizeTimeframeSpec(customDraft);
    if (!isValidTimeframeSpec(spec)) {
      setError("Custom timeframe must look like 37t, 5m, or 1h");
      return;
    }
    cancelInFlightOptimization();
    resetSeriesControls();
    setCustomDraft(spec);
    setCustomMode(!timeframes.includes(spec));
    setTimeframe(spec);
    setError(null);
  };

  // Drop in-flight GMA / cross-timeframe workers when the series identity
  // changes so a stale result cannot land on the newly selected chart.
  useEffect(() => {
    return () => {
      cancelInFlightOptimization();
    };
  }, [symbol, effectiveTf, cancelInFlightOptimization]);

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

  const applyConfiguration = () => {
    if (locked || !configValid || !symbol || !effectiveTf || busy) return;
    setGmaApplied(configGma);
    setMacdApplied(configMacd);
    setGmaMacdApplied(configGmaMacd);
    setApplyingConfig(true);
    setStatus("loading");
    if (configGma) {
      setParams(draft);
    } else {
      loadChart(true, symbol, effectiveTf, paramsRef.current).catch(() => undefined);
    }
  };

  const optimizeGmas = async () => {
    if (locked || !symbol || !effectiveTf || busy || optimizing) return;
    gmaOptAbortRef.current?.abort();
    const controller = new AbortController();
    gmaOptAbortRef.current = controller;
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
        controller.signal,
        optimizeMacdOn,
      );
      if (gmaOptAbortRef.current !== controller) return;
      setOptimizationResult(result);
    } catch (err) {
      if (isOptimizationAbort(err) || gmaOptAbortRef.current !== controller) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gmaOptAbortRef.current === controller) {
        gmaOptAbortRef.current = null;
        setOptimizing(false);
        setOptimizationProgress(null);
      }
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
    if (optimizeMacd) {
      setMacdDraft(DEFAULT_MACD_PARAMS);
    }
    setDraft(best);
    setParams(best);
    setConfigGma(true);
    setConfigMacd(optimizeMacd);
    setGmaApplied(true);
    setMacdApplied(optimizeMacd);
    setApplyingConfig(true);
    setStatus("loading");
  };

  const optimizeCrossTimeframes = async () => {
    if (locked || !symbol || !timeframes.length || crossTfOptimizing) return;
    crossTfAbortRef.current?.abort();
    const controller = new AbortController();
    crossTfAbortRef.current = controller;
    setCrossTfOptimizing(true);
    setCrossTfProgress(null);
    setCrossTfResult(null);
    setError(null);
    try {
      const series = await Promise.all(
        timeframes.map(async (tf) => {
          const data = await fetchChart(symbol, tf, dataSource, controller.signal);
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
        controller.signal,
        optimizeMacdOn,
      );
      if (crossTfAbortRef.current !== controller) return;
      setCrossTfResult(result);
    } catch (err) {
      if (isOptimizationAbort(err) || crossTfAbortRef.current !== controller) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (crossTfAbortRef.current === controller) {
        crossTfAbortRef.current = null;
        setCrossTfOptimizing(false);
        setCrossTfProgress(null);
      }
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
    if (optimizeMacd) {
      setMacdDraft(DEFAULT_MACD_PARAMS);
    }
    setDraft(best);
    setParams(best);
    setConfigGma(true);
    setConfigMacd(optimizeMacd);
    setGmaApplied(true);
    setMacdApplied(optimizeMacd);
    setApplyingConfig(true);
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
              cancelInFlightOptimization();
              setSymbol(e.target.value);
              setTimeframe("");
              setCustomMode(false);
              setCustomDraft("");
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
            value={
              timeframesLoading
                ? ""
                : customSelectActive
                  ? CUSTOM_TIMEFRAME
                  : timeframe
            }
            onChange={(e) => {
              cancelInFlightOptimization();
              resetSeriesControls();
              const value = e.target.value;
              if (value === CUSTOM_TIMEFRAME) {
                setCustomMode(true);
                setTimeframe("");
                return;
              }
              setCustomMode(false);
              setTimeframe(value);
            }}
            disabled={
              locked ||
              timeframesLoading ||
              (!timeframes.length && !customAvailable)
            }
          >
            {timeframesLoading ? (
              <option value="">Loading timeframes…</option>
            ) : !timeframes.length && !customAvailable ? (
              <option value="">No timeframes</option>
            ) : (
              <>
                <option value="">Select timeframe</option>
                {timeframes.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
                {(customAvailable || customSelectActive) && (
                  <option value={CUSTOM_TIMEFRAME}>
                    {customSelectActive && timeframe
                      ? `Custom (${timeframe})`
                      : "Custom…"}
                  </option>
                )}
              </>
            )}
          </select>
        </label>
        {customSelectActive && (
          <label className="field custom-tf">
            <span>Spec from es.csv</span>
            <span className="custom-tf-row">
              <input
                type="text"
                value={customDraft}
                placeholder="37t, 5m, 1h"
                spellCheck={false}
                disabled={locked || busy}
                onChange={(e) => setCustomDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyCustomTimeframe();
                  }
                }}
              />
              <button
                className="refresh"
                type="button"
                onClick={applyCustomTimeframe}
                disabled={
                  locked ||
                  busy ||
                  !isValidTimeframeSpec(customDraft)
                }
              >
                Load
              </button>
            </span>
          </label>
        )}
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
        <section className="indicators">
          <h2>Indicators</h2>
          <div className={`indicator${gmaApplied ? " active" : ""}`}>
            <label className="indicator-toggle">
              <input
                type="checkbox"
                checked={configGma}
                disabled={locked || busy || optimizing}
                onChange={(event) => setConfigGma(event.target.checked)}
              />
              GMA
            </label>
            <p className="hint">
              Fast EMA 3 · L {draft.fastLength} · σ {draft.fastSigma.toFixed(1)} · L/σ {fastScale.toFixed(2)}
            </p>
            <p className="hint">
              Slow SMA 3 · L {draft.slowLength} · σ {draft.slowSigma.toFixed(1)} · L/σ {slowScale.toFixed(2)}
            </p>
            <p className="indicator-sub">Fast</p>
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
            <p className="indicator-sub">Slow</p>
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
          </div>
          <div className={`indicator${macdApplied ? " active" : ""}`}>
            <label className="indicator-toggle macd">
              <input
                type="checkbox"
                checked={configMacd}
                disabled={locked || busy || optimizing}
                onChange={(event) => setConfigMacd(event.target.checked)}
              />
              MACD (EMA)
            </label>
            <p className="hint">
              EMA {macdDraft.fast} / {macdDraft.slow} · Signal {macdDraft.signal}
            </p>
            <label>
              Fast
              <input
                type="range"
                min={MACD_PERIOD_MIN}
                max={MACD_FAST_MAX}
                value={macdDraft.fast}
                disabled={locked}
                onChange={(e) => setMacdDraft({ ...macdDraft, fast: Number(e.target.value) })}
              />
              <input
                type="number"
                min={MACD_PERIOD_MIN}
                max={MACD_FAST_MAX}
                value={macdDraft.fast}
                disabled={locked}
                onChange={(e) => setMacdDraft({ ...macdDraft, fast: Number(e.target.value) })}
              />
            </label>
            <label>
              Slow
              <input
                type="range"
                min={MACD_PERIOD_MIN}
                max={MACD_SLOW_MAX}
                value={macdDraft.slow}
                disabled={locked}
                onChange={(e) => setMacdDraft({ ...macdDraft, slow: Number(e.target.value) })}
              />
              <input
                type="number"
                min={MACD_PERIOD_MIN}
                max={MACD_SLOW_MAX}
                value={macdDraft.slow}
                disabled={locked}
                onChange={(e) => setMacdDraft({ ...macdDraft, slow: Number(e.target.value) })}
              />
            </label>
            <label>
              Signal
              <input
                type="range"
                min={MACD_PERIOD_MIN}
                max={MACD_SIGNAL_MAX}
                value={macdDraft.signal}
                disabled={locked}
                onChange={(e) => setMacdDraft({ ...macdDraft, signal: Number(e.target.value) })}
              />
              <input
                type="number"
                min={MACD_PERIOD_MIN}
                max={MACD_SIGNAL_MAX}
                value={macdDraft.signal}
                disabled={locked}
                onChange={(e) => setMacdDraft({ ...macdDraft, signal: Number(e.target.value) })}
              />
            </label>
            {!macdPairOk && (
              <p className="hint warn">Invalid pair: fast period must be less than slow</p>
            )}
          </div>
          <div className={`indicator${gmaMacdApplied ? " active" : ""}`}>
            <label className="indicator-toggle gma-macd">
              <input
                type="checkbox"
                checked={configGmaMacd}
                disabled={locked || busy || optimizing}
                onChange={(event) => setConfigGmaMacd(event.target.checked)}
              />
              MACD-GMA
            </label>
            <p className="hint">
              F L {gmaMacdDraft.fastLength} σ {gmaMacdDraft.fastSigma} · S L{" "}
              {gmaMacdDraft.slowLength} σ {gmaMacdDraft.slowSigma} · Sig L{" "}
              {gmaMacdDraft.signalLength} σ {gmaMacdDraft.signalSigma}
            </p>
            <p className="hint">
              Source{" "}
              {gmaMacdDraft.source === "close"
                ? "Close"
                : `EMA(${gmaMacdDraft.emaLength})`}{" "}
              · F L/σ {gmaMacdFastScaleVal.toFixed(2)} · S L/σ {gmaMacdSlowScaleVal.toFixed(2)}
            </p>
            <label className="indicator-sub">Source</label>
            <div className="view-toggle source-toggle">
              <button
                type="button"
                className={gmaMacdDraft.source === "close" ? "active" : ""}
                disabled={locked}
                onClick={() => setGmaMacdDraft({ ...gmaMacdDraft, source: "close" })}
              >
                Close
              </button>
              <button
                type="button"
                className={gmaMacdDraft.source === "ema" ? "active" : ""}
                disabled={locked}
                onClick={() => setGmaMacdDraft({ ...gmaMacdDraft, source: "ema" })}
              >
                EMA(n)
              </button>
            </div>
            {gmaMacdDraft.source === "ema" && (
              <label>
                EMA n
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={gmaMacdDraft.emaLength}
                  disabled={locked}
                  onChange={(e) =>
                    setGmaMacdDraft({
                      ...gmaMacdDraft,
                      emaLength: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                />
              </label>
            )}
            <p className="indicator-sub">Fast GMA</p>
            <label>
              Length
              <input
                type="range"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_LENGTH_MAX}
                value={gmaMacdDraft.fastLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_LENGTH_MAX}
                value={gmaMacdDraft.fastLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastLength: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Sigma
              <input
                type="range"
                min={GMA_MACD_SIGMA_MIN}
                max={GMA_MACD_SIGMA_MAX}
                value={gmaMacdDraft.fastSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastSigma: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_SIGMA_MIN}
                max={GMA_MACD_SIGMA_MAX}
                value={gmaMacdDraft.fastSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastSigma: Number(e.target.value) })
                }
              />
            </label>
            <p className="indicator-sub">Slow GMA</p>
            <label>
              Length
              <input
                type="range"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_LENGTH_MAX}
                value={gmaMacdDraft.slowLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_LENGTH_MAX}
                value={gmaMacdDraft.slowLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowLength: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Sigma
              <input
                type="range"
                min={GMA_MACD_SIGMA_MIN}
                max={GMA_MACD_SIGMA_MAX}
                value={gmaMacdDraft.slowSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowSigma: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_SIGMA_MIN}
                max={GMA_MACD_SIGMA_MAX}
                value={gmaMacdDraft.slowSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowSigma: Number(e.target.value) })
                }
              />
            </label>
            <p className="indicator-sub">Signal GMA</p>
            <label>
              Length
              <input
                type="range"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_LENGTH_MAX}
                value={gmaMacdDraft.signalLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_LENGTH_MAX}
                value={gmaMacdDraft.signalLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalLength: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Sigma
              <input
                type="range"
                min={GMA_MACD_SIGMA_MIN}
                max={GMA_MACD_SIGMA_MAX}
                value={gmaMacdDraft.signalSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalSigma: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_SIGMA_MIN}
                max={GMA_MACD_SIGMA_MAX}
                value={gmaMacdDraft.signalSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalSigma: Number(e.target.value) })
                }
              />
            </label>
            {!gmaMacdPairOk && (
              <p className="hint warn">Invalid pair: fast L/σ must be less than slow L/σ</p>
            )}
          </div>
          {!configGma && !configMacd && !configGmaMacd && (
            <p className="hint warn">Select at least one indicator</p>
          )}
          {configGma && configMacd && macdPairOk && (
            <p className="hint">
              Open long/short: GMA and MACD must agree · Close: GMA crossover only
            </p>
          )}
          {configGma && !configMacd && (
            <p className="hint">Signals from GMA crossovers only</p>
          )}
          {!configGma && configMacd && macdPairOk && (
            <p className="hint">Signals from MACD zero-line crosses only</p>
          )}
          <button
            type="button"
            className="optimize apply-config"
            disabled={
              locked ||
              !configValid ||
              !symbol ||
              !effectiveTf ||
              busy ||
              optimizing ||
              applyingConfig
            }
            onClick={applyConfiguration}
          >
            {applyingConfig
              ? chartProgress?.total
                ? `Applying ${Math.round(chartProgress.pct)}%`
                : "Applying…"
              : "Apply Configuration"}
          </button>
        </section>
        <section className="gma-optimizer">
          <h2>Optimize</h2>
          <div className="optimizer-indicators">
            <label className="indicator-toggle">
              <input
                type="checkbox"
                checked={optimizeGma}
                disabled={locked || busy || optimizing || crossTfOptimizing}
                onChange={(event) => {
                  setOptimizeGma(event.target.checked);
                  setOptimizationResult(null);
                  setCrossTfResult(null);
                }}
              />
              GMA
            </label>
            <label className="indicator-toggle macd">
              <input
                type="checkbox"
                checked={optimizeMacd}
                disabled={locked || busy || optimizing || crossTfOptimizing || !optimizeGma}
                onChange={(event) => {
                  setOptimizeMacd(event.target.checked);
                  setOptimizationResult(null);
                  setCrossTfResult(null);
                }}
              />
              MACD
            </label>
          </div>
          {!optimizeGma && (
            <p className="hint warn">Enable GMA to run optimization</p>
          )}
          {optimizeGma && optimizeMacd && (
            <p className="hint">
              MACD fixed at 12/26/9 · grid-search GMA pairs (L≥2, L/σ≤3, fast L/σ &lt; slow L/σ)
            </p>
          )}
          {optimizeMacdOn && (
            <p className="hint">
              Open long/short: GMA and MACD must agree · Close: GMA crossover only
            </p>
          )}
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
          <div className="optimizer-actions">
            <button
              type="button"
              className="optimize"
              disabled={
                locked ||
                busy ||
                optimizing ||
                !symbol ||
                !effectiveTf ||
                !optimizeGma ||
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
            {optimizing && (
              <button
                type="button"
                className="optimize cancel-optimize"
                onClick={cancelGmaOptimize}
              >
                Cancel
              </button>
            )}
          </div>
          {optimizationFeature === "label_score" && !hasManualLabels && (
            <p className="hint optimizer-status">
              Select entry/exit points in Manual Optimization first — the label
              score needs ground-truth bars to optimize against.
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
                {optimizeMacdOn && (
                  <div><dt>MACD</dt><dd>12 / 26 / 9 (fixed)</dd></div>
                )}
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
                className="optimize apply-config"
                disabled={busy || optimizing}
                onClick={applyOptimizedGmas}
              >
                Apply Best Configuration
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
                  <li key={`${point.index}-${point.time}`} title={`bar ${point.index}`}>
                    <span className="manual-kind entry">E{k + 1}</span>
                    <span className="manual-time">
                      {formatChartTime(point.time, chartZone, true)}
                    </span>
                    <button
                      type="button"
                      className="manual-remove"
                      aria-label={`Remove entry ${k + 1}`}
                      disabled={busy}
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
                  <li key={`${point.index}-${point.time}`} title={`bar ${point.index}`}>
                    <span className="manual-kind exit">X{k + 1}</span>
                    <span className="manual-time">
                      {formatChartTime(point.time, chartZone, true)}
                    </span>
                    <button
                      type="button"
                      className="manual-remove"
                      aria-label={`Remove exit ${k + 1}`}
                      disabled={busy}
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
          <label className="optimizer-toggle compact">
            <input
              type="checkbox"
              checked={optimizeGma}
              disabled={locked || crossTfOptimizing || optimizing}
              onChange={(event) => {
                setOptimizeGma(event.target.checked);
                setCrossTfResult(null);
              }}
            />
            GMA
          </label>
          <label className="optimizer-toggle compact macd">
            <input
              type="checkbox"
              checked={optimizeMacd}
              disabled={locked || crossTfOptimizing || optimizing || !optimizeGma}
              onChange={(event) => {
                setOptimizeMacd(event.target.checked);
                setCrossTfResult(null);
              }}
            />
            MACD
          </label>
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
            disabled={
              locked ||
              !symbol ||
              !timeframes.length ||
              crossTfOptimizing ||
              busy ||
              !optimizeGma ||
              (optimizationFeature === "label_score" && !hasManualLabels)
            }
            onClick={optimizeCrossTimeframes}
          >
            {crossTfOptimizing
              ? crossTfProgress
                ? `Optimizing ${Math.round(crossTfProgress.pct)}%`
                : "Loading timeframes…"
              : "Optimize All Timeframes"}
          </button>
          {crossTfOptimizing && (
            <button
              type="button"
              className="optimize cancel-optimize"
              onClick={cancelCrossTfOptimize}
            >
              Cancel
            </button>
          )}
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
            showMacd={macdApplied}
            showGmaMacd={gmaMacdApplied}
            showSignals={configActive}
            macdParams={macdDraft}
            gmaMacdParams={gmaMacdDraft}
            selectionMode={manualMode}
            entryPoints={entryPoints}
            exitPoints={exitPoints}
            onSelectPoint={toggleManualPoint}
          />
        </div>
        <section className="legend">
          <h2>Legend</h2>
          {configActive && (
            <>
              <div><i className="arrow buy" /> Long Open / Put Close</div>
              <div><i className="arrow sell" /> Long Close / Put Open</div>
              <div className="hint">Markers are labeled on chart (e.g. Long Close, Put Open)</div>
            </>
          )}
          {gmaApplied && (
            <>
              <div><i className="swatch fast" /> Fast GMA (EMA 3)</div>
              <div><i className="swatch slow" /> Slow GMA (SMA 3)</div>
            </>
          )}
          {macdApplied && (
            <>
              <div><i className="swatch macd" /> MACD line (EMA)</div>
              <div><i className="swatch macd-signal" /> Signal (EMA)</div>
              <div><i className="swatch macd-hist" /> Histogram</div>
            </>
          )}
          {gmaMacdApplied && (
            <>
              <div><i className="swatch gma-macd" /> MACD line (GMA)</div>
              <div><i className="swatch gma-macd-signal" /> Signal (GMA)</div>
              <div><i className="swatch gma-macd-hist" /> Histogram</div>
            </>
          )}
        </section>
      </main>

      <footer className="status">
        <span>
          {source === "continuous"
            ? chartPath.includes("→")
              ? `Aggregated ${effectiveTf} from es.csv`
              : "Continuous timeframe CSV"
            : ""}
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
