import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartHandle, type ChartZone } from "./Chart";
import { fetchCatalog, fetchChart, fetchMeta, fetchTimeframes, streamChart, watchUrl } from "./api";
import { isEmaOptimizationAbort, runEmaOptimization } from "./emaOptimizer";
import { isGmaMacdOptimizationAbort, runGmaMacdOptimization } from "./gmaMacdOptimizer";
import { computeDualEma } from "./ema";
import { computeDualGma } from "./gma";
import { computeGmaMacd } from "./gmaMacd";
import { isOptimizationAbort, runFrontendOptimization, runMultiTimeframeOptimization, type CrossTfProgress, type CrossTfResult, type LabelScoringOptions } from "./gmaOptimizer";
import SessionStats, { emaWarmupBars, gmaWarmupBars } from "./SessionStats";
import { CROSS_TF_OPTIMIZE_OPTIONS, CUSTOM_TIMEFRAME, DEFAULT_DUAL_MA_THRESHOLDS, DEFAULT_EMA_PARAMS, DEFAULT_GMA_MACD_PARAMS, DEFAULT_MANUAL_WINDOW, DEFAULT_PARAMS, EMA_LENGTH_MAX, EMA_LENGTH_MIN, EMA_OPTIMIZE_OPTIONS, GMA_LENGTH_MAX, GMA_LENGTH_MIN, GMA_MACD_LENGTH_MAX, GMA_MACD_LENGTH_MIN, GMA_MACD_OPTIMIZE_OPTIONS, GMA_MACD_SIGMA_MAX, GMA_MACD_SIGMA_MIN, GMA_MACD_SIGNAL_LENGTH_MAX, GMA_SIGMA_MAX, GMA_SIGMA_MIN, MA_THRESHOLD_MAX, MA_THRESHOLD_MIN, MA_THRESHOLD_STEP, clampEmaParams, clampGmaMacdParams, clampGmaParams, gmaScale, isUsableEmaParams, isUsableGmaMacdParams, isUsableGmaParams, isValidTimeframeSpec, normalizeDualMaThresholds, normalizeTimeframeSpec, OPTIMIZE_OPTIONS, type Bar, type DualMaThresholds, type EmaOptimizeMetric, type EmaOptimizeResult, type EmaParams, type GmaMacdOptimizeMetric, type GmaMacdOptimizeResult, type GmaMacdParams, type GmaParams, type LoadProgress, type ManualEntryWindow, type ManualPoint, type ManualSelectionMode, type OptimizeMetric, type OptimizeProgress, type OptimizeResult } from "./types";

import { computeTradeStats, withActions, type SignalConfig } from "./tradeStats";

type SidebarTab = "gma" | "ema" | "gmaMacd";

/** Range thumbs stay at the optimization bound unless a custom value is outside it. */
function sliderMin(optMin: number, value: number): number {
  return Math.min(optMin, Number.isFinite(value) ? value : optMin);
}

function sliderMax(optMax: number, value: number): number {
  return Math.max(optMax, Number.isFinite(value) ? value : optMax);
}

function formatScale(length: number, sigma: number): string {
  const ratio = gmaScale(length, sigma);
  return Number.isFinite(ratio) ? ratio.toFixed(2) : "—";
}

function DualMaSignalRules({
  thresholds,
  useThresholds,
}: {
  thresholds: DualMaThresholds;
  useThresholds: boolean;
}) {
  if (!useThresholds) {
    return (
      <dl className="config-rules">
        <div>
          <dt className="long">Long</dt>
          <dd>Fast crosses above slow</dd>
        </div>
        <div>
          <dt className="short">Short</dt>
          <dd>Fast crosses below slow</dd>
        </div>
        <div>
          <dt>Exit</dt>
          <dd>Opposite crossover</dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="config-rules">
      <div>
        <dt className="long">Long</dt>
        <dd>
          Fast is {thresholds.maSpread}+ above slow, or close is {thresholds.closeMin}+ above slow
        </dd>
      </div>
      <div>
        <dt className="short">Short</dt>
        <dd>
          Fast is {thresholds.maSpread}+ below slow, or close is {thresholds.closeMin}+ below fast or slow
        </dd>
      </div>
      <div>
        <dt>Exit</dt>
        <dd>When every reason that opened the trade reverses</dd>
      </div>
    </dl>
  );
}

function GmaOptimizeBounds() {
  return (
    <>
      <p className="config-lede">
        Tries every valid GMA pair on this chart and keeps the highest score.
      </p>
      <dl className="config-rules">
        <div>
          <dt>Length</dt>
          <dd>At least 2 bars</dd>
        </div>
        <div>
          <dt>Pair</dt>
          <dd>Fast shorter than slow</dd>
        </div>
        <div>
          <dt>Ratio</dt>
          <dd>Length ÷ sigma at most 3, and fast below slow</dd>
        </div>
      </dl>
    </>
  );
}

function EmaOptimizeBounds() {
  return (
    <>
      <p className="config-lede">
        Tries every valid fast/slow EMA pair on this chart and keeps the highest score.
      </p>
      <dl className="config-rules">
        <div>
          <dt>Length</dt>
          <dd>1 to 100 bars</dd>
        </div>
        <div>
          <dt>Pair</dt>
          <dd>Fast shorter than slow</dd>
        </div>
      </dl>
    </>
  );
}

function GmaMacdOptimizeBounds() {
  return (
    <>
      <p className="config-lede">
        Tries valid fast, slow, and signal GMA triples and keeps the highest score.
      </p>
      <dl className="config-rules">
        <div>
          <dt>Pair</dt>
          <dd>Fast shorter than slow</dd>
        </div>
        <div>
          <dt>Ratio</dt>
          <dd>Length ÷ sigma at most 3, and fast below slow</dd>
        </div>
        <div>
          <dt>Signal</dt>
          <dd>Length 1 to 15 bars</dd>
        </div>
      </dl>
    </>
  );
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

function emaOptimizationScore(result: EmaOptimizeResult, metric: EmaOptimizeMetric): string {
  const value = {
    total_win_rate: result.win_rate,
    total_profit_pct: result.profit_pct,
    max_runup_pct: result.max_runup_pct,
    avg_max_runup_pct: result.avg_max_runup_pct,
    average_profit_pct: result.average_profit_pct,
  }[metric];
  return value == null ? "—" : `${value.toFixed(metric === "total_win_rate" ? 1 : 2)}%`;
}

function emaOptimizationLabel(metric: EmaOptimizeMetric): string {
  return EMA_OPTIMIZE_OPTIONS.find((option) => option.id === metric)?.label.replace("Maximize ", "") ?? metric;
}

function formatThreshold(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value * 100) / 100);
}

