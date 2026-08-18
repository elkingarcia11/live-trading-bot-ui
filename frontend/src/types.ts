export type SignalSide = "buy" | "sell";
export type Action = "open_call" | "close_call" | "open_put" | "close_put";

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
  actions?: Action[];
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

export type OptimizeMetric =
  | "total_profit"
  | "call_profit"
  | "put_profit"
  | "total_pct"
  | "call_pct"
  | "put_pct";

export const OPTIMIZE_OPTIONS: { id: OptimizeMetric; label: string }[] = [
  { id: "total_profit", label: "Maximize total profit" },
  { id: "call_profit", label: "Maximize call profit" },
  { id: "put_profit", label: "Maximize put profit" },
  { id: "total_pct", label: "Maximize total %" },
  { id: "call_pct", label: "Maximize call %" },
  { id: "put_pct", label: "Maximize put %" },
];

export interface OptimizeProgress {
  type: "progress";
  pct: number;
  elapsed_s: number;
  eta_s: number | null;
  timeframe: string;
  frame: number;
  frames: number;
  tested: number;
  total: number;
  message: string;
}

export const DEFAULT_PARAMS: GmaParams = {
  fastLength: 30,
  fastSigma: 7,
  slowLength: 19,
  slowSigma: 4,
};
