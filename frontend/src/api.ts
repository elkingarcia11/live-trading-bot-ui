import type { CatalogResponse, ChartResponse, GmaParams, OptimizeMetric, OptimizeProgress } from "./types";

function query(params: GmaParams): string {
  const q = new URLSearchParams({
    fast_length: String(params.fastLength),
    fast_sigma: String(params.fastSigma),
    slow_length: String(params.slowLength),
    slow_sigma: String(params.slowSigma),
  });
  return q.toString();
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      detail = await response.text();
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchCatalog(): Promise<CatalogResponse> {
  return fetch("/api/catalog").then((r) => readJson<CatalogResponse>(r));
}

export function fetchChart(
  symbol: string,
  timeframe: string,
  params: GmaParams,
  refresh = false
): Promise<ChartResponse> {
  const q = new URLSearchParams({
    symbol,
    timeframe,
    refresh: refresh ? "true" : "false",
  });
  return fetch(`/api/chart?${q.toString()}&${query(params)}`).then((r) =>
    readJson<ChartResponse>(r)
  );
}

export function fetchMeta(symbol: string, timeframe: string) {
  const q = new URLSearchParams({ symbol, timeframe });
  return fetch(`/api/meta?${q.toString()}`).then((r) =>
    readJson<{ fingerprint: string; stale: boolean }>(r)
  );
}

type OptimizeResult = {
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
};

type OptimizeStreamEvent =
  | OptimizeProgress
  | { type: "done"; result: OptimizeResult }
  | { type: "error"; detail: string };

function parseOptimizeEvent(chunk: string): OptimizeStreamEvent | null {
  const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  return JSON.parse(dataLine.replace(/^data:\s?/, "")) as OptimizeStreamEvent;
}

export async function streamOptimize(
  symbol: string,
  metric: OptimizeMetric,
  onProgress: (progress: OptimizeProgress) => void
) {
  const q = new URLSearchParams({ symbol, metric });
  const response = await fetch(`/api/optimize?${q.toString()}`, {
    cache: "no-store",
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    return readJson<never>(response);
  }
  if (!response.body) {
    throw new Error("Optimize stream unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const apply = (payload: OptimizeStreamEvent): OptimizeResult | null => {
    if (payload.type === "progress") {
      onProgress(payload);
      return null;
    }
    if (payload.type === "done") return payload.result;
    if (payload.type === "error") {
      throw new Error(payload.detail || "Optimize failed");
    }
    return null;
  };

  const consume = (text: string): OptimizeResult | null => {
    buf += text;
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const chunk of parts) {
      const payload = parseOptimizeEvent(chunk);
      if (!payload) continue;
      const result = apply(payload);
      if (result) return result;
    }
    return null;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      const flushed = consume(decoder.decode());
      if (flushed) return flushed;
      if (buf.trim()) {
        const payload = parseOptimizeEvent(buf);
        if (payload) {
          const result = apply(payload);
          if (result) return result;
        }
      }
      break;
    }
    const result = consume(decoder.decode(value, { stream: true }));
    if (result) return result;
  }
  throw new Error("Optimize stream ended early");
}

export function watchUrl(symbol: string, timeframe: string): string {
  const q = new URLSearchParams({ symbol, timeframe });
  return `/api/events?${q.toString()}`;
}
