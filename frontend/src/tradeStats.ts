import type { Bar } from "./types";

export type PositionSide = "long" | "short";

export interface TradeStats {
  closedTrades: number;
  wins: number;
  winRate: number | null;
  profitPct: number;
  openPosition: boolean;
  openSide: PositionSide | null;
  unrealizedPct: number | null;
}

/**
 * buy → sell = call (long): win if price rises.
 * sell → buy = put (short): win if price falls.
 */
export function computeTradeStats(bars: Bar[]): TradeStats {
  const empty: TradeStats = {
    closedTrades: 0,
    wins: 0,
    winRate: null,
    profitPct: 0,
    openPosition: false,
    openSide: null,
    unrealizedPct: null,
  };
  if (bars.length === 0) return empty;

  let entry: number | null = null;
  let side: PositionSide | null = null;
  let closed = 0;
  let wins = 0;
  let profitPct = 0;

  for (const bar of bars) {
    if (bar.signal === "buy") {
      if (side === "short" && entry != null) {
        const ret = ((entry - bar.close) / entry) * 100;
        profitPct += ret;
        closed += 1;
        if (ret > 0) wins += 1;
        entry = null;
        side = null;
      }
      if (side == null) {
        entry = bar.close;
        side = "long";
      }
    } else if (bar.signal === "sell") {
      if (side === "long" && entry != null) {
        const ret = ((bar.close - entry) / entry) * 100;
        profitPct += ret;
        closed += 1;
        if (ret > 0) wins += 1;
        entry = null;
        side = null;
      }
      if (side == null) {
        entry = bar.close;
        side = "short";
      }
    }
  }

  const last = bars.at(-1)!;
  let unrealizedPct: number | null = null;
  if (entry != null && side != null) {
    unrealizedPct =
      side === "long"
        ? ((last.close - entry) / entry) * 100
        : ((entry - last.close) / entry) * 100;
  }

  return {
    closedTrades: closed,
    wins,
    winRate: closed > 0 ? (wins / closed) * 100 : null,
    profitPct,
    openPosition: side != null,
    openSide: side,
    unrealizedPct,
  };
}

export function formatPct(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatWinRate(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}
