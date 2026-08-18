export type SignalSide = "buy" | "sell";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  gma_fast: number | null;
  gma_slow: number | null;
  signal: SignalSide | null;
}

export interface ChartResponse {
  symbol: string;
  timeframe: string;
  fingerprint: string;
  updated: string | null;
  loaded_at: string;
  bar_count: number;
  source: "ohlcv" | "trades";
  path: string;
  params: {
    fast_length: number;
    fast_sigma: number;
    slow_length: number;
    slow_sigma: number;
  };
  bars: Bar[];
  signals: { time: number; side: SignalSide; price: number }[];
}

export interface CatalogResponse {
  bucket: string;
  prefix: string;
  symbols: Record<string, string[]>;
  ohlcv_timeframes?: Record<string, string[]>;
  has_trades?: Record<string, boolean>;
  aggregates?: string[];
}

export interface GmaParams {
  fastLength: number;
  fastSigma: number;
  slowLength: number;
  slowSigma: number;
}

export const DEFAULT_PARAMS: GmaParams = {
  fastLength: 30,
  fastSigma: 7,
  slowLength: 19,
  slowSigma: 4,
};
