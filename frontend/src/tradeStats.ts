import type { Action, Bar } from "./types";

export type PositionSide = "long" | "short";

export const ACTION_LABEL: Record<Action, string> = {
  open_call: "▲",
  close_call: "▼",
  open_put: "▼",
  close_put: "▲",
};

export function isUpAction(action: Action): boolean {
  return action === "open_call" || action === "close_put";
}

export function formatActions(actions: Action[] | undefined): string {
  if (!actions?.length) return "—";
  const marks = [...new Set(actions.map((action) => ACTION_LABEL[action]))];
  return marks.join(" ");
}

export interface TradeStats {
  closedTrades: number;
  wins: number;
  winRate: number | null;
  callWins: number;
  callWinRate: number | null;
  putWins: number;
  putWinRate: number | null;
  profit: number;
  callProfit: number;
  putProfit: number;
  profitPct: number;
  callProfitPct: number;
  putProfitPct: number;
  openCalls: number;
  closeCalls: number;
  openPuts: number;
  closePuts: number;
  openPosition: boolean;
  openSide: PositionSide | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  lastActions: Action[];
}

/** Call: buy is cost, sell is revenue. Profit = sell − buy. */
function callPnl(buyPrice: number, sellPrice: number): number {
  return sellPrice - buyPrice;
}

/**
 * Put: sell first (cost/notional), buy to cover.
 * Profit = (buy − sell) × −1, so price down is a win.
 */
function putPnl(sellPrice: number, buyPrice: number): number {
  return (buyPrice - sellPrice) * -1;
}

function callPct(buyPrice: number, sellPrice: number): number {
  if (buyPrice === 0) return 0;
  return (callPnl(buyPrice, sellPrice) / buyPrice) * 100;
}

function putPct(sellPrice: number, buyPrice: number): number {
  if (sellPrice === 0) return 0;
  return (putPnl(sellPrice, buyPrice) / sellPrice) * 100;
}

/** Map GMA buy/sell crosses onto open/close call/put actions. */
export function withActions(bars: Bar[]): Bar[] {
  let side: PositionSide | null = null;
  return bars.map((bar) => {
    const actions: Action[] = [];
    if (bar.signal === "buy") {
      if (side === "short") {
        actions.push("close_put");
        side = null;
      }
      if (side == null) {
        actions.push("open_call");
        side = "long";
      }
    } else if (bar.signal === "sell") {
      if (side === "long") {
        actions.push("close_call");
        side = null;
      }
      if (side == null) {
        actions.push("open_put");
        side = "short";
      }
    }
    return { ...bar, actions };
  });
}

export function computeTradeStats(bars: Bar[]): TradeStats {
  const empty: TradeStats = {
    closedTrades: 0,
    wins: 0,
    winRate: null,
    callWins: 0,
    callWinRate: null,
    putWins: 0,
    putWinRate: null,
    profit: 0,
    callProfit: 0,
    putProfit: 0,
    profitPct: 0,
    callProfitPct: 0,
    putProfitPct: 0,
    openCalls: 0,
    closeCalls: 0,
    openPuts: 0,
    closePuts: 0,
    openPosition: false,
    openSide: null,
    unrealized: null,
    unrealizedPct: null,
    lastActions: [],
  };
  const labeled = bars.some((bar) => bar.actions) ? bars : withActions(bars);
  if (labeled.length === 0) return empty;

  let entry: number | null = null;
  let side: PositionSide | null = null;
  let closed = 0;
  let wins = 0;
  let callWins = 0;
  let putWins = 0;
  let callProfit = 0;
  let putProfit = 0;
  let callProfitPct = 0;
  let putProfitPct = 0;
  let openCalls = 0;
  let closeCalls = 0;
  let openPuts = 0;
  let closePuts = 0;
  let lastActions: Action[] = [];

  for (const bar of labeled) {
    if (bar.actions?.length) lastActions = bar.actions;
    for (const action of bar.actions ?? []) {
      if (action === "close_put" && entry != null) {
        const pnl = putPnl(entry, bar.close);
        putProfit += pnl;
        putProfitPct += putPct(entry, bar.close);
        closed += 1;
        closePuts += 1;
        if (pnl > 0) {
          wins += 1;
          putWins += 1;
        }
        entry = null;
        side = null;
      } else if (action === "close_call" && entry != null) {
        const pnl = callPnl(entry, bar.close);
        callProfit += pnl;
        callProfitPct += callPct(entry, bar.close);
        closed += 1;
        closeCalls += 1;
        if (pnl > 0) {
          wins += 1;
          callWins += 1;
        }
        entry = null;
        side = null;
      } else if (action === "open_call") {
        entry = bar.close;
        side = "long";
        openCalls += 1;
      } else if (action === "open_put") {
        entry = bar.close;
        side = "short";
        openPuts += 1;
      }
    }
  }

  const last = labeled.at(-1)!;
  let unrealized: number | null = null;
  let unrealizedPct: number | null = null;
  if (entry != null && side != null) {
    unrealized = side === "long" ? callPnl(entry, last.close) : putPnl(entry, last.close);
    unrealizedPct = side === "long" ? callPct(entry, last.close) : putPct(entry, last.close);
  }

  const profit = callProfit + putProfit;
  const profitPct = callProfitPct + putProfitPct;
  return {
    closedTrades: closed,
    wins,
    winRate: closed > 0 ? (wins / closed) * 100 : null,
    callWins,
    callWinRate: closeCalls > 0 ? (callWins / closeCalls) * 100 : null,
    putWins,
    putWinRate: closePuts > 0 ? (putWins / closePuts) * 100 : null,
    profit,
    callProfit,
    putProfit,
    profitPct,
    callProfitPct,
    putProfitPct,
    openCalls,
    closeCalls,
    openPuts,
    closePuts,
    openPosition: side != null,
    openSide: side,
    unrealized,
    unrealizedPct,
    lastActions,
  };
}

export function formatPct(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatPoints(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

export function formatWinRate(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

export function formatWinRateLine(
  value: number | null,
  wins: number,
  closed: number
): string {
  if (closed <= 0) return "—";
  return `${formatWinRate(value)} (${wins}/${closed})`;
}
