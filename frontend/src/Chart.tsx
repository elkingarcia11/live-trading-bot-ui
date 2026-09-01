import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { computeGmaMacd } from "./gmaMacd";
import { computeMacd } from "./macd";
import { ACTION_MARKER_TEXT } from "./tradeStats";
import type { Action, Bar, GmaMacdParams, MacdParams, ManualPoint, ManualSelectionMode } from "./types";

export type ChartZone = "local" | "et" | "ct" | "utc";

export const CHART_ZONES: { id: ChartZone; label: string; iana?: string }[] = [
  { id: "local", label: "Local" },
  { id: "et", label: "Eastern", iana: "America/New_York" },
  { id: "ct", label: "Exchange CT", iana: "America/Chicago" },
  { id: "utc", label: "UTC", iana: "UTC" },
];

const ACTION_MARKER_STYLE: Record<
  Action,
  { position: "belowBar" | "aboveBar"; color: string; shape: "arrowUp" | "arrowDown" }
> = {
  open_call: { position: "belowBar", color: "#00e676", shape: "arrowUp" },
  close_call: { position: "aboveBar", color: "#ff5252", shape: "arrowDown" },
  open_put: { position: "aboveBar", color: "#ff5252", shape: "arrowDown" },
  close_put: { position: "belowBar", color: "#00e676", shape: "arrowUp" },
};

interface Props {
  bars: Bar[];
  fitKey: string;
  timeZone: ChartZone;
  showIndicators: boolean;
  showMacd?: boolean;
  showGmaMacd?: boolean;
  showSignals?: boolean;
  macdParams?: MacdParams;
  gmaMacdParams?: GmaMacdParams;
  /** When not "off", a click on the chart adds/removes a selection point. */
  selectionMode?: ManualSelectionMode;
  /** Target entry points ($E_k$) to render as markers. */
  entryPoints?: ManualPoint[];
  /** Target exit points ($X_k$) to render as markers. */
  exitPoints?: ManualPoint[];
  /** Raised when the user clicks a bar while a selection mode is active.
   *  `index` is the bar index $t$, `time` its unix-second timestamp. */
  onSelectPoint?: (kind: "entry" | "exit", index: number, time: number) => void;
}

/** Imperative controls exposed to the parent via a ref. */
export interface ChartHandle {
  /** Scroll the chart to the latest (rightmost) bar. */
  scrollToFront: () => void;
}

const MACD_LINE = "#26c6da";
const MACD_SIGNAL = "#e040fb";
const MACD_HIST_UP = "rgba(38, 166, 154, 0.75)";
const MACD_HIST_DOWN = "rgba(239, 83, 80, 0.75)";

const GMA_MACD_LINE = "#2196F3";
const GMA_MACD_SIGNAL = "#FF6D00";
const GMA_MACD_HIST_UP = "rgba(76, 175, 80, 0.4)";
const GMA_MACD_HIST_DOWN = "rgba(244, 67, 54, 0.4)";

const CHART_LAYOUT = {
  background: { type: ColorType.Solid, color: "#0c1016" },
  textColor: "#8b95a5",
  fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
  fontSize: 11,
} as const;

const CHART_GRID = {
  vertLines: { color: "#171d26" },
  horzLines: { color: "#171d26" },
};

const CHART_CROSSHAIR = {
  mode: CrosshairMode.Normal,
  vertLine: { color: "#3d4a5c", width: 1, style: 2, labelBackgroundColor: "#1c2430" },
  horzLine: { color: "#3d4a5c", width: 1, style: 2, labelBackgroundColor: "#1c2430" },
} as const;

/** Return the index of the bar whose time is nearest to `target` (binary search). */
function nearestIndex(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const prev = times[lo - 1];
  const next = times[lo];
  return target - prev <= next - target ? lo - 1 : lo;
}

function ianaFor(zone: ChartZone): string | undefined {
  return CHART_ZONES.find((item) => item.id === zone)?.iana;
}

function dateOpts(zone: ChartZone, withDate: boolean): Intl.DateTimeFormatOptions {
  const iana = ianaFor(zone);
  return {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    ...(iana ? { timeZone: iana } : {}),
  };
}

function unixOf(time: UTCTimestamp): number {
  return typeof time === "number" ? time : Number(time);
}

