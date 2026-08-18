import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartZone } from "./Chart";
import { fetchCatalog, fetchChart, fetchMeta, streamOptimize, watchUrl } from "./api";
import { DEFAULT_PARAMS, OPTIMIZE_OPTIONS, type Bar, type GmaParams, type OptimizeMetric, type OptimizeProgress } from "./types";

import { computeTradeStats, formatActions, formatPct, formatPoints, formatWinRateLine, isUpAction, withActions } from "./tradeStats";

const FALLBACK_AGGREGATES = ["20t", "50t", "100t", "200t", "500t", "1000t", "1m", "5m", "15m", "30m", "1h"];

function formatPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatClock(iso: string | null, zone: ChartZone): string {
  if (!iso) return "—";
  return formatChartTime(Math.floor(new Date(iso).getTime() / 1000), zone, true);
}

function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "calculating…";
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `~${m}m ${r}s left` : `~${m}m left`;
}

function optimizeStatus(progress: OptimizeProgress | null, metric: OptimizeMetric | null): string {
  if (!metric) return "Select target";
  const goal = OPTIMIZE_OPTIONS.find((item) => item.id === metric)?.label ?? "Search";
  if (!progress) return `${goal} · starting…`;
  if (progress.total <= 0) return `${goal} · ${progress.message}…`;
  const pctLeft = Math.max(0, Math.round(100 - progress.pct));
  return `${goal} · ${progress.message} (${progress.frame}/${progress.frames}) · ${Math.round(progress.pct)}% · ${pctLeft}% left · ${formatEta(progress.eta_s)}`;
}

