import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar } from "./types";

interface Props {
  bars: Bar[];
  fitKey: string;
}

const CHICAGO: Intl.DateTimeFormatOptions = {
  timeZone: "America/Chicago",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

function formatTick(time: UTCTimestamp): string {
  return new Date(time * 1000).toLocaleTimeString("en-US", CHICAGO);
}

export default function Chart({ bars, fitKey }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fastRef = useRef<ISeriesApi<"Line"> | null>(null);
  const slowRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedKeyRef = useRef("");

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
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: "#1c2430",
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (time: UTCTimestamp) => formatTick(time),
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          new Date(time * 1000).toLocaleString("en-US", {
            timeZone: "America/Chicago",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
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
      title: "Fast GMA",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    const slow = chart.addLineSeries({
      color: "#ff9f43",
      lineWidth: 2,
      title: "Slow GMA",
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
      unique
        .filter((bar) => bar.gma_fast != null)
        .map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.gma_fast as number }))
    );
    slowRef.current.setData(
      unique
        .filter((bar) => bar.gma_slow != null)
        .map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.gma_slow as number }))
    );
    volumeRef.current.setData(
      unique.map((bar) => ({
        time: bar.time as UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? "rgba(38, 166, 154, 0.35)" : "rgba(239, 83, 80, 0.35)",
      }))
    );
    candleRef.current.setMarkers(
      unique
        .filter((bar) => bar.signal)
        .map((bar) =>
          bar.signal === "buy"
            ? {
                time: bar.time as UTCTimestamp,
                position: "belowBar" as const,
                color: "#00e676",
                shape: "arrowUp" as const,
                text: "BUY",
              }
            : {
                time: bar.time as UTCTimestamp,
                position: "aboveBar" as const,
                color: "#ff5252",
                shape: "arrowDown" as const,
                text: "SELL",
              }
        )
    );
    if (fittedKeyRef.current !== fitKey) {
      fittedKeyRef.current = fitKey;
      chartRef.current?.timeScale().fitContent();
    } else {
      chartRef.current?.timeScale().scrollToRealTime();
    }
  }, [bars, fitKey]);

  return <div className="chart-host" ref={hostRef} />;
}
