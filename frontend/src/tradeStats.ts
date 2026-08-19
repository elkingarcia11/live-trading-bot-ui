import type { Action, Bar } from "./types";

export type PositionSide = "long" | "short";

const ET_TZ = "America/New_York";
const RTH_START_MIN = 9 * 60 + 30;
const RTH_END_MIN = 16 * 60;
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

function etClock(unix: number): { date: string; minutes: number } {
  const parts = ET_FMT.formatToParts(new Date(unix * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function sessionFlags(bars: Bar[]): {
  rth: boolean[];
  open: boolean[];
  close: boolean[];
} {
  const clocks = bars.map((bar) => etClock(bar.time));
  const rth = clocks.map(
    (clock) => clock.minutes >= RTH_START_MIN && clock.minutes < RTH_END_MIN,
  );
  const open = rth.map(
    (inRth, i) =>
      inRth &&
      (i === 0 || !rth[i - 1] || clocks[i].date !== clocks[i - 1].date),
  );
  const close = rth.map((inRth, i) => {
    if (!inRth || i === bars.length - 1) return false;
    return !rth[i + 1] || clocks[i].date !== clocks[i + 1].date;
  });
  return { rth, open, close };
}

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
  maxDrawdownPct: number;
  maxRunupPct: number;
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

function optionPrice(bar: Bar, side: PositionSide): number | null {
  return side === "long" ? bar.call_mark_price : bar.put_mark_price;
}

function optionPnl(entryPrice: number, exitPrice: number): number {
  return exitPrice - entryPrice;
}

function optionPct(entryPrice: number, price: number): number {
  if (entryPrice === 0) return 0;
  return (optionPnl(entryPrice, price) / entryPrice) * 100;
}

/** Map GMA buy/sell crosses onto open/close call/put actions during RTH only. */
export function withActions(bars: Bar[]): Bar[] {
  const flags = sessionFlags(bars);
  let side: PositionSide | null = null;
  return bars.map((bar, i) => {
    const actions: Action[] = [];
    const canTrade = flags.rth[i] && !flags.close[i];
    if (canTrade) {
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
      } else if (
        flags.open[i] &&
        side == null &&
        bar.gma_fast != null &&
        bar.gma_slow != null
      ) {
        if (bar.gma_fast > bar.gma_slow) {
          actions.push("open_call");
          side = "long";
        } else if (bar.gma_fast < bar.gma_slow) {
          actions.push("open_put");
          side = "short";
        }
      }
    }
    if (flags.close[i] && side != null) {
      actions.push(side === "long" ? "close_call" : "close_put");
      side = null;
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
    maxDrawdownPct: 0,
    maxRunupPct: 0,
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
  let maxDrawdownPct = 0;
  let maxRunupPct = 0;
  let tradeLow: number | null = null;
  let tradeHigh: number | null = null;

  for (const bar of labeled) {
    if (bar.actions?.length) lastActions = bar.actions;
    for (const action of bar.actions ?? []) {
      if (action === "close_put" && entry != null) {
        const exitPrice = optionPrice(bar, "short");
        if (exitPrice == null) continue;
        const pnl = optionPnl(entry, exitPrice);
        putProfit += pnl;
        putProfitPct += optionPct(entry, exitPrice);
        closed += 1;
        closePuts += 1;
        if (pnl > 0) {
          wins += 1;
          putWins += 1;
        }
        if (entry !== 0) {
          const low =
            tradeLow == null ? exitPrice : Math.min(tradeLow, exitPrice);
          const high =
            tradeHigh == null ? exitPrice : Math.max(tradeHigh, exitPrice);
          maxDrawdownPct = Math.min(
            maxDrawdownPct,
            ((low - entry) / entry) * 100,
          );
          maxRunupPct = Math.max(maxRunupPct, ((high - entry) / entry) * 100);
        }
        entry = null;
        side = null;
        tradeLow = null;
        tradeHigh = null;
      } else if (action === "close_call" && entry != null) {
        const exitPrice = optionPrice(bar, "long");
        if (exitPrice == null) continue;
        const pnl = optionPnl(entry, exitPrice);
        callProfit += pnl;
        callProfitPct += optionPct(entry, exitPrice);
        closed += 1;
        closeCalls += 1;
        if (pnl > 0) {
          wins += 1;
          callWins += 1;
        }
        if (entry !== 0) {
          const low =
            tradeLow == null ? exitPrice : Math.min(tradeLow, exitPrice);
          const high =
            tradeHigh == null ? exitPrice : Math.max(tradeHigh, exitPrice);
          maxDrawdownPct = Math.min(
            maxDrawdownPct,
            ((low - entry) / entry) * 100,
          );
          maxRunupPct = Math.max(maxRunupPct, ((high - entry) / entry) * 100);
        }
        entry = null;
        side = null;
        tradeLow = null;
        tradeHigh = null;
      } else if (action === "open_call") {
        const entryPrice = optionPrice(bar, "long");
        if (entryPrice != null) {
          entry = entryPrice;
          side = "long";
          tradeLow = entryPrice;
          tradeHigh = entryPrice;
          openCalls += 1;
        }
      } else if (action === "open_put") {
        const entryPrice = optionPrice(bar, "short");
        if (entryPrice != null) {
          entry = entryPrice;
          side = "short";
          tradeLow = entryPrice;
          tradeHigh = entryPrice;
          openPuts += 1;
        }
      }
    }

    if (entry != null && side != null) {
      const markPrice = optionPrice(bar, side);
      if (markPrice != null) {
        tradeLow = tradeLow == null ? markPrice : Math.min(tradeLow, markPrice);
        tradeHigh =
          tradeHigh == null ? markPrice : Math.max(tradeHigh, markPrice);
      }
    }
  }

  const last = labeled.at(-1)!;
  let unrealized: number | null = null;
  let unrealizedPct: number | null = null;
  if (entry != null && side != null) {
    const markPrice = optionPrice(last, side);
    if (markPrice != null) {
      unrealized = optionPnl(entry, markPrice);
      unrealizedPct = optionPct(entry, markPrice);
    }
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
    maxDrawdownPct,
    maxRunupPct,
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
  closed: number,
): string {
  if (closed <= 0) return "—";
  return `${formatWinRate(value)} (${wins}/${closed})`;
}
