import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartHandle, type ChartZone } from "./Chart";
import { fetchCatalog, fetchChart, fetchMeta, fetchTimeframes, streamChart, watchUrl } from "./api";
import { isGmaMacdOptimizationAbort, runGmaMacdOptimization } from "./gmaMacdOptimizer";
import { computeDualEma } from "./ema";
import { computeGmaMacd } from "./gmaMacd";
import { isOptimizationAbort, runFrontendOptimization, runMultiTimeframeOptimization, type CrossTfProgress, type CrossTfResult, type LabelScoringOptions } from "./gmaOptimizer";
import SessionStats, { emaWarmupBars, gmaWarmupBars } from "./SessionStats";
import { CROSS_TF_OPTIMIZE_OPTIONS, CUSTOM_TIMEFRAME, DEFAULT_EMA_PARAMS, DEFAULT_GMA_MACD_PARAMS, DEFAULT_MANUAL_WINDOW, DEFAULT_PARAMS, EMA_LENGTH_MAX, EMA_LENGTH_MIN, GMA_LENGTH_MAX, GMA_LENGTH_MIN, GMA_MACD_LENGTH_MAX, GMA_MACD_LENGTH_MIN, GMA_MACD_OPTIMIZE_OPTIONS, GMA_MACD_SIGMA_MAX, GMA_MACD_SIGMA_MIN, GMA_MACD_SIGNAL_LENGTH_MAX, GMA_SIGMA_MAX, GMA_SIGMA_MIN, clampEmaParams, clampGmaMacdParams, clampGmaParams, gmaMacdFastScale, gmaMacdSlowScale, gmaScale, isValidEmaPair, isValidGmaMacdConfig, isValidGmaPair, isValidTimeframeSpec, normalizeTimeframeSpec, OPTIMIZE_OPTIONS, type Bar, type EmaParams, type GmaMacdOptimizeMetric, type GmaMacdOptimizeResult, type GmaMacdParams, type GmaParams, type LoadProgress, type ManualEntryWindow, type ManualPoint, type ManualSelectionMode, type OptimizeMetric, type OptimizeProgress, type OptimizeResult } from "./types";

import { computeTradeStats, withActions, type SignalConfig } from "./tradeStats";

type SidebarTab = "gma" | "ema" | "gmaMacd";

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

function gmaMacdOptimizationScore(result: GmaMacdOptimizeResult, metric: GmaMacdOptimizeMetric): string {
  const value = {
    total_win_rate: result.win_rate,
    total_profit_pct: result.profit_pct,
    max_runup_pct: result.max_runup_pct,
    avg_max_runup_pct: result.avg_max_runup_pct,
    average_profit_pct: result.average_profit_pct,
  }[metric];
  return value == null ? "—" : `${value.toFixed(metric === "total_win_rate" ? 1 : 2)}%`;
}

