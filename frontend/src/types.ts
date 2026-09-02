export type SignalSide = "buy" | "sell";
export type Action = "open_call" | "close_call" | "open_put" | "close_put";

import type { LabelScoreBreakdown } from "./labelScoring";

/** Manual Optimization — a point a user places on the historical chart. */
export interface ManualPoint {
  /** Bar index $t$ into the loaded historical series. */
  index: number;
  /** Unix epoch seconds (the bar's timestamp) — stored for persistence. */
  time: number;
}

/** Which click-driven selection the chart is currently collecting. */
export type ManualSelectionMode = "off" | "entry" | "exit";

/** Acceptable window around a target entry point, in candles (bars). */
export interface ManualEntryWindow {
  /** Candles before the target point still considered acceptable. */
  preSignal: number;
  /** Candles after the target point still considered acceptable (lag). */
  lag: number;
}

export const DEFAULT_MANUAL_WINDOW: ManualEntryWindow = { preSignal: 2, lag: 5 };

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

export const GMA_LENGTH_MIN = 1;
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

/** Clamp GMA params to the range the backend `/api/chart` accepts
 *  (length 5–100, sigma 1–10) so applying optimizer results can never
 *  trigger a 422 validation error. */
export function clampGmaParams(params: GmaParams): GmaParams {
  return {
    fastLength: Math.min(GMA_LENGTH_MAX, Math.max(GMA_LENGTH_MIN, params.fastLength)),
    fastSigma: Math.min(GMA_SIGMA_MAX, Math.max(GMA_SIGMA_MIN, params.fastSigma)),
    slowLength: Math.min(GMA_LENGTH_MAX, Math.max(GMA_LENGTH_MIN, params.slowLength)),
    slowSigma: Math.min(GMA_SIGMA_MAX, Math.max(GMA_SIGMA_MIN, params.slowSigma)),
  };
}

export interface EmaParams {
  fast: number;
  slow: number;
}

export const EMA_LENGTH_MIN = 1;
export const EMA_LENGTH_MAX = 100;

export const DEFAULT_EMA_PARAMS: EmaParams = {
  fast: 12,
  slow: 26,
};

export function isValidEmaPair(params: EmaParams): boolean {
  return (
    params.fast >= EMA_LENGTH_MIN &&
    params.slow >= EMA_LENGTH_MIN &&
    params.fast <= EMA_LENGTH_MAX &&
    params.slow <= EMA_LENGTH_MAX &&
    params.fast < params.slow
  );
}

export function clampEmaParams(params: EmaParams): EmaParams {
  const clampLen = (value: number) =>
    Math.min(EMA_LENGTH_MAX, Math.max(EMA_LENGTH_MIN, Math.round(value) || EMA_LENGTH_MIN));
  return {
    fast: clampLen(params.fast),
    slow: clampLen(params.slow),
  };
}

export interface MacdParams {
  fast: number;
  slow: number;
  signal: number;
}

export const MACD_PERIOD_MIN = 1;
export const MACD_FAST_MAX = 50;
export const MACD_SLOW_MAX = 200;
export const MACD_SIGNAL_MAX = 50;

export const DEFAULT_MACD_PARAMS: MacdParams = {
  fast: 12,
  slow: 26,
  signal: 9,
};

export function isValidMacdPair(params: MacdParams): boolean {
  return (
    params.fast >= MACD_PERIOD_MIN &&
    params.slow >= MACD_PERIOD_MIN &&
    params.signal >= MACD_PERIOD_MIN &&
    params.fast < params.slow
  );
}

export function clampMacdParams(params: MacdParams): MacdParams {
  return {
    fast: Math.min(MACD_FAST_MAX, Math.max(MACD_PERIOD_MIN, Math.round(params.fast) || MACD_PERIOD_MIN)),
    slow: Math.min(MACD_SLOW_MAX, Math.max(MACD_PERIOD_MIN, Math.round(params.slow) || MACD_PERIOD_MIN)),
    signal: Math.min(MACD_SIGNAL_MAX, Math.max(MACD_PERIOD_MIN, Math.round(params.signal) || MACD_PERIOD_MIN)),
  };
}

export interface GmaMacdParams {
  fastLength: number;
  fastSigma: number;
  slowLength: number;
  slowSigma: number;
  signalLength: number;
  signalSigma: number;
}

export const GMA_MACD_LENGTH_MIN = 1;
export const GMA_MACD_LENGTH_MAX = 100;
export const GMA_MACD_SIGMA_MIN = 1;
export const GMA_MACD_SIGMA_MAX = 50;
export const GMA_MACD_SIGNAL_LENGTH_MAX = 15;
export const GMA_MACD_SCALE_MAX = 3;

export const DEFAULT_GMA_MACD_PARAMS: GmaMacdParams = {
  fastLength: 12,
  fastSigma: 5,
  slowLength: 26,
  slowSigma: 9,
  signalLength: 9,
  signalSigma: 3,
};

export function isValidGmaMacdScale(length: number, sigma: number): boolean {
  return (
    length >= GMA_MACD_LENGTH_MIN &&
    sigma >= GMA_MACD_SIGMA_MIN &&
    length / sigma <= GMA_MACD_SCALE_MAX
  );
}

export function gmaMacdFastScale(params: GmaMacdParams): number {
  return params.fastLength / params.fastSigma;
}

export function gmaMacdSlowScale(params: GmaMacdParams): number {
  return params.slowLength / params.slowSigma;
}

export function isValidGmaMacdPair(params: GmaMacdParams): boolean {
  return gmaMacdFastScale(params) < gmaMacdSlowScale(params);
}

