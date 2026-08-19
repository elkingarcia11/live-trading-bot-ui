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
  call_mark_price: number | null;
  put_mark_price: number | null;
  actions?: Action[];
}

export interface ChartResponse {
  symbol: string;
  timeframe: string;
  fingerprint: string;
  updated: string | null;
  loaded_at: string;
  bar_count: number;
  source: "ohlcv" | "trades" | "continuous";
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
  continuous_timeframes?: Record<string, string[]>;
  has_trades?: Record<string, boolean>;
  aggregates?: string[];
}

export interface GmaParams {
  fastLength: number;
  fastSigma: number;
  slowLength: number;
  slowSigma: number;
}

export const GMA_LENGTH_MIN = 5;
export const GMA_LENGTH_MAX = 100;
export const GMA_SIGMA_MIN = 1;
export const GMA_SIGMA_MAX = 10;

export function gmaScale(length: number, sigma: number): number {
  return length / sigma;
}

export function isValidGmaPair(params: GmaParams): boolean {
  return (
    gmaScale(params.fastLength, params.fastSigma) <
    gmaScale(params.slowLength, params.slowSigma)
  );
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

export interface LoadProgress {
  type: "progress";
  pct: number;
  elapsed_s: number;
  eta_s: number | null;
  done: number;
  total: number;
  stage: string;
  message: string;
  timeframe: string;
  source: "ohlcv" | "trades" | "continuous" | "";
  bars?: Bar[];
  append?: boolean;
}

export const DEFAULT_PARAMS: GmaParams = {
  fastLength: 30,
  fastSigma: 7,
  slowLength: 19,
  slowSigma: 4,
};

export type VizParam =
  | "fast_length"
  | "fast_sigma"
  | "slow_length"
  | "slow_sigma";
export type VizMetric =
  | "win_rate"
  | "profit_pct"
  | "call_win_rate"
  | "put_win_rate"
  | "call_profit_pct"
  | "put_profit_pct"
  | "closed";
export type VizAgg = "best" | "mean";

export const VIZ_PARAM_OPTIONS: { id: VizParam; label: string }[] = [
  { id: "fast_length", label: "Fast length" },
  { id: "fast_sigma", label: "Fast σ" },
  { id: "slow_length", label: "Slow length" },
  { id: "slow_sigma", label: "Slow σ" },
];

export const VIZ_METRIC_OPTIONS: { id: VizMetric; label: string }[] = [
  { id: "win_rate", label: "Total win rate" },
  { id: "profit_pct", label: "Total profit %" },
  { id: "call_win_rate", label: "Call win rate" },
  { id: "put_win_rate", label: "Put win rate" },
  { id: "call_profit_pct", label: "Call profit %" },
  { id: "put_profit_pct", label: "Put profit %" },
  { id: "closed", label: "Closed trades" },
];

export const SEARCH_METRIC_FIELD: Record<OptimizeMetric, VizMetric> = {
  total_win_rate: "win_rate",
  call_win_rate: "call_win_rate",
  put_win_rate: "put_win_rate",
  total_profit_pct: "profit_pct",
  call_profit_pct: "call_profit_pct",
  put_profit_pct: "put_profit_pct",
};

export interface VizTrial {
  fast_length: number;
  fast_sigma: number;
  slow_length: number;
  slow_sigma: number;
  win_rate: number;
  profit_pct: number;
  call_win_rate: number;
  put_win_rate: number;
  call_profit_pct: number;
  put_profit_pct: number;
  closed: number;
  wins: number;
  close_calls: number;
  close_puts: number;
}

export interface VizHeatmap {
  x: VizParam;
  y: VizParam;
  x_values: number[];
  y_values: number[];
  count: (number | null)[][];
  metrics: Record<
    VizMetric,
    { best: (number | null)[][]; mean: (number | null)[][] }
  >;
  winners: Record<VizMetric, Record<VizParam, (number | null)[][]>>;
}

export interface VizCurve {
  values: number[];
  count: number[];
  win_rate: { best: (number | null)[]; mean: (number | null)[] };
  profit_pct: { best: (number | null)[]; mean: (number | null)[] };
  call_win_rate: { best: (number | null)[]; mean: (number | null)[] };
  put_win_rate: { best: (number | null)[]; mean: (number | null)[] };
  call_profit_pct: { best: (number | null)[]; mean: (number | null)[] };
  put_profit_pct: { best: (number | null)[]; mean: (number | null)[] };
  closed: { best: (number | null)[]; mean: (number | null)[] };
}

export interface OptimizeViz {
  n_trials: number;
  metric: OptimizeMetric;
  params: VizParam[];
  metrics: VizMetric[];
  heatmaps: VizHeatmap[];
  curves: Record<VizParam, VizCurve>;
  correlations: Record<VizMetric, Record<VizParam, number>>;
  top_trials: VizTrial[];
}

export interface OptimizeResult {
  symbol: string;
  metric: OptimizeMetric;
  timeframe: string;
  params: {
    fast_length: number;
    fast_sigma: number;
    slow_length: number;
    slow_sigma: number;
  };
  win_rate: number;
  call_win_rate: number | null;
  put_win_rate: number | null;
  profit: number;
  call_profit: number;
  put_profit: number;
  profit_pct: number;
  closed_trades: number;
  close_calls: number;
  close_puts: number;
  call_profit_pct: number;
  put_profit_pct: number;
  wins: number;
  call_wins: number;
  put_wins: number;
  bars: number;
  tested: number;
  max_drawdown_pct?: number;
  max_runup_pct?: number;
  average_profit_pct?: number;
  error?: string;
  viz?: OptimizeViz | null;
}

export interface ResultsCatalog {
  symbols: Record<
    string,
    Record<string, { timeframe: string; has_viz: boolean }[]>
  >;
}

export interface ResultSummary {
  symbol: string;
  metric: string;
  best_overall: OptimizeResult | null;
  by_timeframe: OptimizeResult[];
}