export default function App() {
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [hasTrades, setHasTrades] = useState<Record<string, boolean>>({});
  const [aggregates, setAggregates] = useState<string[]>(FALLBACK_AGGREGATES);
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [aggregate, setAggregate] = useState("");
  const [customDraft, setCustomDraft] = useState("100t");
  const [customSpec, setCustomSpec] = useState("100t");
  const [path, setPath] = useState("");
  const [source, setSource] = useState<"ohlcv" | "trades" | "">("");
  const [chartZone, setChartZone] = useState<ChartZone>("local");
  const [params, setParams] = useState<GmaParams>(DEFAULT_PARAMS);
  const [draft, setDraft] = useState<GmaParams>(DEFAULT_PARAMS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "stale">("idle");
  const [busy, setBusy] = useState(false);
  const [optimizing, setOptimizing] = useState<OptimizeMetric | null>(null);
  const [optimizeTarget, setOptimizeTarget] = useState<OptimizeMetric | "">("");
  const [optimizeNote, setOptimizeNote] = useState<string | null>(null);
  const [optimizeProgress, setOptimizeProgress] = useState<OptimizeProgress | null>(null);
  const fingerprintRef = useRef("");
  const paramsRef = useRef(params);
  const requestRef = useRef(0);
  paramsRef.current = params;

  const symbols = useMemo(() => Object.keys(catalog).sort(), [catalog]);
  const timeframes = catalog[symbol] ?? [];
  const aggregateSpec = aggregate === "custom" ? customSpec.trim() : aggregate;
  const effectiveTf = aggregateSpec || timeframe;
  const last = bars.at(-1) ?? null;
  const labeledBars = useMemo(() => withActions(bars), [bars]);
  const tradeStats = useMemo(() => computeTradeStats(labeledBars), [labeledBars]);

  const loadCatalog = useCallback(async () => {
    const data = await fetchCatalog();
    setCatalog(data.symbols);
    setHasTrades(data.has_trades ?? {});
    setAggregates(data.aggregates?.length ? data.aggregates : FALLBACK_AGGREGATES);
    const nextSymbol =
      symbol && data.symbols[symbol] ? symbol : Object.keys(data.symbols).sort()[0] ?? "";
    const nextFrames = data.symbols[nextSymbol] ?? [];
    const keepTf = nextFrames.includes(timeframe);
    setSymbol(nextSymbol);
    if (keepTf) {
      setTimeframe(timeframe);
    } else if (!aggregate) {
      setTimeframe(nextFrames[0] ?? "");
    } else {
      setTimeframe("");
    }
  }, [symbol, timeframe]);

  const loadChart = useCallback(
    async (
      refresh: boolean,
      nextSymbol = symbol,
      nextTf = effectiveTf,
      nextParams = paramsRef.current
    ) => {
      if (!nextSymbol || !nextTf) return;
      const requestId = ++requestRef.current;
      setBusy(true);
      setError(null);
      try {
        const data = await fetchChart(nextSymbol, nextTf, nextParams, refresh);
        if (requestId !== requestRef.current) return;
        fingerprintRef.current = data.fingerprint;
        setBars(data.bars);
        setUpdated(data.updated);
        setLoadedAt(data.loaded_at);
        setPath(data.path);
        setSource(data.source);
        setStatus("live");
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("stale");
      } finally {
        if (requestId === requestRef.current) setBusy(false);
      }
    },
    [symbol, effectiveTf]
  );

  const runOptimize = useCallback(
    async (metric: OptimizeMetric) => {
      if (!symbol || optimizing) return;
      setOptimizeTarget(metric);
      setOptimizing(metric);
      setError(null);
      setOptimizeNote(null);
      setOptimizeProgress(null);
      try {
        const result = await streamOptimize(symbol, metric, setOptimizeProgress);
        const nextParams: GmaParams = {
          fastLength: result.params.fast_length,
          fastSigma: result.params.fast_sigma,
          slowLength: result.params.slow_length,
          slowSigma: result.params.slow_sigma,
        };
        setTimeframe("");
        setAggregate(result.timeframe);
        setDraft(nextParams);
        setParams(nextParams);
        const goal = OPTIMIZE_OPTIONS.find((item) => item.id === metric)?.label ?? metric;
        setOptimizeNote(
          `${goal} · ${result.timeframe} · ` +
            `total WR ${formatWinRateLine(result.win_rate, result.wins, result.closed_trades)} ${formatPct(result.profit_pct)} · ` +
            `call WR ${formatWinRateLine(result.call_win_rate, result.call_wins, result.close_calls)} ${formatPct(result.call_profit_pct)} · ` +
            `put WR ${formatWinRateLine(result.put_win_rate, result.put_wins, result.close_puts)} ${formatPct(result.put_profit_pct)}`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOptimizing(null);
        setOptimizeProgress(null);
      }
    },
    [symbol, optimizing]
  );

  useEffect(() => {
    loadCatalog().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // Catalog is loaded once; symbol/timeframe then drive chart fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setParams(draft), 180);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const timer = window.setTimeout(() => setCustomSpec(customDraft.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [customDraft]);

  const pairRef = useRef("");
  useEffect(() => {
    if (!symbol || !effectiveTf) return;
    const pair = `${symbol}|${effectiveTf}`;
    const refresh = pairRef.current !== pair;
    pairRef.current = pair;
    if (refresh) setStatus("loading");
    loadChart(refresh, symbol, effectiveTf, params).catch(() => undefined);
  }, [symbol, effectiveTf, params, loadChart]);

  useEffect(() => {
    if (!symbol || !effectiveTf) return;
    const sourceStream = new EventSource(watchUrl(symbol, effectiveTf));
    sourceStream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type: string;
          fingerprint?: string;
        };
        if (payload.type === "update" && payload.fingerprint !== fingerprintRef.current) {
          loadChart(true).catch(() => undefined);
        }
      } catch {
        /* ignore malformed events */
      }
    };
    sourceStream.onerror = () => {
      if (sourceStream.readyState === EventSource.CLOSED) {
        setStatus((prev) => (prev === "loading" ? prev : "stale"));
      }
    };
    const poll = window.setInterval(() => {
      fetchMeta(symbol, effectiveTf)
        .then((meta) => {
          if (meta.fingerprint && meta.fingerprint !== fingerprintRef.current) {
            loadChart(true).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 8000);
    return () => {
      sourceStream.close();
      window.clearInterval(poll);
    };
  }, [symbol, effectiveTf, loadChart]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">GMAXO</span>
          <span className="brand-sub">Dual Gaussian MA</span>
        </div>
        <label className="field">
          <span>Symbol</span>
          <select
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
              setOptimizeTarget("");
            }}
            disabled={!symbols.length}
          >
            {symbols.length === 0 && <option value="">No symbols</option>}
            {symbols.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Timeframe</span>
          <select
            value={timeframe}
            onChange={(e) => {
              const next = e.target.value;
              setTimeframe(next);
              if (next) setAggregate("");
            }}
            disabled={!timeframes.length}
          >
            <option value="">Select timeframe</option>
            {timeframes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <span className="or-label">or</span>
        <label className="field">
          <span>Aggregate</span>
          <select
            value={aggregate}
            onChange={(e) => {
              const next = e.target.value;
              setAggregate(next);
              if (next) setTimeframe("");
            }}
            disabled={!hasTrades[symbol]}
          >
            <option value="">Select aggregate</option>
            {aggregates.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        {aggregate === "custom" && (
          <label className="field">
            <span>Spec</span>
            <input
              type="text"
              className="spec"
              value={customDraft}
              placeholder="100t or 5m"
              onChange={(e) => setCustomDraft(e.target.value)}
            />
          </label>
        )}
        <span className="or-label">or</span>
        <label className="field">
          <span>Optimize</span>
          <select
            value={optimizing ? "" : optimizeTarget}
            disabled={!symbol || !hasTrades[symbol] || optimizing != null}
            onChange={(e) => {
              const next = e.target.value as OptimizeMetric | "";
              if (!next) {
                setOptimizeTarget("");
                return;
              }
              runOptimize(next);
            }}
          >
            <option value="">
              {optimizing
                ? optimizeProgress?.total
                  ? `${Math.round(optimizeProgress.pct)}% · ${formatEta(optimizeProgress.eta_s)}`
                  : optimizeProgress?.message ?? "Searching…"
                : "Select target"}
            </option>
            {OPTIMIZE_OPTIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="refresh"
          type="button"
          onClick={() => loadChart(true)}
          disabled={busy || !symbol || !effectiveTf}
        >
          {busy ? "Pulling…" : "Refresh GCS"}
        </button>
        <div className={`live-pill ${status}`}>
          <span className="dot" />
          {status === "live" ? "Listening" : status === "loading" ? "Loading" : status === "stale" ? "Reconnect" : "Idle"}
        </div>
      </header>

      <aside className="sidebar">
        <section>
          <h2>Fast GMA</h2>
          <p className="hint">Length {draft.fastLength} · σ {draft.fastSigma.toFixed(1)}</p>
          <label>
            Length
            <input
              type="range"
              min={2}
              max={200}
              value={draft.fastLength}
              onChange={(e) => setDraft({ ...draft, fastLength: Number(e.target.value) })}
            />
            <input
              type="number"
              min={2}
              max={500}
              value={draft.fastLength}
              onChange={(e) => setDraft({ ...draft, fastLength: Number(e.target.value) })}
            />
          </label>
          <label>
            Sigma
            <input
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={draft.fastSigma}
              onChange={(e) => setDraft({ ...draft, fastSigma: Number(e.target.value) })}
            />
            <input
              type="number"
              min={1}
              max={50}
              step={0.5}
              value={draft.fastSigma}
              onChange={(e) => setDraft({ ...draft, fastSigma: Number(e.target.value) })}
            />
          </label>
        </section>
        <section>
          <h2>Slow GMA</h2>
          <p className="hint">Length {draft.slowLength} · σ {draft.slowSigma.toFixed(1)}</p>
          <label>
            Length
            <input
              type="range"
              min={2}
              max={200}
              value={draft.slowLength}
              onChange={(e) => setDraft({ ...draft, slowLength: Number(e.target.value) })}
            />
            <input
              type="number"
              min={2}
              max={500}
              value={draft.slowLength}
              onChange={(e) => setDraft({ ...draft, slowLength: Number(e.target.value) })}
            />
          </label>
          <label>
            Sigma
            <input
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={draft.slowSigma}
              onChange={(e) => setDraft({ ...draft, slowSigma: Number(e.target.value) })}
            />
            <input
              type="number"
              min={1}
              max={50}
              step={0.5}
              value={draft.slowSigma}
              onChange={(e) => setDraft({ ...draft, slowSigma: Number(e.target.value) })}
            />
          </label>
        </section>
        <section className="legend">
          <h2>Legend</h2>
          <div><i className="swatch fast" /> Fast GMA</div>
          <div><i className="swatch slow" /> Slow GMA</div>
          <div><i className="arrow buy" /> Open call / close put</div>
          <div><i className="arrow sell" /> Open put / close call</div>
        </section>
        <section className="stats">
          <h2>Session</h2>
          {optimizing && (
            <div className="optimize-progress">
              <p className="hint">{optimizeStatus(optimizeProgress, optimizing)}</p>
              <div className="bar">
                <span style={{ width: `${Math.min(100, Math.max(2, optimizeProgress?.pct ?? 1))}%` }} />
              </div>
            </div>
          )}
          {optimizeNote && <p className="hint">{optimizeNote}</p>}
          {bars.length < Math.max(params.fastLength, params.slowLength) && (
            <p className="hint">
              GMA lines appear after {Math.max(params.fastLength, params.slowLength)} bars
              ({bars.length} loaded).
            </p>
          )}
          <dl>
            <div>
              <dt>Total profit</dt>
              <dd className={tradeStats.profit >= 0 ? "buy" : "sell"}>
                {formatPoints(tradeStats.profit)}
              </dd>
            </div>
            <div>
              <dt>Call profit</dt>
              <dd className={tradeStats.callProfit >= 0 ? "buy" : "sell"}>
                {formatPoints(tradeStats.callProfit)}
              </dd>
            </div>
            <div>
              <dt>Put profit</dt>
              <dd className={tradeStats.putProfit >= 0 ? "buy" : "sell"}>
                {formatPoints(tradeStats.putProfit)}
              </dd>
            </div>
            <div>
              <dt>Total %</dt>
              <dd className={tradeStats.profitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.profitPct)}
              </dd>
            </div>
            <div>
              <dt>Call %</dt>
              <dd className={tradeStats.callProfitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.callProfitPct)}
              </dd>
            </div>
            <div>
              <dt>Put %</dt>
              <dd className={tradeStats.putProfitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.putProfitPct)}
              </dd>
            </div>
            <div>
              <dt>Total win rate</dt>
              <dd>
                {formatWinRateLine(tradeStats.winRate, tradeStats.wins, tradeStats.closedTrades)}
              </dd>
            </div>
            <div>
              <dt>Call win rate</dt>
              <dd>
                {formatWinRateLine(tradeStats.callWinRate, tradeStats.callWins, tradeStats.closeCalls)}
              </dd>
            </div>
            <div>
              <dt>Put win rate</dt>
              <dd>
                {formatWinRateLine(tradeStats.putWinRate, tradeStats.putWins, tradeStats.closePuts)}
              </dd>
            </div>
            {tradeStats.openPosition && tradeStats.unrealized != null && tradeStats.unrealizedPct != null && (
              <div>
                <dt>Open {tradeStats.openSide === "long" ? "call" : "put"}</dt>
                <dd className={tradeStats.unrealized >= 0 ? "buy" : "sell"}>
                  {formatPoints(tradeStats.unrealized)} / {formatPct(tradeStats.unrealizedPct)}
                </dd>
              </div>
            )}
            <div><dt>Last</dt><dd>{formatPrice(last?.close)}</dd></div>
            <div><dt>Bars</dt><dd>{bars.length}</dd></div>
            <div><dt>Open calls</dt><dd className="buy">{tradeStats.openCalls}</dd></div>
            <div><dt>Close calls</dt><dd className="buy">{tradeStats.closeCalls}</dd></div>
            <div><dt>Open puts</dt><dd className="sell">{tradeStats.openPuts}</dd></div>
            <div><dt>Close puts</dt><dd className="sell">{tradeStats.closePuts}</dd></div>
            <div>
              <dt>Last action</dt>
              <dd className={tradeStats.lastActions.some(isUpAction) ? "buy" : tradeStats.lastActions.length ? "sell" : ""}>
                {formatActions(tradeStats.lastActions)}
              </dd>
            </div>
          </dl>
        </section>
        <section className="timezone">
          <h2>Timezone</h2>
          <select value={chartZone} onChange={(e) => setChartZone(e.target.value as ChartZone)}>
            {CHART_ZONES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </section>
      </aside>

      <main className="stage">
        {error && <div className="banner">{error}</div>}
        <Chart bars={labeledBars} fitKey={`${symbol}|${effectiveTf}`} timeZone={chartZone} />
      </main>

      <footer className="status">
        <span>gs://live-trading-bot/{path || `${symbol || "—"}/${effectiveTf || "—"}`}</span>
        <span>{source === "trades" ? "Aggregated from trades" : source === "ohlcv" ? "Precomputed ohlcv" : ""}</span>
        <span>Object updated {formatClock(updated, chartZone)}</span>
        <span>Cached {formatClock(loadedAt, chartZone)}</span>
        <span>
          Last bar {last ? formatChartTime(last.time, chartZone, true) : "—"} · parquet UTC
        </span>
      </footer>
    </div>
  );
}
