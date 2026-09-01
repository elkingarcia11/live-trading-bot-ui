import type { Bar, GmaParams } from "./types";
import {
  formatActions,
  formatPct,
  formatPoints,
  formatWinRateLine,
  isUpAction,
  type TradeStats,
} from "./tradeStats";

function formatPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface SessionStatsProps {
  stats: TradeStats;
  last: Bar | null;
  bars: Bar[];
  warmupBars?: number;
}

export default function SessionStats({
  stats,
  last,
  bars,
  warmupBars,
}: SessionStatsProps) {
  return (
    <section className="stats">
      <h2>Session</h2>
      {warmupBars != null && bars.length < warmupBars && (
        <p className="hint">
          Indicator lines appear after {warmupBars} bars ({bars.length} loaded).
        </p>
      )}
      <dl>
        <div>
          <dt>Last</dt>
          <dd>{formatPrice(last?.close)}</dd>
        </div>
        <div>
          <dt>Bars</dt>
          <dd>{bars.length}</dd>
        </div>
        <div>
          <dt>Last action</dt>
          <dd
            className={
              stats.lastActions.some(isUpAction)
                ? "buy"
                : stats.lastActions.length
                  ? "sell"
                  : ""
            }
          >
            {formatActions(stats.lastActions)}
          </dd>
        </div>
        <div className="group-start">
          <dt>Total %</dt>
          <dd className={stats.profitPct >= 0 ? "buy" : "sell"}>
            {formatPct(stats.profitPct)}
          </dd>
        </div>
        <div>
          <dt>Total win rate</dt>
          <dd>
            {formatWinRateLine(stats.winRate, stats.wins, stats.closedTrades)}
          </dd>
        </div>
        <div>
          <dt>Max drawdown %</dt>
          <dd className={stats.maxDrawdownPct < 0 ? "sell" : ""}>
            {formatPct(stats.maxDrawdownPct)}
          </dd>
        </div>
        <div>
          <dt>Avg max drawdown %</dt>
          <dd className={stats.avgMaxDrawdownPct < 0 ? "sell" : ""}>
            {formatPct(stats.avgMaxDrawdownPct)}
          </dd>
        </div>
        <div>
          <dt>Max runup %</dt>
          <dd className={stats.maxRunupPct > 0 ? "buy" : ""}>
            {formatPct(stats.maxRunupPct)}
          </dd>
        </div>
        <div>
          <dt>Avg max runup %</dt>
          <dd className={stats.avgMaxRunupPct > 0 ? "buy" : ""}>
            {formatPct(stats.avgMaxRunupPct)}
          </dd>
        </div>
        <div className="group-start">
          <dt>Long %</dt>
          <dd className={stats.callProfitPct >= 0 ? "buy" : "sell"}>
            {formatPct(stats.callProfitPct)}
          </dd>
        </div>
        <div>
          <dt>Long win rate</dt>
          <dd>
            {formatWinRateLine(stats.callWinRate, stats.callWins, stats.closeCalls)}
          </dd>
        </div>
        <div>
          <dt>Open longs</dt>
          <dd className="buy">{stats.openCalls}</dd>
        </div>
        <div>
          <dt>Close longs</dt>
          <dd className="buy">{stats.closeCalls}</dd>
        </div>
        <div className="group-start">
          <dt>Short %</dt>
          <dd className={stats.putProfitPct >= 0 ? "buy" : "sell"}>
            {formatPct(stats.putProfitPct)}
          </dd>
        </div>
        <div>
          <dt>Short win rate</dt>
          <dd>
            {formatWinRateLine(stats.putWinRate, stats.putWins, stats.closePuts)}
          </dd>
        </div>
        <div>
          <dt>Open shorts</dt>
          <dd className="sell">{stats.openPuts}</dd>
        </div>
        <div>
          <dt>Close shorts</dt>
          <dd className="sell">{stats.closePuts}</dd>
        </div>
        {stats.openPosition &&
          stats.unrealized != null &&
          stats.unrealizedPct != null && (
            <div className="group-start">
              <dt>Open {stats.openSide === "long" ? "long" : "short"}</dt>
              <dd className={stats.unrealized >= 0 ? "buy" : "sell"}>
                {formatPoints(stats.unrealized)} / {formatPct(stats.unrealizedPct)}
              </dd>
            </div>
          )}
      </dl>
    </section>
  );
}

export function gmaWarmupBars(params: GmaParams): number {
  return Math.max(params.fastLength, params.slowLength);
}