export function isValidGmaMacdConfig(params: GmaMacdParams): boolean {
  return (
    params.fastLength <= GMA_MACD_LENGTH_MAX &&
    params.slowLength <= GMA_MACD_LENGTH_MAX &&
    params.fastSigma <= GMA_MACD_SIGMA_MAX &&
    params.slowSigma <= GMA_MACD_SIGMA_MAX &&
    params.signalLength <= GMA_MACD_SIGNAL_LENGTH_MAX &&
    params.signalSigma <= GMA_MACD_SIGMA_MAX &&
    isValidGmaMacdScale(params.fastLength, params.fastSigma) &&
    isValidGmaMacdScale(params.slowLength, params.slowSigma) &&
    isValidGmaMacdScale(params.signalLength, params.signalSigma) &&
    isValidGmaMacdPair(params)
  );
}

export function clampGmaMacdParams(params: GmaMacdParams): GmaMacdParams {
  const clampLen = (value: number, max: number) =>
    Math.min(max, Math.max(GMA_MACD_LENGTH_MIN, Math.round(value) || GMA_MACD_LENGTH_MIN));
  const clampSig = (value: number) =>
    Math.min(GMA_MACD_SIGMA_MAX, Math.max(GMA_MACD_SIGMA_MIN, Math.round(value) || GMA_MACD_SIGMA_MIN));
  return {
    fastLength: clampLen(params.fastLength, GMA_MACD_LENGTH_MAX),
    fastSigma: clampSig(params.fastSigma),
    slowLength: clampLen(params.slowLength, GMA_MACD_LENGTH_MAX),
    slowSigma: clampSig(params.slowSigma),
    signalLength: clampLen(params.signalLength, GMA_MACD_SIGNAL_LENGTH_MAX),
    signalSigma: clampSig(params.signalSigma),
  };
}

const TF_SPEC_RE = /^(\d+)(t|s|m|h)$/i;
const TF_UNIT_SECONDS: Record<string, number> = { t: 0, s: 1, m: 60, h: 3600 };

/** Sentinel used by the timeframe <select> for the custom-spec path. */
export const CUSTOM_TIMEFRAME = "__custom__";

/** True for specs the backend parse_spec() accepts (1–100000t, or time ≤ 1 day). */
export function isValidTimeframeSpec(spec: string): boolean {
  const match = spec.trim().toLowerCase().match(TF_SPEC_RE);
  if (!match) return false;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value < 1) return false;
  if (unit === "t") return value <= 100_000;
  return value * TF_UNIT_SECONDS[unit] <= 86_400;
}

export function normalizeTimeframeSpec(spec: string): string {
  return spec.trim().toLowerCase();
}

export type OptimizeMetric =
  | "total_win_rate"
  | "call_win_rate"
  | "put_win_rate"
  | "total_profit_pct"
  | "call_profit_pct"
  | "put_profit_pct"
  | "max_runup_pct"
  | "avg_max_runup_pct"
  | "average_profit_pct"
  | "label_score";

export const OPTIMIZE_OPTIONS: { id: OptimizeMetric; label: string }[] = [
  { id: "total_win_rate", label: "Maximize total win rate" },
  { id: "call_win_rate", label: "Maximize long win rate" },
  { id: "put_win_rate", label: "Maximize short win rate" },
  { id: "total_profit_pct", label: "Maximize total profit %" },
  { id: "call_profit_pct", label: "Maximize long profit %" },
  { id: "put_profit_pct", label: "Maximize short profit %" },
  { id: "max_runup_pct", label: "Maximize max run-up %" },
  { id: "avg_max_runup_pct", label: "Maximize average max run-up %" },
  { id: "average_profit_pct", label: "Maximize average profit %" },
  { id: "label_score", label: "Maximize label score" },
];

export type GmaMacdOptimizeMetric = Exclude<
  OptimizeMetric,
  "label_score" | "call_win_rate" | "put_win_rate" | "call_profit_pct" | "put_profit_pct"
>;

export const GMA_MACD_OPTIMIZE_OPTIONS: { id: GmaMacdOptimizeMetric; label: string }[] = [
  { id: "total_win_rate", label: "Maximize total win rate" },
  { id: "total_profit_pct", label: "Maximize total profit %" },
  { id: "average_profit_pct", label: "Maximize average profit %" },
  { id: "max_runup_pct", label: "Maximize max run-up %" },
  { id: "avg_max_runup_pct", label: "Maximize average max run-up %" },
];

/** Metrics offered by the cross-timeframe optimizer in the header. */
export const CROSS_TF_OPTIMIZE_OPTIONS: {
  id: OptimizeMetric;
  label: string;
}[] = [
  { id: "total_win_rate", label: "Win rate" },
  { id: "total_profit_pct", label: "Total profit %" },
  { id: "average_profit_pct", label: "Avg profit %" },
  { id: "avg_max_runup_pct", label: "Avg max run-up %" },
  { id: "max_runup_pct", label: "Max run-up %" },
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

export const SEARCH_METRIC_FIELD: Partial<Record<OptimizeMetric, VizMetric>> = {
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
  macd_params?: { fast: number; slow: number; signal: number } | null;
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
  avg_max_runup_pct?: number;
  average_profit_pct?: number;
  error?: string;
  viz?: OptimizeViz | null;
  label_score?: LabelScoreBreakdown | null;
}

export interface GmaMacdOptimizeResult extends OptimizeResult {
  params: OptimizeResult["params"] & {
    signal_length: number;
    signal_sigma: number;
  };
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