function gmaMacdOptimizationLabel(metric: GmaMacdOptimizeMetric): string {
  return GMA_MACD_OPTIMIZE_OPTIONS.find((option) => option.id === metric)?.label.replace("Maximize ", "") ?? metric;
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
  const [emaDraft, setEmaDraft] = useState<EmaParams>(DEFAULT_EMA_PARAMS);
  const [emaApplied, setEmaApplied] = useState(false);
  const [gmaMacdDraft, setGmaMacdDraft] = useState<GmaMacdParams>(DEFAULT_GMA_MACD_PARAMS);
  const [gmaMacdApplied, setGmaMacdApplied] = useState(false);
  const [gmaMacdOptimizationFeature, setGmaMacdOptimizationFeature] = useState<GmaMacdOptimizeMetric>("total_profit_pct");
  const [gmaMacdOptimizationProgress, setGmaMacdOptimizationProgress] = useState<OptimizeProgress | null>(null);
  const [gmaMacdOptimizationResult, setGmaMacdOptimizationResult] = useState<GmaMacdOptimizeResult | null>(null);
  const [gmaMacdOptimizing, setGmaMacdOptimizing] = useState(false);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>("gma");
  const [configGma, setConfigGma] = useState(true);
  const [optimizeGma, setOptimizeGma] = useState(true);
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
  const gmaMacdOptAbortRef = useRef<AbortController | null>(null);
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
  const emaPairOk = isValidEmaPair(emaDraft);
  const gmaMacdConfigOk = isValidGmaMacdConfig(gmaMacdDraft);
  const gmaMacdFastScaleVal = gmaMacdFastScale(gmaMacdDraft);
  const gmaMacdSlowScaleVal = gmaMacdSlowScale(gmaMacdDraft);
  const gmaTabActive = gmaApplied;
  const configActive = gmaTabActive || emaApplied || gmaMacdApplied;
  const configValid = configGma && gmaPairOk;
  const signalConfig = useMemo((): SignalConfig | undefined => {
    if (!configActive) return undefined;
    if (gmaMacdApplied && gmaMacdConfigOk) {
      return {
        useGma: false,
        useMacd: false,
        useGmaMacd: true,
        gmaMacdHist: computeGmaMacd(
          bars.map((bar) => bar.close),
          gmaMacdDraft,
        ).hist,
      };
    }
    if (emaApplied && emaPairOk) {
      const series = computeDualEma(
        bars.map((bar) => bar.close),
        emaDraft.fast,
        emaDraft.slow,
      );
      return {
        useGma: false,
        useMacd: false,
        useEma: true,
        emaFast: series.fast,
        emaSlow: series.slow,
      };
    }
    if (!gmaTabActive) return undefined;
    return {
      useGma: gmaApplied,
      useMacd: false,
    };
  }, [bars, configActive, gmaMacdApplied, gmaMacdConfigOk, gmaMacdDraft, emaApplied, emaPairOk, emaDraft, gmaTabActive, gmaApplied]);
  const labeledBars = useMemo(
    () => (signalConfig ? withActions(bars, signalConfig) : bars),
    [bars, signalConfig],
  );
  const gmaTradeStats = useMemo(() => {
    if (!gmaTabActive) return computeTradeStats([]);
    const gmaSignal: SignalConfig = {
      useGma: gmaApplied,
      useMacd: false,
    };
    return computeTradeStats(withActions(bars, gmaSignal));
  }, [bars, gmaTabActive, gmaApplied]);
  const emaTradeStats = useMemo(() => {
    if (!emaApplied || !emaPairOk) return computeTradeStats([]);
    const series = computeDualEma(
      bars.map((bar) => bar.close),
      emaDraft.fast,
      emaDraft.slow,
    );
    return computeTradeStats(
      withActions(bars, {
        useGma: false,
        useMacd: false,
        useEma: true,
        emaFast: series.fast,
        emaSlow: series.slow,
      }),
    );
  }, [bars, emaApplied, emaPairOk, emaDraft]);
  const gmaMacdTradeStats = useMemo(() => {
    if (!gmaMacdApplied || !gmaMacdConfigOk) return computeTradeStats([]);
    return computeTradeStats(
      withActions(bars, {
        useGma: false,
        useMacd: false,
        useGmaMacd: true,
        gmaMacdHist: computeGmaMacd(
          bars.map((bar) => bar.close),
          gmaMacdDraft,
        ).hist,
      }),
    );
  }, [bars, gmaMacdApplied, gmaMacdConfigOk, gmaMacdDraft]);

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

  const cancelGmaMacdOptimize = useCallback(() => {
    const controller = gmaMacdOptAbortRef.current;
    if (!controller) return;
    gmaMacdOptAbortRef.current = null;
    controller.abort();
    setGmaMacdOptimizing(false);
    setGmaMacdOptimizationProgress(null);
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
    cancelGmaMacdOptimize();
    cancelCrossTfOptimize();
  }, [cancelGmaOptimize, cancelGmaMacdOptimize, cancelCrossTfOptimize]);

  const resetSeriesControls = () => {
    setDraft(DEFAULT_PARAMS);
    setParams(DEFAULT_PARAMS);
    setGmaApplied(false);
    setEmaDraft(DEFAULT_EMA_PARAMS);
    setEmaApplied(false);
    setGmaMacdDraft(DEFAULT_GMA_MACD_PARAMS);
    setGmaMacdApplied(false);
    setConfigGma(true);
    setOptimizeGma(true);
    setOptimizationProgress(null);
    setOptimizationResult(null);
    setGmaMacdOptimizationProgress(null);
    setGmaMacdOptimizationResult(null);
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
    setApplyingConfig(true);
    setStatus("loading");
    if (configGma) {
      setParams(draft);
    } else {
      loadChart(true, symbol, effectiveTf, paramsRef.current).catch(() => undefined);
    }
  };

  const applyEmaConfiguration = () => {
    if (locked || !emaPairOk || !symbol || !effectiveTf || busy) return;
    setEmaDraft(clampEmaParams(emaDraft));
    setEmaApplied(true);
  };

  const applyGmaMacdConfiguration = () => {
    if (locked || !gmaMacdConfigOk || !symbol || !effectiveTf || busy) return;
    setGmaMacdApplied(true);
  };

  const optimizeGmaMacds = async () => {
    if (locked || !symbol || !effectiveTf || busy || gmaMacdOptimizing) return;
    gmaMacdOptAbortRef.current?.abort();
    const controller = new AbortController();
    gmaMacdOptAbortRef.current = controller;
    setGmaMacdOptimizing(true);
    setGmaMacdOptimizationProgress(null);
    setGmaMacdOptimizationResult(null);
    setError(null);
    try {
      const result = await runGmaMacdOptimization(
        bars,
        symbol,
        effectiveTf,
        gmaMacdOptimizationFeature,
        minTrades,
        maxTrades,
        (progress) => setGmaMacdOptimizationProgress(progress),
        controller.signal,
      );
      if (gmaMacdOptAbortRef.current !== controller) return;
      setGmaMacdOptimizationResult(result);
    } catch (err) {
      if (isGmaMacdOptimizationAbort(err) || gmaMacdOptAbortRef.current !== controller) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gmaMacdOptAbortRef.current === controller) {
        gmaMacdOptAbortRef.current = null;
        setGmaMacdOptimizing(false);
        setGmaMacdOptimizationProgress(null);
      }
    }
  };

  const applyOptimizedGmaMacds = () => {
    if (!gmaMacdOptimizationResult) return;
    const best = clampGmaMacdParams({
      fastLength: gmaMacdOptimizationResult.params.fast_length,
      fastSigma: gmaMacdOptimizationResult.params.fast_sigma,
      slowLength: gmaMacdOptimizationResult.params.slow_length,
      slowSigma: gmaMacdOptimizationResult.params.slow_sigma,
      signalLength: gmaMacdOptimizationResult.params.signal_length,
      signalSigma: gmaMacdOptimizationResult.params.signal_sigma,
    });
    setGmaMacdDraft(best);
    setGmaMacdApplied(true);
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
    setDraft(best);
    setParams(best);
    setConfigGma(true);
    setGmaApplied(true);
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
    setDraft(best);
    setParams(best);
    setConfigGma(true);
    setGmaApplied(true);
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
        <nav className="sidebar-tabs" aria-label="Sidebar sections">
          <button
            type="button"
            className={`sidebar-tab${activeSidebarTab === "gma" ? " active" : ""}`}
            onClick={() => setActiveSidebarTab("gma")}
          >
            GMA
          </button>
          <button
            type="button"
            className={`sidebar-tab${activeSidebarTab === "ema" ? " active" : ""}`}
            onClick={() => setActiveSidebarTab("ema")}
          >
            EMA
          </button>
          <button
            type="button"
            className={`sidebar-tab${activeSidebarTab === "gmaMacd" ? " active" : ""}`}
            onClick={() => setActiveSidebarTab("gmaMacd")}
          >
            GMA MACD
          </button>
        </nav>
        {activeSidebarTab === "gma" && (
        <>
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
          {!configGma && (
            <p className="hint warn">Enable GMA to apply</p>
          )}
          {configGma && (
            <p className="hint">
              Long: close 1.5+ above slow, or 3+ above slow · Short: close 1.5+ below fast, or 3+ below slow
            </p>
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
          </div>
          {!optimizeGma && (
            <p className="hint warn">Enable GMA to run optimization</p>
          )}
          {optimizeGma && (
            <p className="hint">
              Grid-search GMA pairs (L≥2, L/σ≤3, fast L/σ &lt; slow L/σ)
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
        <SessionStats
          stats={gmaTradeStats}
          last={last}
          bars={bars}
          warmupBars={gmaWarmupBars(params)}
        />
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
        </>
        )}
        {activeSidebarTab === "ema" && (
        <>
        <section className="indicators">
          <h2>EMA</h2>
          <div className={`indicator${emaApplied ? " active" : ""}`}>
            <p className="hint">Fast EMA {emaDraft.fast} · Slow EMA {emaDraft.slow}</p>
            <p className="hint">
              Long: close 1.5+ above slow, or 3+ above slow · Short: close 1.5+ below fast, or 3+ below slow
            </p>
            <p className="indicator-sub">Fast</p>
            <label>
              Length
              <input
                type="range"
                min={EMA_LENGTH_MIN}
                max={EMA_LENGTH_MAX}
                value={emaDraft.fast}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, fast: Number(e.target.value) })}
              />
              <input
                type="number"
                min={EMA_LENGTH_MIN}
                max={EMA_LENGTH_MAX}
                value={emaDraft.fast}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, fast: Number(e.target.value) })}
              />
            </label>
            <p className="indicator-sub">Slow</p>
            <label>
              Length
              <input
                type="range"
                min={EMA_LENGTH_MIN}
                max={EMA_LENGTH_MAX}
                value={emaDraft.slow}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, slow: Number(e.target.value) })}
              />
              <input
                type="number"
                min={EMA_LENGTH_MIN}
                max={EMA_LENGTH_MAX}
                value={emaDraft.slow}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, slow: Number(e.target.value) })}
              />
            </label>
            {!emaPairOk && (
              <p className="hint warn">Invalid pair: both lengths ≤ 100 and fast must be less than slow</p>
            )}
          </div>
          <button
            type="button"
            className="optimize apply-config"
            disabled={locked || !emaPairOk || !symbol || !effectiveTf || busy}
            onClick={applyEmaConfiguration}
          >
            Apply to Chart
          </button>
        </section>
        <SessionStats
          stats={emaTradeStats}
          last={last}
          bars={bars}
          warmupBars={emaWarmupBars(emaDraft.fast, emaDraft.slow)}
        />
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
        </>
        )}
        {activeSidebarTab === "gmaMacd" && (
        <>
        <section className="gma-macd-config indicators">
          <h2>GMA MACD</h2>
          <div className={`indicator${gmaMacdApplied ? " active" : ""}`}>
            <p className="hint">
              MACD line: {gmaMacdDraft.fastLength}-period GMA − {gmaMacdDraft.slowLength}-period GMA (on close)
            </p>
            <p className="hint">
              Signal: {gmaMacdDraft.signalLength}-period GMA of MACD line · Histogram: MACD − Signal
            </p>
            <p className="hint">
              F L/σ {gmaMacdFastScaleVal.toFixed(2)} · S L/σ {gmaMacdSlowScaleVal.toFixed(2)}
            </p>
            <p className="hint">Long: histogram &gt; 0 · Short: histogram &lt; 0</p>
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
                max={GMA_MACD_SIGNAL_LENGTH_MAX}
                value={gmaMacdDraft.signalLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={GMA_MACD_LENGTH_MIN}
                max={GMA_MACD_SIGNAL_LENGTH_MAX}
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
            {!gmaMacdConfigOk && (
              <p className="hint warn">
                Invalid config: fast L/σ &lt; slow L/σ, lengths ≤ 100, signal ≤ 15, all L/σ ≤ 3
              </p>
            )}
          </div>
          <button
            type="button"
            className="optimize apply-config"
            disabled={locked || !gmaMacdConfigOk || !symbol || !effectiveTf || busy || gmaMacdOptimizing}
            onClick={applyGmaMacdConfiguration}
          >
            Apply to Chart
          </button>
        </section>
        <section className="gma-macd-optimizer gma-optimizer">
          <h2>Optimize</h2>
          <p className="hint">
            Grid-search fast, slow, and signal GMA pairs (L/σ ≤ 3, fast L/σ &lt; slow L/σ)
          </p>
          <label className="optimizer-feature">
            Feature
            <select
              value={gmaMacdOptimizationFeature}
              disabled={locked || busy || gmaMacdOptimizing || !symbol || !effectiveTf}
              onChange={(event) => {
                setGmaMacdOptimizationFeature(event.target.value as GmaMacdOptimizeMetric);
                setGmaMacdOptimizationResult(null);
              }}
            >
              {GMA_MACD_OPTIMIZE_OPTIONS.map((option) => (
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
                disabled={locked || busy || gmaMacdOptimizing || !symbol || !effectiveTf}
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
                disabled={locked || busy || gmaMacdOptimizing || !symbol || !effectiveTf}
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
              disabled={locked || busy || gmaMacdOptimizing || !symbol || !effectiveTf}
              onClick={optimizeGmaMacds}
            >
              {gmaMacdOptimizing
                ? gmaMacdOptimizationProgress
                  ? `Optimizing ${Math.round(gmaMacdOptimizationProgress.pct)}%`
                  : "Starting optimization…"
                : "Optimize GMA MACD"}
            </button>
            {gmaMacdOptimizing && (
              <button
                type="button"
                className="optimize cancel-optimize"
                onClick={cancelGmaMacdOptimize}
              >
                Cancel
              </button>
            )}
          </div>
          {gmaMacdOptimizationResult && (
            <div className="optimizer-result">
              <div className="optimizer-score">
                <span>Best {gmaMacdOptimizationLabel(gmaMacdOptimizationFeature)}</span>
                <strong>
                  {gmaMacdOptimizationScore(gmaMacdOptimizationResult, gmaMacdOptimizationFeature)}
                </strong>
              </div>
              <dl className="optimizer-params">
                <div>
                  <dt>Fast GMA</dt>
                  <dd>
                    L {gmaMacdOptimizationResult.params.fast_length} · σ{" "}
                    {gmaMacdOptimizationResult.params.fast_sigma}
                  </dd>
                </div>
                <div>
                  <dt>Slow GMA</dt>
                  <dd>
                    L {gmaMacdOptimizationResult.params.slow_length} · σ{" "}
                    {gmaMacdOptimizationResult.params.slow_sigma}
                  </dd>
                </div>
                <div>
                  <dt>Signal GMA</dt>
                  <dd>
                    L {gmaMacdOptimizationResult.params.signal_length} · σ{" "}
                    {gmaMacdOptimizationResult.params.signal_sigma}
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                className="optimize apply-config"
                disabled={busy || gmaMacdOptimizing}
                onClick={applyOptimizedGmaMacds}
              >
                Apply Best Configuration
              </button>
            </div>
          )}
        </section>
        <SessionStats
          stats={gmaMacdTradeStats}
          last={last}
          bars={bars}
          warmupBars={Math.max(
            gmaMacdDraft.fastLength,
            gmaMacdDraft.slowLength,
            gmaMacdDraft.signalLength,
          )}
        />
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
        </>
        )}
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
            showEma={emaApplied}
            showGmaMacd={gmaMacdApplied}
            showSignals={configActive}
            emaParams={emaDraft}
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
          {emaApplied && (
            <>
              <div><i className="swatch ema-fast" /> Fast EMA</div>
              <div><i className="swatch ema-slow" /> Slow EMA</div>
            </>
          )}
          {gmaMacdApplied && (
            <>
              <div><i className="swatch gma-macd" /> MACD line (GMA fast − GMA slow)</div>
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