export function formatChartTime(unix: number, zone: ChartZone, withDate = false): string {
  return new Date(unix * 1000).toLocaleString("en-US", dateOpts(zone, withDate));
}

function uniqueBars(bars: Bar[]): Bar[] {
  const used = new Set<number>();
  return bars.map((bar) => {
    let time = bar.time;
    while (used.has(time)) time += 1;
    used.add(time);
    return { ...bar, time };
  });
}

function lineOrWhitespace(
  times: number[],
  values: Array<number | null>,
): { time: UTCTimestamp; value?: number }[] {
  return times.map((time, i) => {
    const value = values[i];
    return value == null
      ? { time: time as UTCTimestamp }
      : { time: time as UTCTimestamp, value };
  });
}

const Chart = forwardRef<ChartHandle, Props>(function Chart(
  {
    bars,
    fitKey,
    timeZone,
    showIndicators,
    showMacd = false,
    showGmaMacd = false,
    showSignals = false,
    macdParams,
    gmaMacdParams,
    selectionMode = "off",
    entryPoints = [],
    exitPoints = [],
    onSelectPoint,
  }: Props,
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const macdHostRef = useRef<HTMLDivElement | null>(null);
  const gmaMacdHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  const gmaMacdChartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fastRef = useRef<ISeriesApi<"Line"> | null>(null);
  const slowRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const gmaMacdLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const gmaMacdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const gmaMacdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedKeyRef = useRef("");
  const syncingRangeRef = useRef(false);
  const zoneRef = useRef(timeZone);
  zoneRef.current = timeZone;

  const applyTimeScaleFormat = useCallback((chart: IChartApi, zone: ChartZone) => {
    chart.applyOptions({
      timeScale: {
        tickMarkFormatter: (time: UTCTimestamp) => formatChartTime(unixOf(time), zone),
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) => formatChartTime(unixOf(time), zone, true),
      },
    });
  }, []);

  const copyVisibleRange = useCallback((from: IChartApi | null, to: IChartApi | null) => {
    if (!from || !to) return;
    const range = from.timeScale().getVisibleLogicalRange();
    if (!range) return;
    syncingRangeRef.current = true;
    to.timeScale().setVisibleLogicalRange(range);
    syncingRangeRef.current = false;
  }, []);

  const subscribeRangeSyncAll = useCallback((source: IChartApi) => {
    const handler = (range: LogicalRange | null) => {
      if (!range || syncingRangeRef.current) return;
      syncingRangeRef.current = true;
      for (const chart of [chartRef.current, macdChartRef.current, gmaMacdChartRef.current]) {
        if (chart && chart !== source) {
          chart.timeScale().setVisibleLogicalRange(range);
        }
      }
      syncingRangeRef.current = false;
    };
    source.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => source.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  }, []);

  const updateTimeScaleVisibility = useCallback(() => {
    chartRef.current?.applyOptions({ timeScale: { visible: !showMacd && !showGmaMacd } });
    macdChartRef.current?.applyOptions({ timeScale: { visible: showMacd && !showGmaMacd } });
    gmaMacdChartRef.current?.applyOptions({ timeScale: { visible: showGmaMacd } });
  }, [showMacd, showGmaMacd]);

  const scrollToFront = useCallback(() => {
    chartRef.current?.timeScale().scrollToRealTime();
    macdChartRef.current?.timeScale().scrollToRealTime();
    gmaMacdChartRef.current?.timeScale().scrollToRealTime();
  }, []);
  useImperativeHandle(ref, () => ({ scrollToFront }), [scrollToFront]);

  // Keep the latest imperative-mode props in refs so the single click handler
  // subscribed at chart creation always reads current values without resubscribing.
  const modeRef = useRef<ManualSelectionMode>("off");
  modeRef.current = selectionMode;
  const barsRef = useRef<Bar[]>([]);
  barsRef.current = bars;
  const onSelectRef = useRef(onSelectPoint);
  onSelectRef.current = onSelectPoint;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      layout: CHART_LAYOUT,
      grid: CHART_GRID,
      crosshair: CHART_CROSSHAIR,
      rightPriceScale: {
        borderColor: "#1c2430",
        scaleMargins: { top: 0.14, bottom: 0.24 },
      },
      timeScale: {
        borderColor: "#1c2430",
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (time: UTCTimestamp) =>
          formatChartTime(unixOf(time), zoneRef.current),
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          formatChartTime(unixOf(time), zoneRef.current, true),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const candles = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    const fast = chart.addLineSeries({
      color: "#5b9dff",
      lineWidth: 2,
      title: "Fast GMA (EMA 3)",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    const slow = chart.addLineSeries({
      color: "#ff9f43",
      lineWidth: 2,
      title: "Slow GMA (SMA 3)",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      borderVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candles;
    fastRef.current = fast;
    slowRef.current = slow;
    volumeRef.current = volume;

    chart.subscribeClick((param: MouseEventParams) => {
      const mode = modeRef.current;
      if (mode === "off" || !onSelectRef.current) return;
      const loadedBars = barsRef.current;
      if (!loadedBars.length || param.time == null) return;
      // `param.time` is the exact bar time at the click location (numeric for
      // this continuous, second-resolution series); resolve it to the nearest
      // loaded bar so a click always maps to a valid $t$.
      if (typeof param.time !== "number") return;
      const index = nearestIndex(
        loadedBars.map((bar) => bar.time),
        param.time,
      );
      onSelectRef.current(mode, index, loadedBars[index].time);
    });

    applyTimeScaleFormat(chart, zoneRef.current);
    const unsubRange = subscribeRangeSyncAll(chart);

    const resize = () => {
      chart.applyOptions({
        width: host.clientWidth,
        height: host.clientHeight,
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      unsubRange();
      chart.remove();
      chartRef.current = null;
    };
  }, [applyTimeScaleFormat, subscribeRangeSyncAll]);

  useEffect(() => {
    if (!showMacd) {
      updateTimeScaleVisibility();
      return;
    }
    const host = macdHostRef.current;
    if (!host) return;

    const macdChart = createChart(host, {
      layout: { ...CHART_LAYOUT, attributionLogo: false },
      grid: CHART_GRID,
      crosshair: CHART_CROSSHAIR,
      rightPriceScale: {
        borderColor: "#1c2430",
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "#1c2430",
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (time: UTCTimestamp) =>
          formatChartTime(unixOf(time), zoneRef.current),
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          formatChartTime(unixOf(time), zoneRef.current, true),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const hist = macdChart.addHistogramSeries({
      priceLineVisible: false,
      lastValueVisible: false,
      title: "Hist",
    });
    const macdLine = macdChart.addLineSeries({
      color: MACD_LINE,
      lineWidth: 2,
      title: "MACD",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    const signal = macdChart.addLineSeries({
      color: MACD_SIGNAL,
      lineWidth: 2,
      title: "Signal",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    macdLine.createPriceLine({
      price: 0,
      color: "#3d4a5c",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
    });

    macdChartRef.current = macdChart;
    macdLineRef.current = macdLine;
    macdSignalRef.current = signal;
    macdHistRef.current = hist;
    applyTimeScaleFormat(macdChart, zoneRef.current);
    copyVisibleRange(chartRef.current, macdChart);
    updateTimeScaleVisibility();

    const unsubMacd = subscribeRangeSyncAll(macdChart);

    const resize = () => {
      macdChart.applyOptions({
        width: host.clientWidth,
        height: host.clientHeight,
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      unsubMacd();
      macdChart.remove();
      macdChartRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
      updateTimeScaleVisibility();
    };
  }, [showMacd, applyTimeScaleFormat, copyVisibleRange, subscribeRangeSyncAll, updateTimeScaleVisibility]);

  useEffect(() => {
    if (!showGmaMacd) {
      updateTimeScaleVisibility();
      return;
    }
    const host = gmaMacdHostRef.current;
    if (!host) return;

    const gmaMacdChart = createChart(host, {
      layout: { ...CHART_LAYOUT, attributionLogo: false },
      grid: CHART_GRID,
      crosshair: CHART_CROSSHAIR,
      rightPriceScale: {
        borderColor: "#1c2430",
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "#1c2430",
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (time: UTCTimestamp) =>
          formatChartTime(unixOf(time), zoneRef.current),
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          formatChartTime(unixOf(time), zoneRef.current, true),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const hist = gmaMacdChart.addHistogramSeries({
      priceLineVisible: false,
      lastValueVisible: false,
      title: "Hist",
    });
    const macdLine = gmaMacdChart.addLineSeries({
      color: GMA_MACD_LINE,
      lineWidth: 2,
      title: "MACD",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    const signal = gmaMacdChart.addLineSeries({
      color: GMA_MACD_SIGNAL,
      lineWidth: 2,
      title: "Signal",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    macdLine.createPriceLine({
      price: 0,
      color: "#3d4a5c",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
    });

    gmaMacdChartRef.current = gmaMacdChart;
    gmaMacdLineRef.current = macdLine;
    gmaMacdSignalRef.current = signal;
    gmaMacdHistRef.current = hist;
    applyTimeScaleFormat(gmaMacdChart, zoneRef.current);
    copyVisibleRange(chartRef.current ?? macdChartRef.current, gmaMacdChart);
    updateTimeScaleVisibility();

    const unsub = subscribeRangeSyncAll(gmaMacdChart);

    const resize = () => {
      gmaMacdChart.applyOptions({
        width: host.clientWidth,
        height: host.clientHeight,
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      unsub();
      gmaMacdChart.remove();
      gmaMacdChartRef.current = null;
      gmaMacdLineRef.current = null;
      gmaMacdSignalRef.current = null;
      gmaMacdHistRef.current = null;
      updateTimeScaleVisibility();
    };
  }, [showGmaMacd, applyTimeScaleFormat, copyVisibleRange, subscribeRangeSyncAll, updateTimeScaleVisibility]);

  useEffect(() => {
    if (chartRef.current) applyTimeScaleFormat(chartRef.current, timeZone);
    if (macdChartRef.current) applyTimeScaleFormat(macdChartRef.current, timeZone);
    if (gmaMacdChartRef.current) applyTimeScaleFormat(gmaMacdChartRef.current, timeZone);
  }, [timeZone, applyTimeScaleFormat]);

  useEffect(() => {
    if (!candleRef.current || !fastRef.current || !slowRef.current || !volumeRef.current) {
      return;
    }
    if (bars.length === 0) {
      candleRef.current.setData([]);
      fastRef.current.setData([]);
      slowRef.current.setData([]);
      volumeRef.current.setData([]);
      candleRef.current.setMarkers([]);
      macdLineRef.current?.setData([]);
      macdSignalRef.current?.setData([]);
      macdHistRef.current?.setData([]);
      gmaMacdLineRef.current?.setData([]);
      gmaMacdSignalRef.current?.setData([]);
      gmaMacdHistRef.current?.setData([]);
      return;
    }

    const unique = uniqueBars(bars);

    candleRef.current.setData(
      unique.map((bar) => ({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }))
    );
    fastRef.current.setData(
      showIndicators
        ? unique
            .filter((bar) => bar.gma_fast != null)
            .map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.gma_fast as number }))
        : []
    );
    slowRef.current.setData(
      showIndicators
        ? unique
            .filter((bar) => bar.gma_slow != null)
            .map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.gma_slow as number }))
        : []
    );
    volumeRef.current.setData(
      unique.map((bar) => ({
        time: bar.time as UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? "rgba(38, 166, 154, 0.35)" : "rgba(239, 83, 80, 0.35)",
      }))
    );

    if (showMacd && macdParams && macdLineRef.current && macdSignalRef.current && macdHistRef.current) {
      const times = unique.map((bar) => bar.time);
      const series = computeMacd(unique.map((bar) => bar.close), macdParams.fast, macdParams.slow, macdParams.signal);
      macdLineRef.current.setData(lineOrWhitespace(times, series.macd));
      macdSignalRef.current.setData(lineOrWhitespace(times, series.signal));
      macdHistRef.current.setData(
        times.map((time, i) => {
          const value = series.hist[i];
          return value == null
            ? { time: time as UTCTimestamp }
            : {
                time: time as UTCTimestamp,
                value,
                color: value >= 0 ? MACD_HIST_UP : MACD_HIST_DOWN,
              };
        }),
      );
      copyVisibleRange(chartRef.current, macdChartRef.current);
    }

    if (
      showGmaMacd &&
      gmaMacdParams &&
      gmaMacdLineRef.current &&
      gmaMacdSignalRef.current &&
      gmaMacdHistRef.current
    ) {
      const times = unique.map((bar) => bar.time);
      const series = computeGmaMacd(unique.map((bar) => bar.close), gmaMacdParams);
      gmaMacdLineRef.current.setData(lineOrWhitespace(times, series.macd));
      gmaMacdSignalRef.current.setData(lineOrWhitespace(times, series.signal));
      gmaMacdHistRef.current.setData(
        times.map((time, i) => {
          const value = series.hist[i];
          return value == null
            ? { time: time as UTCTimestamp }
            : {
                time: time as UTCTimestamp,
                value,
                color: value >= 0 ? GMA_MACD_HIST_UP : GMA_MACD_HIST_DOWN,
              };
        }),
      );
      copyVisibleRange(chartRef.current ?? macdChartRef.current, gmaMacdChartRef.current);
    }

    const markers: SeriesMarker<UTCTimestamp>[] = [];
    if (showSignals) {
      unique.forEach((bar) => {
        for (const action of bar.actions ?? []) {
          const style = ACTION_MARKER_STYLE[action];
          markers.push({
            time: bar.time as UTCTimestamp,
            position: style.position,
            color: style.color,
            shape: style.shape,
            size: 2.5,
            text: ACTION_MARKER_TEXT[action],
          });
        }
      });
    }
    // Resolve manual entry ($E_k$) / exit ($X_k$) point indices against the
    // unique times used for the series so markers land on the exact bar.
    const timeIndex = new Map<number, number>();
    unique.forEach((bar, i) => timeIndex.set(bar.time, i));
    entryPoints.forEach((p, k) => {
      const t = timeIndex.get(p.time);
      if (t == null) return;
      markers.push({
        time: p.time as UTCTimestamp,
        position: "inBar",
        color: "#00e676",
        shape: "circle",
        size: 1.6,
        id: `manual-entry-${k}`,
        text: (k + 1).toString(),
      });
    });
    exitPoints.forEach((p, k) => {
      const t = timeIndex.get(p.time);
      if (t == null) return;
      markers.push({
        time: p.time as UTCTimestamp,
        position: "inBar",
        color: "#ff5252",
        shape: "circle",
        size: 1.6,
        id: `manual-exit-${k}`,
        text: (k + 1).toString(),
      });
    });
    candleRef.current.setMarkers(markers);
    // Fit the view when a brand-new series is loaded (symbol/timeframe change).
    // On incremental live updates we deliberately do NOT scroll, so the user
    // stays wherever they are on the chart.
    if (fittedKeyRef.current !== fitKey) {
      fittedKeyRef.current = fitKey;
      chartRef.current?.timeScale().fitContent();
      copyVisibleRange(chartRef.current, macdChartRef.current);
      copyVisibleRange(chartRef.current, gmaMacdChartRef.current);
    }
  }, [
    bars,
    fitKey,
    showIndicators,
    showSignals,
    showMacd,
    showGmaMacd,
    macdParams,
    gmaMacdParams,
    entryPoints,
    exitPoints,
    copyVisibleRange,
  ]);

  const stackClass = [
    "chart-stack",
    showMacd ? "has-macd" : "",
    showGmaMacd ? "has-gma-macd" : "",
    showMacd && showGmaMacd ? "has-dual-macd" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={stackClass}>
      <div className="chart-host" ref={hostRef} />
      {showMacd && (
        <div className="macd-host" ref={macdHostRef}>
          {macdParams && (
            <div className="macd-label">
              MACD EMA ({macdParams.fast}, {macdParams.slow}, {macdParams.signal})
            </div>
          )}
        </div>
      )}
      {showGmaMacd && (
        <div className="gma-macd-host" ref={gmaMacdHostRef}>
          {gmaMacdParams && (
            <div className="macd-label">
              GMA MACD F {gmaMacdParams.fastLength}/{gmaMacdParams.fastSigma} · S{" "}
              {gmaMacdParams.slowLength}/{gmaMacdParams.slowSigma} · Sig{" "}
              {gmaMacdParams.signalLength}/{gmaMacdParams.signalSigma}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default Chart;
