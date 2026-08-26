import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, ManualPoint, ManualSelectionMode } from "./types";

export type ChartZone = "local" | "et" | "ct" | "utc";

export const CHART_ZONES: { id: ChartZone; label: string; iana?: string }[] = [
  { id: "local", label: "Local" },
  { id: "et", label: "Eastern", iana: "America/New_York" },
  { id: "ct", label: "Exchange CT", iana: "America/Chicago" },
  { id: "utc", label: "UTC", iana: "UTC" },
];

interface Props {
  bars: Bar[];
  fitKey: string;
  timeZone: ChartZone;
  showIndicators: boolean;
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

export default function Chart({
  bars,
  fitKey,
  timeZone,
  showIndicators,
  selectionMode = "off",
  entryPoints = [],
  exitPoints = [],
  onSelectPoint,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fastRef = useRef<ISeriesApi<"Line"> | null>(null);
  const slowRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedKeyRef = useRef("");
  const zoneRef = useRef(timeZone);
  zoneRef.current = timeZone;

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
      layout: {
        background: { type: ColorType.Solid, color: "#0c1016" },
        textColor: "#8b95a5",
        fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#171d26" },
        horzLines: { color: "#171d26" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3d4a5c", width: 1, style: 2, labelBackgroundColor: "#1c2430" },
        horzLine: { color: "#3d4a5c", width: 1, style: 2, labelBackgroundColor: "#1c2430" },
      },
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
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: {
        tickMarkFormatter: (time: UTCTimestamp) => formatChartTime(unixOf(time), timeZone),
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) => formatChartTime(unixOf(time), timeZone, true),
      },
    });
  }, [timeZone]);

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
      return;
    }

    const used = new Set<number>();
    const unique = bars.map((bar) => {
      let time = bar.time;
      while (used.has(time)) time += 1;
      used.add(time);
      return { ...bar, time };
    });

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
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    if (showIndicators) {
      unique
        .filter((bar) => bar.actions?.length)
        .forEach((bar) => {
          const callish =
            bar.actions!.includes("open_call") || bar.actions!.includes("close_put");
          markers.push({
            time: bar.time as UTCTimestamp,
            position: (callish ? "belowBar" : "aboveBar") as "belowBar" | "aboveBar",
            color: callish ? "#00e676" : "#ff5252",
            shape: (callish ? "arrowUp" : "arrowDown") as "arrowUp" | "arrowDown",
            size: 2.5,
          });
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
    if (fittedKeyRef.current !== fitKey) {
      fittedKeyRef.current = fitKey;
      chartRef.current?.timeScale().fitContent();
    } else {
      chartRef.current?.timeScale().scrollToRealTime();
    }
  }, [bars, fitKey, showIndicators, entryPoints, exitPoints]);

  return <div className="chart-host" ref={hostRef} />;
}
