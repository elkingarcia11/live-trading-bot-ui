import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { CHART_ZONES, formatChartTime, type ChartZone } from "./Chart";
import { fetchCatalog, fetchChart, fetchMeta, watchUrl } from "./api";
import { DEFAULT_PARAMS, type Bar, type GmaParams } from "./types";

import { computeTradeStats, formatPct, formatWinRate } from "./tradeStats";

const FALLBACK_AGGREGATES = ["50t", "100t", "200t", "500t", "1000t", "1m", "5m", "15m", "30m", "1h"];

function formatPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatClock(iso: string | null, zone: ChartZone): string {
  if (!iso) return "—";
  return formatChartTime(Math.floor(new Date(iso).getTime() / 1000), zone, true);
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
  const fingerprintRef = useRef("");
  const paramsRef = useRef(params);
  const requestRef = useRef(0);
  paramsRef.current = params;

  const symbols = useMemo(() => Object.keys(catalog).sort(), [catalog]);
  const timeframes = catalog[symbol] ?? [];
  const aggregateSpec = aggregate === "custom" ? customSpec.trim() : aggregate;
  const effectiveTf = aggregateSpec || timeframe;
  const last = bars.at(-1) ?? null;
  const buys = bars.filter((bar) => bar.signal === "buy").length;
  const sells = bars.filter((bar) => bar.signal === "sell").length;
  const lastSignal = [...bars].reverse().find((bar) => bar.signal) ?? null;
  const tradeStats = useMemo(() => computeTradeStats(bars), [bars]);

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
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={!symbols.length}>
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
          <div><i className="swatch buy" /> Call: buy → sell (up = win)</div>
          <div><i className="swatch sell" /> Put: sell → buy (down = win)</div>
        </section>
        <section className="stats">
          <h2>Session</h2>
          {bars.length < Math.max(params.fastLength, params.slowLength) && (
            <p className="hint">
              GMA lines appear after {Math.max(params.fastLength, params.slowLength)} bars
              ({bars.length} loaded).
            </p>
          )}
          <dl>
            <div><dt>Last</dt><dd>{formatPrice(last?.close)}</dd></div>
            <div><dt>Bars</dt><dd>{bars.length}</dd></div>
            <div><dt>Buys</dt><dd className="buy">{buys}</dd></div>
            <div><dt>Sells</dt><dd className="sell">{sells}</dd></div>
            <div>
              <dt>Win rate</dt>
              <dd>{formatWinRate(tradeStats.winRate)}</dd>
            </div>
            <div>
              <dt>Profit</dt>
              <dd className={tradeStats.profitPct >= 0 ? "buy" : "sell"}>
                {formatPct(tradeStats.profitPct)}
              </dd>
            </div>
            {tradeStats.openPosition && tradeStats.unrealizedPct != null && (
              <div>
                <dt>Open {tradeStats.openSide === "long" ? "call" : "put"} P&amp;L</dt>
                <dd className={tradeStats.unrealizedPct >= 0 ? "buy" : "sell"}>
                  {formatPct(tradeStats.unrealizedPct)}
                </dd>
              </div>
            )}
            <div>
              <dt>Last signal</dt>
              <dd className={lastSignal?.signal ?? ""}>
                {lastSignal?.signal ? lastSignal.signal.toUpperCase() : "—"}
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
        <Chart bars={bars} fitKey={`${symbol}|${effectiveTf}`} timeZone={chartZone} />
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
