import { MA_CLOSE_MIN, MA_SPREAD_MIN, type Action, type Bar } from "./types";

export { MA_CLOSE_MIN, MA_SPREAD_MIN };

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
  let hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const period = (parts.find((part) => part.type === "dayPeriod")?.value ?? "").toLowerCase();
  if (period.startsWith("p") && hour < 12) hour += 12;
  if (period.startsWith("a") && hour === 12) hour = 0;
  if (hour === 24) hour = 0;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + minute,
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

export const ACTION_MARKER_TEXT: Record<Action, string> = {
  open_call: "Long Open",
  close_call: "Long Close",
  open_put: "Put Open",
  close_put: "Put Close",
};

export function isUpAction(action: Action): boolean {
  return action === "open_call" || action === "close_put";
}

export function formatActions(actions: Action[] | undefined): string {
  if (!actions?.length) return "—";
  return actions.map((action) => ACTION_MARKER_TEXT[action]).join(" · ");
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
  avgMaxDrawdownPct: number;
  maxRunupPct: number;
  avgMaxRunupPct: number;
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

function esPrice(bar: Bar): number {
  return bar.close;
}

function esPnl(
  entryPrice: number,
  exitPrice: number,
  side: PositionSide,
): number {
  return side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
}

function esPct(entryPrice: number, price: number, side: PositionSide): number {
  if (entryPrice === 0) return 0;
  return (esPnl(entryPrice, price, side) / entryPrice) * 100;
}

export interface SignalConfig {
  useGma: boolean;
  useMacd: boolean;
  useEma?: boolean;
  useGmaMacd?: boolean;
  macdLine?: Array<number | null>;
  emaFast?: Array<number | null>;
  emaSlow?: Array<number | null>;
  gmaMacdHist?: Array<number | null>;
  maSpreadMin?: number;
  maCloseMin?: number;
  /** When false, GMA/EMA use fast/slow crossovers only (no close or MA-distance signals). */
  useMaThresholds?: boolean;
}

export type DualMaReason = "ma" | "close";

export interface DualMaZones {
  maLong: boolean;
  maShort: boolean;
  closeLong: boolean;
  closeShort: boolean;
}

export function dualMaZones(
  fast: number | null | undefined,
  slow: number | null | undefined,
  close: number,
  maSpreadMin = MA_SPREAD_MIN,
  maCloseMin = MA_CLOSE_MIN,
): DualMaZones {
  const haveMa = fast != null && slow != null;
  return {
    maLong: Boolean(haveMa && fast >= slow + maSpreadMin),
    maShort: Boolean(haveMa && fast <= slow - maSpreadMin),
    closeLong: Boolean(slow != null && close >= slow + maCloseMin),
    closeShort: Boolean(
      (fast != null && close <= fast - maCloseMin) ||
        (slow != null && close <= slow - maCloseMin),
    ),
  };
}

function dualMaEdge(current: boolean, previous: boolean, sessionOpen: boolean): boolean {
  return sessionOpen ? current : current && !previous;
}

function dualMaEntryReasons(
  zones: DualMaZones,
  prev: DualMaZones | null,
  sessionOpen: boolean,
  backendSignal?: Bar["signal"],
): { buy: DualMaReason[]; sell: DualMaReason[] } {
  const prevMaLong = prev?.maLong ?? false;
  const prevMaShort = prev?.maShort ?? false;
  const prevCloseLong = prev?.closeLong ?? false;
  const prevCloseShort = prev?.closeShort ?? false;
  let enterMaLong =
    backendSignal === "buy" || dualMaEdge(zones.maLong, prevMaLong, sessionOpen);
  let enterMaShort =
    backendSignal === "sell" || dualMaEdge(zones.maShort, prevMaShort, sessionOpen);
  let enterCloseLong = dualMaEdge(zones.closeLong, prevCloseLong, sessionOpen);
  let enterCloseShort = dualMaEdge(zones.closeShort, prevCloseShort, sessionOpen);
  if (enterMaLong && !zones.maLong) enterMaLong = false;
  if (enterMaShort && !zones.maShort) enterMaShort = false;
  if (enterCloseLong && !zones.closeLong) enterCloseLong = false;
  if (enterCloseShort && !zones.closeShort) enterCloseShort = false;

  const buy: DualMaReason[] = [];
  const sell: DualMaReason[] = [];
  if (enterMaLong) buy.push("ma");
  if (enterCloseLong) buy.push("close");
  if (enterMaShort) sell.push("ma");
  if (enterCloseShort) sell.push("close");
  if (buy.length && sell.length) {
    const buyClose = buy.includes("close");
    const sellClose = sell.includes("close");
    if (buyClose && !sellClose) sell.length = 0;
    else if (sellClose && !buyClose) buy.length = 0;
    else {
      buy.length = 0;
      sell.length = 0;
    }
  }
  return { buy, sell };
}

function dualMaReasonsAfterFlip(
  side: PositionSide,
  reasons: DualMaReason[],
  zones: DualMaZones,
): DualMaReason[] {
  return reasons.filter((reason) => {
    if (reason === "ma") return side === "long" ? !zones.maShort : !zones.maLong;
    return side === "long" ? !zones.closeShort : !zones.closeLong;
  });
}

function applyDualMaBar(args: {
  side: PositionSide | null;
  reasons: DualMaReason[];
  close: number;
  prevClose: number | null | undefined;
  fast: number | null | undefined;
  slow: number | null | undefined;
  prevFast: number | null | undefined;
  prevSlow: number | null | undefined;
  sessionOpen: boolean;
  backendSignal?: Bar["signal"];
  maSpreadMin?: number;
  maCloseMin?: number;
}): {
  side: PositionSide | null;
  reasons: DualMaReason[];
  closeLongPos: boolean;
  closeShortPos: boolean;
  openLong: boolean;
  openShort: boolean;
} {
  const maSpreadMin = args.maSpreadMin ?? MA_SPREAD_MIN;
  const maCloseMin = args.maCloseMin ?? MA_CLOSE_MIN;
  const zones = dualMaZones(args.fast, args.slow, args.close, maSpreadMin, maCloseMin);
  const prevZones =
    args.prevClose != null && Number.isFinite(args.prevClose)
      ? dualMaZones(args.prevFast, args.prevSlow, args.prevClose, maSpreadMin, maCloseMin)
      : null;
  let { side, reasons } = args;
  let closeLongPos = false;
  let closeShortPos = false;
  if (side != null) {
    reasons = dualMaReasonsAfterFlip(side, reasons, zones);
    if (reasons.length === 0) {
      if (side === "long") closeLongPos = true;
      else closeShortPos = true;
      side = null;
    }
  }
  let openLong = false;
  let openShort = false;
  if (side == null) {
    const entry = dualMaEntryReasons(zones, prevZones, args.sessionOpen, args.backendSignal);
    if (entry.buy.length) {
      openLong = true;
      side = "long";
      reasons = entry.buy;
    } else if (entry.sell.length) {
      openShort = true;
      side = "short";
      reasons = entry.sell;
    } else {
      reasons = [];
    }
  }
  return { side, reasons, closeLongPos, closeShortPos, openLong, openShort };
}

function applyMaCrossoverBar(args: {
  side: PositionSide | null;
  fast: number | null | undefined;
  slow: number | null | undefined;
  prevFast: number | null | undefined;
  prevSlow: number | null | undefined;
  sessionOpen: boolean;
  backendSignal?: Bar["signal"];
}): {
  side: PositionSide | null;
  closeLongPos: boolean;
  closeShortPos: boolean;
  openLong: boolean;
  openShort: boolean;
} {
  const maLong = args.fast != null && args.slow != null && args.fast > args.slow;
  const maShort = args.fast != null && args.slow != null && args.fast < args.slow;
  const prevLong =
    args.prevFast != null && args.prevSlow != null && args.prevFast > args.prevSlow;
  const prevShort =
    args.prevFast != null && args.prevSlow != null && args.prevFast < args.prevSlow;
  let buy = false;
  let sell = false;
  if (args.backendSignal === "buy") buy = true;
  else if (args.backendSignal === "sell") sell = true;
  else if (args.sessionOpen && args.side == null) {
    buy = maLong;
    sell = maShort;
  } else {
    buy = maLong && !prevLong;
    sell = maShort && !prevShort;
  }
  let { side } = args;
  let closeLongPos = false;
  let closeShortPos = false;
  let openLong = false;
  let openShort = false;
  if (buy) {
    if (side === "short") {
      closeShortPos = true;
      side = null;
    }
    if (side == null) {
      openLong = true;
      side = "long";
    }
  } else if (sell) {
    if (side === "long") {
      closeLongPos = true;
      side = null;
    }
    if (side == null) {
      openShort = true;
      side = "short";
    }
  }
  return { side, closeLongPos, closeShortPos, openLong, openShort };
}

/** Map indicator signals onto open/close call/put actions during RTH only.
 *  GMA/EMA with thresholds: long if fast is maSpreadMin+ above slow or close is maCloseMin+
 *  above slow; short if fast is maSpreadMin+ below slow or close is maCloseMin+ below fast
 *  or slow. Exit only when every reason that opened the trade flips to the opposite side.
 *  GMA/EMA without thresholds: fast/slow crossovers; exit on the opposite crossover.
 *  MACD only: MACD line crosses above/below zero.
 *  GMA MACD: histogram crosses above/below zero (hist > 0 long, hist < 0 short). */
export function withActions(bars: Bar[], config?: SignalConfig): Bar[] {
  const useGma = config?.useGma ?? false;
  const useMacd = config?.useMacd ?? false;
  const useEma = config?.useEma ?? false;
  const useGmaMacd = config?.useGmaMacd ?? false;
  const macdLine = config?.macdLine;
  const emaFast = config?.emaFast;
  const emaSlow = config?.emaSlow;
  const gmaMacdHist = config?.gmaMacdHist;
  const maSpreadMin = config?.maSpreadMin ?? MA_SPREAD_MIN;
  const maCloseMin = config?.maCloseMin ?? MA_CLOSE_MIN;
  const useMaThresholds = config?.useMaThresholds ?? true;

  if (!useGma && !useMacd && !useEma && !useGmaMacd) {
    return bars.map((bar) => ({ ...bar }));
  }

  const flags = sessionFlags(bars);
  let side: PositionSide | null = null;
  let dualReasons: DualMaReason[] = [];
  return bars.map((bar, i) => {
    const actions: Action[] = [];
    const canTrade = flags.rth[i] && !flags.close[i];
    if (canTrade) {
      const prev = i > 0 ? bars[i - 1] : null;
      const prevMacd = i > 0 && macdLine ? macdLine[i - 1] : null;
      const macd = macdLine?.[i] ?? null;

      const gmaLong =
        bar.gma_fast != null && bar.gma_slow != null && bar.gma_fast > bar.gma_slow;
      const gmaShort =
        bar.gma_fast != null && bar.gma_slow != null && bar.gma_fast < bar.gma_slow;
      const gmaLongPrev =
        prev?.gma_fast != null && prev?.gma_slow != null && prev.gma_fast > prev.gma_slow;
      const gmaShortPrev =
        prev?.gma_fast != null && prev?.gma_slow != null && prev.gma_fast < prev.gma_slow;

      const macdLong = macd != null && macd > 0;
      const macdShort = macd != null && macd < 0;
      const macdLongPrev = prevMacd != null && prevMacd > 0;
      const macdShortPrev = prevMacd != null && prevMacd < 0;

      let openLong = false;
      let openShort = false;
      let gmaBuy = false;
      let gmaSell = false;

      if (useGma && useMacd) {
        if (bar.signal === "buy") gmaBuy = true;
        else if (bar.signal === "sell") gmaSell = true;
        else if (!flags.open[i]) {
          gmaBuy = gmaLong && !gmaLongPrev;
          gmaSell = gmaShort && !gmaShortPrev;
        }
        if (flags.open[i]) {
          openLong = gmaLong && macdLong;
          openShort = gmaShort && macdShort;
        } else {
          openLong = gmaLong && macdLong && !(gmaLongPrev && macdLongPrev);
          openShort = gmaShort && macdShort && !(gmaShortPrev && macdShortPrev);
        }
        if (side === "long" && gmaSell) {
          actions.push("close_call");
          side = null;
        }
        if (side === "short" && gmaBuy) {
          actions.push("close_put");
          side = null;
        }
        if (side == null && openLong) {
          actions.push("open_call");
          side = "long";
        } else if (side == null && openShort) {
          actions.push("open_put");
          side = "short";
        }
      } else if (useGma) {
        if (useMaThresholds) {
          const gma = applyDualMaBar({
            side,
            reasons: dualReasons,
            close: bar.close,
            prevClose: prev?.close,
            fast: bar.gma_fast,
            slow: bar.gma_slow,
            prevFast: prev?.gma_fast,
            prevSlow: prev?.gma_slow,
            sessionOpen: flags.open[i],
            backendSignal: bar.signal,
            maSpreadMin,
            maCloseMin,
          });
          if (gma.closeShortPos) actions.push("close_put");
          if (gma.closeLongPos) actions.push("close_call");
          if (gma.openLong) actions.push("open_call");
          else if (gma.openShort) actions.push("open_put");
          side = gma.side;
          dualReasons = gma.reasons;
        } else {
          const gma = applyMaCrossoverBar({
            side,
            fast: bar.gma_fast,
            slow: bar.gma_slow,
            prevFast: prev?.gma_fast,
            prevSlow: prev?.gma_slow,
            sessionOpen: flags.open[i],
            backendSignal: bar.signal,
          });
          if (gma.closeShortPos) actions.push("close_put");
          if (gma.closeLongPos) actions.push("close_call");
          if (gma.openLong) actions.push("open_call");
          else if (gma.openShort) actions.push("open_put");
          side = gma.side;
          dualReasons = [];
        }
      } else if (useMacd) {
        let buy = false;
        let sell = false;
        if (flags.open[i] && side == null) {
          buy = macdLong;
          sell = macdShort;
        } else {
          buy = macdLong && !macdLongPrev;
          sell = macdShort && !macdShortPrev;
        }
        if (buy) {
          if (side === "short") {
            actions.push("close_put");
            side = null;
          }
          if (side == null) {
            actions.push("open_call");
            side = "long";
          }
        } else if (sell) {
          if (side === "long") {
            actions.push("close_call");
            side = null;
          }
          if (side == null) {
            actions.push("open_put");
            side = "short";
          }
        }
      } else if (useGmaMacd) {
        const hist = gmaMacdHist?.[i] ?? null;
        const prevHist = i > 0 && gmaMacdHist ? gmaMacdHist[i - 1] : null;
        const histLong = hist != null && hist > 0;
        const histShort = hist != null && hist < 0;
        const histLongPrev = prevHist != null && prevHist > 0;
        const histShortPrev = prevHist != null && prevHist < 0;
        let buy = false;
        let sell = false;
        if (flags.open[i] && side == null) {
          buy = histLong;
          sell = histShort;
        } else {
          buy = histLong && !histLongPrev;
          sell = histShort && !histShortPrev;
        }
        if (buy) {
          if (side === "short") {
            actions.push("close_put");
            side = null;
          }
          if (side == null) {
            actions.push("open_call");
            side = "long";
          }
        } else if (sell) {
          if (side === "long") {
            actions.push("close_call");
            side = null;
          }
          if (side == null) {
            actions.push("open_put");
            side = "short";
          }
        }
      } else if (useEma) {
        if (useMaThresholds) {
          const ema = applyDualMaBar({
            side,
            reasons: dualReasons,
            close: bar.close,
            prevClose: prev?.close,
            fast: emaFast?.[i] ?? null,
            slow: emaSlow?.[i] ?? null,
            prevFast: i > 0 && emaFast ? emaFast[i - 1] : null,
            prevSlow: i > 0 && emaSlow ? emaSlow[i - 1] : null,
            sessionOpen: flags.open[i],
            backendSignal: null,
            maSpreadMin,
            maCloseMin,
          });
          if (ema.closeShortPos) actions.push("close_put");
          if (ema.closeLongPos) actions.push("close_call");
          if (ema.openLong) actions.push("open_call");
          else if (ema.openShort) actions.push("open_put");
          side = ema.side;
          dualReasons = ema.reasons;
        } else {
          const ema = applyMaCrossoverBar({
            side,
            fast: emaFast?.[i] ?? null,
            slow: emaSlow?.[i] ?? null,
            prevFast: i > 0 && emaFast ? emaFast[i - 1] : null,
            prevSlow: i > 0 && emaSlow ? emaSlow[i - 1] : null,
            sessionOpen: flags.open[i],
          });
          if (ema.closeShortPos) actions.push("close_put");
          if (ema.closeLongPos) actions.push("close_call");
          if (ema.openLong) actions.push("open_call");
          else if (ema.openShort) actions.push("open_put");
          side = ema.side;
          dualReasons = [];
        }
      }
    }
    if (flags.close[i] && side != null) {
      actions.push(side === "long" ? "close_call" : "close_put");
      side = null;
      dualReasons = [];
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
    avgMaxDrawdownPct: 0,
    maxRunupPct: 0,
    avgMaxRunupPct: 0,
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
  let totalDrawdownPct = 0;
  let drawdownTrades = 0;
  let maxRunupPct = 0;
  let totalRunupPct = 0;
  let runupTrades = 0;
  let tradeLow: number | null = null;
  let tradeHigh: number | null = null;

  for (const bar of labeled) {
    if (bar.actions?.length) lastActions = bar.actions;
    for (const action of bar.actions ?? []) {
      if (action === "close_put" && entry != null) {
        const exitPrice = esPrice(bar);
        const pnl = esPnl(entry, exitPrice, "short");
        putProfit += pnl;
        putProfitPct += esPct(entry, exitPrice, "short");
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
          const drawdownPct = ((entry - high) / entry) * 100;
          maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);
          totalDrawdownPct += drawdownPct;
          drawdownTrades += 1;
          maxRunupPct = Math.max(maxRunupPct, ((entry - low) / entry) * 100);
          totalRunupPct += ((entry - low) / entry) * 100;
          runupTrades += 1;
        }
        entry = null;
        side = null;
        tradeLow = null;
        tradeHigh = null;
      } else if (action === "close_call" && entry != null) {
        const exitPrice = esPrice(bar);
        const pnl = esPnl(entry, exitPrice, "long");
        callProfit += pnl;
        callProfitPct += esPct(entry, exitPrice, "long");
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
          const drawdownPct = ((low - entry) / entry) * 100;
          maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);
          totalDrawdownPct += drawdownPct;
          drawdownTrades += 1;
          maxRunupPct = Math.max(maxRunupPct, ((high - entry) / entry) * 100);
          totalRunupPct += ((high - entry) / entry) * 100;
          runupTrades += 1;
        }
        entry = null;
        side = null;
        tradeLow = null;
        tradeHigh = null;
      } else if (action === "open_call") {
        const entryPrice = esPrice(bar);
        entry = entryPrice;
        side = "long";
        tradeLow = entryPrice;
        tradeHigh = entryPrice;
        openCalls += 1;
      } else if (action === "open_put") {
        const entryPrice = esPrice(bar);
        entry = entryPrice;
        side = "short";
        tradeLow = entryPrice;
        tradeHigh = entryPrice;
        openPuts += 1;
      }
    }

    if (entry != null && side != null) {
      const currentPrice = esPrice(bar);
      if (currentPrice != null) {
        tradeLow =
          tradeLow == null ? currentPrice : Math.min(tradeLow, currentPrice);
        tradeHigh =
          tradeHigh == null ? currentPrice : Math.max(tradeHigh, currentPrice);
      }
    }
  }

  const last = labeled.at(-1)!;
  let unrealized: number | null = null;
  let unrealizedPct: number | null = null;
  if (entry != null && side != null) {
    const currentPrice = esPrice(last);
    unrealized = esPnl(entry, currentPrice, side);
    unrealizedPct = esPct(entry, currentPrice, side);
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
    avgMaxDrawdownPct:
      drawdownTrades > 0 ? totalDrawdownPct / drawdownTrades : 0,
    maxRunupPct,
    avgMaxRunupPct: runupTrades > 0 ? totalRunupPct / runupTrades : 0,
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