function resultThresholds(
  result: { params: { ma_spread?: number; close_min?: number } },
  fallback: DualMaThresholds,
): DualMaThresholds {
  return normalizeDualMaThresholds({
    maSpread: result.params.ma_spread ?? fallback.maSpread,
    closeMin: result.params.close_min ?? fallback.closeMin,
  });
}

function DualMaThresholdInputs({
  value,
  disabled,
  onChange,
}: {
  value: DualMaThresholds;
  disabled: boolean;
  onChange: (next: DualMaThresholds) => void;
}) {
  return (
    <>
      <p className="indicator-sub">Entry thresholds</p>
      <label className="threshold-field">
        From MA
        <input
          type="range"
          min={sliderMin(MA_THRESHOLD_MIN, value.maSpread)}
          max={sliderMax(MA_THRESHOLD_MAX, value.maSpread)}
          step={MA_THRESHOLD_STEP}
          value={value.maSpread}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, maSpread: Number(e.target.value) })}
        />
        <input
          type="number"
          min={0}
          step={MA_THRESHOLD_STEP}
          value={value.maSpread}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, maSpread: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label className="threshold-field">
        From close
        <input
          type="range"
          min={sliderMin(MA_THRESHOLD_MIN, value.closeMin)}
          max={sliderMax(MA_THRESHOLD_MAX, value.closeMin)}
          step={MA_THRESHOLD_STEP}
          value={value.closeMin}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, closeMin: Number(e.target.value) })}
        />
        <input
          type="number"
          min={0}
          step={MA_THRESHOLD_STEP}
          value={value.closeMin}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, closeMin: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
    </>
  );
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
  const [chartZone, setChartZone] = useState<ChartZone>("et");
  const [params, setParams] = useState<GmaParams>(DEFAULT_PARAMS);
  const [draft, setDraft] = useState<GmaParams>(DEFAULT_PARAMS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [chartPath, setChartPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "stale">("idle");
  const [busy, setBusy] = useState(false);
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
  const [emaParams, setEmaParams] = useState<EmaParams>(DEFAULT_EMA_PARAMS);
  const [emaApplied, setEmaApplied] = useState(false);
  const [gmaMacdDraft, setGmaMacdDraft] = useState<GmaMacdParams>(DEFAULT_GMA_MACD_PARAMS);
  const [gmaMacdParams, setGmaMacdParams] = useState<GmaMacdParams>(DEFAULT_GMA_MACD_PARAMS);
  const [gmaMacdApplied, setGmaMacdApplied] = useState(false);
  const [gmaMacdOptimizationFeature, setGmaMacdOptimizationFeature] = useState<GmaMacdOptimizeMetric>("total_profit_pct");
  const [gmaMacdOptimizationProgress, setGmaMacdOptimizationProgress] = useState<OptimizeProgress | null>(null);
  const [gmaMacdOptimizationResult, setGmaMacdOptimizationResult] = useState<GmaMacdOptimizeResult | null>(null);
  const [gmaMacdOptimizing, setGmaMacdOptimizing] = useState(false);
  const [emaOptimizationFeature, setEmaOptimizationFeature] = useState<EmaOptimizeMetric>("total_profit_pct");
  const [emaOptimizationProgress, setEmaOptimizationProgress] = useState<OptimizeProgress | null>(null);
  const [emaOptimizationResult, setEmaOptimizationResult] = useState<EmaOptimizeResult | null>(null);
  const [emaOptimizing, setEmaOptimizing] = useState(false);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab>("gma");
  const [configGma, setConfigGma] = useState(true);
  const [optimizeGma, setOptimizeGma] = useState(true);
  const [gmaThresholds, setGmaThresholds] = useState<DualMaThresholds>(DEFAULT_DUAL_MA_THRESHOLDS);
  const [appliedGmaThresholds, setAppliedGmaThresholds] = useState<DualMaThresholds>(DEFAULT_DUAL_MA_THRESHOLDS);
  const [appliedGmaUseThresholds, setAppliedGmaUseThresholds] = useState(false);
  const [emaThresholds, setEmaThresholds] = useState<DualMaThresholds>(DEFAULT_DUAL_MA_THRESHOLDS);
  const [appliedEmaThresholds, setAppliedEmaThresholds] = useState<DualMaThresholds>(DEFAULT_DUAL_MA_THRESHOLDS);
  const [appliedEmaUseThresholds, setAppliedEmaUseThresholds] = useState(false);
  const [optimizeGmaThresholds, setOptimizeGmaThresholds] = useState(false);
  const [optimizeEmaThresholds, setOptimizeEmaThresholds] = useState(false);
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
  const sidebarRef = useRef<HTMLElement | null>(null);
  const gmaOptAbortRef = useRef<AbortController | null>(null);
  const gmaMacdOptAbortRef = useRef<AbortController | null>(null);
  const emaOptAbortRef = useRef<AbortController | null>(null);
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
  const gmaUsable = isUsableGmaParams(draft);
  const emaUsable = isUsableEmaParams(emaDraft);
  const gmaMacdUsable = isUsableGmaMacdParams(gmaMacdDraft);
  const gmaTabActive = gmaApplied;
  const configActive = gmaTabActive || emaApplied || gmaMacdApplied;
  const configValid = (configGma && gmaUsable) || (gmaApplied && !configGma);
  const gmaBars = useMemo(() => {
    if (!gmaApplied || !isUsableGmaParams(params)) return bars;
    const series = computeDualGma(
      bars.map((bar) => bar.close),
      params,
    );
    return bars.map((bar, i) => ({
      ...bar,
      gma_fast: series.fast[i],
      gma_slow: series.slow[i],
      signal: null,
    }));
  }, [bars, gmaApplied, params]);
  const signalConfig = useMemo((): SignalConfig | undefined => {
    if (!configActive) return undefined;
    if (gmaMacdApplied && isUsableGmaMacdParams(gmaMacdParams)) {
      return {
        useGma: false,
        useMacd: false,
        useGmaMacd: true,
        gmaMacdHist: computeGmaMacd(
          gmaBars.map((bar) => bar.close),
          gmaMacdParams,
        ).hist,
      };
    }
    if (emaApplied && isUsableEmaParams(emaParams)) {
      const series = computeDualEma(
        gmaBars.map((bar) => bar.close),
        emaParams.fast,
        emaParams.slow,
      );
      return {
        useGma: false,
        useMacd: false,
        useEma: true,
        emaFast: series.fast,
        emaSlow: series.slow,
        maSpreadMin: appliedEmaThresholds.maSpread,
        maCloseMin: appliedEmaThresholds.closeMin,
        useMaThresholds: appliedEmaUseThresholds,
      };
    }
    if (!gmaTabActive) return undefined;
    return {
      useGma: gmaApplied,
      useMacd: false,
      maSpreadMin: appliedGmaThresholds.maSpread,
      maCloseMin: appliedGmaThresholds.closeMin,
      useMaThresholds: appliedGmaUseThresholds,
    };
  }, [gmaBars, configActive, gmaMacdApplied, gmaMacdParams, emaApplied, emaParams, appliedEmaThresholds, appliedEmaUseThresholds, gmaTabActive, gmaApplied, appliedGmaThresholds, appliedGmaUseThresholds]);
  const labeledBars = useMemo(
    () => (signalConfig ? withActions(gmaBars, signalConfig) : gmaBars),
    [gmaBars, signalConfig],
  );
  const gmaTradeStats = useMemo(() => {
    if (!gmaTabActive) return computeTradeStats([]);
    const gmaSignal: SignalConfig = {
      useGma: gmaApplied,
      useMacd: false,
      maSpreadMin: appliedGmaThresholds.maSpread,
      maCloseMin: appliedGmaThresholds.closeMin,
      useMaThresholds: appliedGmaUseThresholds,
    };
    return computeTradeStats(withActions(gmaBars, gmaSignal));
  }, [gmaBars, gmaTabActive, gmaApplied, appliedGmaThresholds, appliedGmaUseThresholds]);
  const emaTradeStats = useMemo(() => {
    if (!emaApplied || !isUsableEmaParams(emaParams)) return computeTradeStats([]);
    const series = computeDualEma(
      bars.map((bar) => bar.close),
      emaParams.fast,
      emaParams.slow,
    );
    return computeTradeStats(
      withActions(bars, {
        useGma: false,
        useMacd: false,
        useEma: true,
        emaFast: series.fast,
        emaSlow: series.slow,
        maSpreadMin: appliedEmaThresholds.maSpread,
        maCloseMin: appliedEmaThresholds.closeMin,
        useMaThresholds: appliedEmaUseThresholds,
      }),
    );
  }, [bars, emaApplied, emaParams, appliedEmaThresholds, appliedEmaUseThresholds]);
  const gmaMacdTradeStats = useMemo(() => {
    if (!gmaMacdApplied || !isUsableGmaMacdParams(gmaMacdParams)) return computeTradeStats([]);
    return computeTradeStats(
      withActions(bars, {
        useGma: false,
        useMacd: false,
        useGmaMacd: true,
        gmaMacdHist: computeGmaMacd(
          bars.map((bar) => bar.close),
          gmaMacdParams,
        ).hist,
      }),
    );
  }, [bars, gmaMacdApplied, gmaMacdParams]);

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
    const pairChanged = pairRef.current !== pair;
    pairRef.current = pair;
    if (pairChanged) setStatus("loading");
    loadChart(false, symbol, effectiveTf, paramsRef.current).catch(() => undefined);
  }, [symbol, effectiveTf, dataSource, loadChart]);

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

  const cancelEmaOptimize = useCallback(() => {
    const controller = emaOptAbortRef.current;
    if (!controller) return;
    emaOptAbortRef.current = null;
    controller.abort();
    setEmaOptimizing(false);
    setEmaOptimizationProgress(null);
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
    cancelEmaOptimize();
    cancelCrossTfOptimize();
  }, [cancelGmaOptimize, cancelGmaMacdOptimize, cancelEmaOptimize, cancelCrossTfOptimize]);

  const resetSeriesControls = () => {
    setDraft(DEFAULT_PARAMS);
    setParams(DEFAULT_PARAMS);
    setGmaApplied(false);
    setAppliedGmaThresholds(DEFAULT_DUAL_MA_THRESHOLDS);
    setAppliedGmaUseThresholds(false);
    setEmaDraft(DEFAULT_EMA_PARAMS);
    setEmaParams(DEFAULT_EMA_PARAMS);
    setEmaApplied(false);
    setAppliedEmaThresholds(DEFAULT_DUAL_MA_THRESHOLDS);
    setAppliedEmaUseThresholds(false);
    setGmaMacdDraft(DEFAULT_GMA_MACD_PARAMS);
    setGmaMacdParams(DEFAULT_GMA_MACD_PARAMS);
    setGmaMacdApplied(false);
    setConfigGma(true);
    setOptimizeGma(true);
    setOptimizationProgress(null);
    setOptimizationResult(null);
    setGmaMacdOptimizationProgress(null);
    setGmaMacdOptimizationResult(null);
    setEmaOptimizationProgress(null);
    setEmaOptimizationResult(null);
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

  const revealIndicatorConfig = () => {
    setSidebarCollapsed(false);
    window.setTimeout(() => {
      const node = sidebarRef.current;
      if (node) node.scrollTop = 0;
    }, 0);
  };

  const applyConfiguration = () => {
    if (locked || !configValid || !symbol || !effectiveTf || busy) return;
    setGmaApplied(configGma);
    if (configGma) {
      const next: GmaParams = {
        fastLength: Math.max(1, Math.round(draft.fastLength) || 1),
        fastSigma: draft.fastSigma,
        slowLength: Math.max(1, Math.round(draft.slowLength) || 1),
        slowSigma: draft.slowSigma,
      };
      setDraft(next);
      setParams(next);
      setAppliedGmaThresholds(normalizeDualMaThresholds(gmaThresholds));
      setAppliedGmaUseThresholds(optimizeGmaThresholds);
    }
  };

  const applyEmaConfiguration = () => {
    if (locked || !emaUsable || !symbol || !effectiveTf || busy || emaOptimizing) return;
    const next = {
      fast: Math.max(1, Math.round(emaDraft.fast) || 1),
      slow: Math.max(1, Math.round(emaDraft.slow) || 1),
    };
    setEmaDraft(next);
    setEmaParams(next);
    setAppliedEmaThresholds(normalizeDualMaThresholds(emaThresholds));
    setAppliedEmaUseThresholds(optimizeEmaThresholds);
    setEmaApplied(true);
  };

  const optimizeEmas = async () => {
    if (locked || !symbol || !effectiveTf || busy || emaOptimizing) return;
    emaOptAbortRef.current?.abort();
    const controller = new AbortController();
    emaOptAbortRef.current = controller;
    setEmaOptimizing(true);
    setEmaOptimizationProgress(null);
    setEmaOptimizationResult(null);
    setError(null);
    try {
      const result = await runEmaOptimization(
        bars,
        symbol,
        effectiveTf,
        emaOptimizationFeature,
        minTrades,
        maxTrades,
        (progress) => setEmaOptimizationProgress(progress),
        controller.signal,
        { ...emaThresholds, optimizeThresholds: optimizeEmaThresholds },
      );
      if (emaOptAbortRef.current !== controller) return;
      setEmaOptimizationResult(result);
    } catch (err) {
      if (isEmaOptimizationAbort(err) || emaOptAbortRef.current !== controller) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (emaOptAbortRef.current === controller) {
        emaOptAbortRef.current = null;
        setEmaOptimizing(false);
        setEmaOptimizationProgress(null);
      }
    }
  };

  const applyOptimizedEmas = () => {
    if (!emaOptimizationResult) return;
    const best = clampEmaParams({
      fast: emaOptimizationResult.params.fast_length,
      slow: emaOptimizationResult.params.slow_length,
    });
    const thresholds = resultThresholds(emaOptimizationResult, emaThresholds);
    setEmaDraft(best);
    setEmaParams(best);
    setEmaThresholds(thresholds);
    setAppliedEmaThresholds(thresholds);
    setAppliedEmaUseThresholds(optimizeEmaThresholds);
    setEmaApplied(true);
    revealIndicatorConfig();
  };

  const applyGmaMacdConfiguration = () => {
    if (locked || !gmaMacdUsable || !symbol || !effectiveTf || busy) return;
    const next = {
      ...gmaMacdDraft,
      fastLength: Math.max(1, Math.round(gmaMacdDraft.fastLength) || 1),
      slowLength: Math.max(1, Math.round(gmaMacdDraft.slowLength) || 1),
      signalLength: Math.max(1, Math.round(gmaMacdDraft.signalLength) || 1),
    };
    setGmaMacdDraft(next);
    setGmaMacdParams(next);
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
    setGmaMacdParams(best);
    setGmaMacdApplied(true);
    revealIndicatorConfig();
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
        undefined,
        { ...gmaThresholds, optimizeThresholds: optimizeGmaThresholds },
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
    const thresholds = resultThresholds(optimizationResult, gmaThresholds);
    setDraft(best);
    setParams(best);
    setGmaThresholds(thresholds);
    setAppliedGmaThresholds(thresholds);
    setAppliedGmaUseThresholds(optimizeGmaThresholds);
    setConfigGma(true);
    setGmaApplied(true);
    revealIndicatorConfig();
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
        undefined,
        { ...gmaThresholds, optimizeThresholds: optimizeGmaThresholds },
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
    const thresholds = resultThresholds(crossTfResult, gmaThresholds);
    setDraft(best);
    setParams(best);
    setGmaThresholds(thresholds);
    setAppliedGmaThresholds(thresholds);
    setAppliedGmaUseThresholds(optimizeGmaThresholds);
    setConfigGma(true);
    setGmaApplied(true);
    revealIndicatorConfig();
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

      <aside className="sidebar" ref={sidebarRef}>
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
          <h2>GMA</h2>
          <p className="config-lede">
            Dual Gaussian moving averages. Fast is applied to a 3-bar EMA of close; slow to a 3-bar SMA.
          </p>
          <div className={`indicator${gmaApplied ? " active" : ""}`}>
            <label className="indicator-toggle">
              <input
                type="checkbox"
                checked={configGma}
                disabled={locked || busy || optimizing}
                onChange={(event) => setConfigGma(event.target.checked)}
              />
              On chart
            </label>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Fast</p>
              <span className="param-meta" title="Length ÷ sigma">
                EMA 3 · L/σ {formatScale(draft.fastLength, draft.fastSigma)}
              </span>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(GMA_LENGTH_MIN, draft.fastLength)}
                max={sliderMax(GMA_LENGTH_MAX, draft.fastLength)}
                value={draft.fastLength}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, fastLength: Number(e.target.value) })}
              />
              <input
                type="number"
                min={1}
                value={draft.fastLength}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, fastLength: Number(e.target.value) })}
              />
            </label>
            <label title="Gaussian width. Higher is smoother and lowers L/σ">
              Sigma
              <input
                type="range"
                min={sliderMin(GMA_SIGMA_MIN, draft.fastSigma)}
                max={sliderMax(GMA_SIGMA_MAX, draft.fastSigma)}
                step={0.5}
                value={draft.fastSigma}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, fastSigma: Number(e.target.value) })}
              />
              <input
                type="number"
                min={0.01}
                step="any"
                value={draft.fastSigma}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, fastSigma: Number(e.target.value) })}
              />
            </label>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Slow</p>
              <span className="param-meta" title="Length ÷ sigma">
                SMA 3 · L/σ {formatScale(draft.slowLength, draft.slowSigma)}
              </span>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(GMA_LENGTH_MIN, draft.slowLength)}
                max={sliderMax(GMA_LENGTH_MAX, draft.slowLength)}
                value={draft.slowLength}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, slowLength: Number(e.target.value) })}
              />
              <input
                type="number"
                min={1}
                value={draft.slowLength}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, slowLength: Number(e.target.value) })}
              />
            </label>
            <label title="Gaussian width. Higher is smoother and lowers L/σ">
              Sigma
              <input
                type="range"
                min={sliderMin(GMA_SIGMA_MIN, draft.slowSigma)}
                max={sliderMax(GMA_SIGMA_MAX, draft.slowSigma)}
                step={0.5}
                value={draft.slowSigma}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, slowSigma: Number(e.target.value) })}
              />
              <input
                type="number"
                min={0.01}
                step="any"
                value={draft.slowSigma}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, slowSigma: Number(e.target.value) })}
              />
            </label>
          {configGma && (
            <>
              {optimizeGmaThresholds && (
                <DualMaThresholdInputs
                  value={gmaThresholds}
                  disabled={locked || busy || optimizing}
                  onChange={setGmaThresholds}
                />
              )}
              <DualMaSignalRules thresholds={gmaThresholds} useThresholds={optimizeGmaThresholds} />
            </>
          )}
        </div>
          {!configGma && (
            <p className="hint warn">Turn GMA on to apply it to the chart.</p>
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
              optimizing
            }
            onClick={applyConfiguration}
          >
            Apply Configuration
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
              Search GMA
            </label>
          </div>
          {!optimizeGma && (
            <p className="hint warn">Turn GMA on to run optimization.</p>
          )}
          {optimizeGma && <GmaOptimizeBounds />}
          <label className="optimizer-feature" title="What the search maximizes">
            Maximize
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
            <label title="Skip pairs with fewer closed trades than this">
              Min trades
              <input
                type="number"
                min={1}
                value={minTrades}
                disabled={locked || busy || optimizing || !symbol || !effectiveTf}
                onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label title="Optional cap on closed trades. Leave empty for no limit">
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
          <div className="optimizer-indicators">
            <label className="indicator-toggle">
              <input
                type="checkbox"
                checked={optimizeGmaThresholds}
                disabled={locked || optimizing || !optimizeGma}
                onChange={(event) => {
                  setOptimizeGmaThresholds(event.target.checked);
                  setOptimizationResult(null);
                }}
              />
              Optimize thresholds
            </label>
          </div>
          {optimizeGma && !optimizeGmaThresholds && (
            <p className="hint">
              Scores GMA pairs from fast/slow crossovers only.
            </p>
          )}
          {optimizeGma && optimizeGmaThresholds && (
            <p className="hint">
              After the best GMA pair, also searches from-MA and from-close distances in {MA_THRESHOLD_STEP} steps ({MA_THRESHOLD_MIN}–{MA_THRESHOLD_MAX}).
            </p>
          )}
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
              Mark entry and exit points under Manual Optimization first. Label
              score needs those bars as ground truth.
            </p>
          )}
          {optimizationResult && (
            <div className="optimizer-result">
              <div className="optimizer-score">
                <span>Best {optimizationLabel(optimizationFeature)}</span>
                <strong>{optimizationScore(optimizationResult, optimizationFeature)}</strong>
              </div>
              <dl className="optimizer-params">
                <div><dt>Fast GMA</dt><dd>Length {optimizationResult.params.fast_length} · sigma {optimizationResult.params.fast_sigma.toFixed(1)}</dd></div>
                <div><dt>Slow GMA</dt><dd>Length {optimizationResult.params.slow_length} · sigma {optimizationResult.params.slow_sigma.toFixed(1)}</dd></div>
                <div><dt>From MA</dt><dd>{formatThreshold(optimizationResult.params.ma_spread)}</dd></div>
                <div><dt>From close</dt><dd>{formatThreshold(optimizationResult.params.close_min)}</dd></div>
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
          <p className="config-lede">Two exponential moving averages of close.</p>
          <div className={`indicator${emaApplied ? " active" : ""}`}>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Fast</p>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(EMA_LENGTH_MIN, emaDraft.fast)}
                max={sliderMax(EMA_LENGTH_MAX, emaDraft.fast)}
                value={emaDraft.fast}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, fast: Number(e.target.value) })}
              />
              <input
                type="number"
                min={1}
                value={emaDraft.fast}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, fast: Number(e.target.value) })}
              />
            </label>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Slow</p>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(EMA_LENGTH_MIN, emaDraft.slow)}
                max={sliderMax(EMA_LENGTH_MAX, emaDraft.slow)}
                value={emaDraft.slow}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, slow: Number(e.target.value) })}
              />
              <input
                type="number"
                min={1}
                value={emaDraft.slow}
                disabled={locked}
                onChange={(e) => setEmaDraft({ ...emaDraft, slow: Number(e.target.value) })}
              />
            </label>
          {optimizeEmaThresholds && (
            <DualMaThresholdInputs
              value={emaThresholds}
              disabled={locked || busy || emaOptimizing}
              onChange={setEmaThresholds}
            />
          )}
          <DualMaSignalRules thresholds={emaThresholds} useThresholds={optimizeEmaThresholds} />
        </div>
          <button
            type="button"
            className="optimize apply-config"
            disabled={locked || !emaUsable || !symbol || !effectiveTf || busy || emaOptimizing}
            onClick={applyEmaConfiguration}
          >
            Apply to Chart
          </button>
        </section>
        <section className="gma-optimizer">
          <h2>Optimize</h2>
          <EmaOptimizeBounds />
          <label className="optimizer-feature" title="What the search maximizes">
            Maximize
            <select
              value={emaOptimizationFeature}
              disabled={locked || busy || emaOptimizing || !symbol || !effectiveTf}
              onChange={(event) => {
                setEmaOptimizationFeature(event.target.value as EmaOptimizeMetric);
                setEmaOptimizationResult(null);
              }}
            >
              {EMA_OPTIMIZE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label.replace("Maximize ", "")}
                </option>
              ))}
            </select>
          </label>
          <div className="trade-filter">
            <label title="Skip pairs with fewer closed trades than this">
              Min trades
              <input
                type="number"
                min={1}
                value={minTrades}
                disabled={locked || busy || emaOptimizing || !symbol || !effectiveTf}
                onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label title="Optional cap on closed trades. Leave empty for no limit">
              Max trades
              <input
                type="number"
                min={1}
                value={maxTrades ?? ""}
                placeholder="None"
                disabled={locked || busy || emaOptimizing || !symbol || !effectiveTf}
                onChange={(e) => {
                  const raw = e.target.value;
                  setMaxTrades(raw === "" ? null : Math.max(1, Number(raw) || 1));
                }}
              />
            </label>
          </div>
          <div className="optimizer-indicators">
            <label className="indicator-toggle">
              <input
                type="checkbox"
                checked={optimizeEmaThresholds}
                disabled={locked || emaOptimizing}
                onChange={(event) => {
                  setOptimizeEmaThresholds(event.target.checked);
                  setEmaOptimizationResult(null);
                }}
              />
              Optimize thresholds
            </label>
          </div>
          {!optimizeEmaThresholds && (
            <p className="hint">
              Scores EMA pairs from fast/slow crossovers only.
            </p>
          )}
          {optimizeEmaThresholds && (
            <p className="hint">
              After the best EMA pair, also searches from-MA and from-close distances in {MA_THRESHOLD_STEP} steps ({MA_THRESHOLD_MIN}–{MA_THRESHOLD_MAX}).
            </p>
          )}
          <div className="optimizer-actions">
            <button
              type="button"
              className="optimize"
              disabled={locked || busy || emaOptimizing || !symbol || !effectiveTf}
              onClick={optimizeEmas}
            >
              {emaOptimizing
                ? emaOptimizationProgress
                  ? `Optimizing ${Math.round(emaOptimizationProgress.pct)}%`
                  : "Starting optimization…"
                : "Optimize EMA"}
            </button>
            {emaOptimizing && (
              <button
                type="button"
                className="optimize cancel-optimize"
                onClick={cancelEmaOptimize}
              >
                Cancel
              </button>
            )}
          </div>
          {emaOptimizationResult && (
            <div className="optimizer-result">
              <div className="optimizer-score">
                <span>Best {emaOptimizationLabel(emaOptimizationFeature)}</span>
                <strong>
                  {emaOptimizationScore(emaOptimizationResult, emaOptimizationFeature)}
                </strong>
              </div>
              <dl className="optimizer-params">
                <div>
                  <dt>Fast EMA</dt>
                  <dd>Length {emaOptimizationResult.params.fast_length}</dd>
                </div>
                <div>
                  <dt>Slow EMA</dt>
                  <dd>Length {emaOptimizationResult.params.slow_length}</dd>
                </div>
                <div>
                  <dt>From MA</dt>
                  <dd>{formatThreshold(emaOptimizationResult.params.ma_spread)}</dd>
                </div>
                <div>
                  <dt>From close</dt>
                  <dd>{formatThreshold(emaOptimizationResult.params.close_min)}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="optimize apply-config"
                disabled={busy || emaOptimizing}
                onClick={applyOptimizedEmas}
              >
                Apply Best Configuration
              </button>
            </div>
          )}
        </section>
        <SessionStats
          stats={emaTradeStats}
          last={last}
          bars={bars}
          warmupBars={emaWarmupBars(emaParams.fast, emaParams.slow)}
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
          <p className="config-lede">
            MACD is fast GMA minus slow GMA of close. Signal is a GMA of that line. Histogram is MACD minus signal.
          </p>
          <div className={`indicator${gmaMacdApplied ? " active" : ""}`}>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Fast GMA</p>
              <span className="param-meta" title="Length ÷ sigma">
                L/σ {formatScale(gmaMacdDraft.fastLength, gmaMacdDraft.fastSigma)}
              </span>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(GMA_MACD_LENGTH_MIN, gmaMacdDraft.fastLength)}
                max={sliderMax(GMA_MACD_LENGTH_MAX, gmaMacdDraft.fastLength)}
                value={gmaMacdDraft.fastLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={1}
                value={gmaMacdDraft.fastLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastLength: Number(e.target.value) })
                }
              />
            </label>
            <label title="Gaussian width. Higher is smoother and lowers L/σ">
              Sigma
              <input
                type="range"
                min={sliderMin(GMA_MACD_SIGMA_MIN, gmaMacdDraft.fastSigma)}
                max={sliderMax(GMA_MACD_SIGMA_MAX, gmaMacdDraft.fastSigma)}
                value={gmaMacdDraft.fastSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastSigma: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={0.01}
                step="any"
                value={gmaMacdDraft.fastSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, fastSigma: Number(e.target.value) })
                }
              />
            </label>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Slow GMA</p>
              <span className="param-meta" title="Length ÷ sigma">
                L/σ {formatScale(gmaMacdDraft.slowLength, gmaMacdDraft.slowSigma)}
              </span>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(GMA_MACD_LENGTH_MIN, gmaMacdDraft.slowLength)}
                max={sliderMax(GMA_MACD_LENGTH_MAX, gmaMacdDraft.slowLength)}
                value={gmaMacdDraft.slowLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={1}
                value={gmaMacdDraft.slowLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowLength: Number(e.target.value) })
                }
              />
            </label>
            <label title="Gaussian width. Higher is smoother and lowers L/σ">
              Sigma
              <input
                type="range"
                min={sliderMin(GMA_MACD_SIGMA_MIN, gmaMacdDraft.slowSigma)}
                max={sliderMax(GMA_MACD_SIGMA_MAX, gmaMacdDraft.slowSigma)}
                value={gmaMacdDraft.slowSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowSigma: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={0.01}
                step="any"
                value={gmaMacdDraft.slowSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, slowSigma: Number(e.target.value) })
                }
              />
            </label>
            <div className="indicator-sub-row">
              <p className="indicator-sub">Signal GMA</p>
              <span className="param-meta" title="Length ÷ sigma">
                L/σ {formatScale(gmaMacdDraft.signalLength, gmaMacdDraft.signalSigma)}
              </span>
            </div>
            <label title="Lookback window in bars">
              Length
              <input
                type="range"
                min={sliderMin(GMA_MACD_LENGTH_MIN, gmaMacdDraft.signalLength)}
                max={sliderMax(GMA_MACD_SIGNAL_LENGTH_MAX, gmaMacdDraft.signalLength)}
                value={gmaMacdDraft.signalLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalLength: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={1}
                value={gmaMacdDraft.signalLength}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalLength: Number(e.target.value) })
                }
              />
            </label>
            <label title="Gaussian width. Higher is smoother and lowers L/σ">
              Sigma
              <input
                type="range"
                min={sliderMin(GMA_MACD_SIGMA_MIN, gmaMacdDraft.signalSigma)}
                max={sliderMax(GMA_MACD_SIGMA_MAX, gmaMacdDraft.signalSigma)}
                value={gmaMacdDraft.signalSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalSigma: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={0.01}
                step="any"
                value={gmaMacdDraft.signalSigma}
                disabled={locked}
                onChange={(e) =>
                  setGmaMacdDraft({ ...gmaMacdDraft, signalSigma: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <dl className="config-rules">
            <div>
              <dt className="long">Long</dt>
              <dd>Histogram crosses above zero</dd>
            </div>
            <div>
              <dt className="short">Short</dt>
              <dd>Histogram crosses below zero</dd>
            </div>
            <div>
              <dt>Exit</dt>
              <dd>Histogram crosses back through zero</dd>
            </div>
          </dl>
          <button
            type="button"
            className="optimize apply-config"
            disabled={locked || !gmaMacdUsable || !symbol || !effectiveTf || busy || gmaMacdOptimizing}
            onClick={applyGmaMacdConfiguration}
          >
            Apply to Chart
          </button>
        </section>
        <section className="gma-macd-optimizer gma-optimizer">
          <h2>Optimize</h2>
          <GmaMacdOptimizeBounds />
          <label className="optimizer-feature" title="What the search maximizes">
            Maximize
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
            <label title="Skip pairs with fewer closed trades than this">
              Min trades
              <input
                type="number"
                min={1}
                value={minTrades}
                disabled={locked || busy || gmaMacdOptimizing || !symbol || !effectiveTf}
                onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label title="Optional cap on closed trades. Leave empty for no limit">
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
                    Length {gmaMacdOptimizationResult.params.fast_length} · sigma{" "}
                    {gmaMacdOptimizationResult.params.fast_sigma}
                  </dd>
                </div>
                <div>
                  <dt>Slow GMA</dt>
                  <dd>
                    Length {gmaMacdOptimizationResult.params.slow_length} · sigma{" "}
                    {gmaMacdOptimizationResult.params.slow_sigma}
                  </dd>
                </div>
                <div>
                  <dt>Signal GMA</dt>
                  <dd>
                    Length {gmaMacdOptimizationResult.params.signal_length} · sigma{" "}
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
            gmaMacdParams.fastLength,
            gmaMacdParams.slowLength,
            gmaMacdParams.signalLength,
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
              <span>
                MA {formatThreshold(crossTfResult.params.ma_spread)} · close{" "}
                {formatThreshold(crossTfResult.params.close_min)}
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
            emaParams={emaParams}
            gmaParams={params}
            gmaMacdParams={gmaMacdParams}
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
