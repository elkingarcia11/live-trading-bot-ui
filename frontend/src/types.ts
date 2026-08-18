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
  | "total_win_rate"
  | "call_win_rate"
  | "put_win_rate"
  | "total_profit_pct"
  | "call_profit_pct"
  | "put_profit_pct";

export const OPTIMIZE_OPTIONS: { id: OptimizeMetric; label: string }[] = [
  { id: "total_win_rate", label: "Maximize total win rate" },
  { id: "call_win_rate", label: "Maximize call win rate" },
  { id: "put_win_rate", label: "Maximize put win rate" },
  { id: "total_profit_pct", label: "Maximize total profit %" },
  { id: "call_profit_pct", label: "Maximize call profit %" },
  { id: "put_profit_pct", label: "Maximize put profit %" },
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
