import type { CatalogResponse, ChartResponse, GmaParams, LoadProgress, OptimizeMetric, OptimizeProgress } from "./types";

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

type StreamEvent<T, P extends { type: "progress" } = { type: "progress" }> =
  | P
  | { type: "ping" }
  | { type: "done"; result: T }
  | { type: "error"; detail: string };

function parseSseEvent<T, P extends { type: "progress" }>(chunk: string): StreamEvent<T, P> | null {
  const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  return JSON.parse(dataLine.replace(/^data:\s?/, "")) as StreamEvent<T, P>;
}

async function streamEvents<T, P extends { type: "progress" }>(
  url: string,
  onProgress: (progress: P) => void
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    return readJson<never>(response);
  }
  if (!response.body) {
    throw new Error("Stream unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const apply = (payload: StreamEvent<T, P>): T | null => {
    if (payload.type === "ping") return null;
    if (payload.type === "progress") {
      onProgress(payload);
      return null;
    }
    if (payload.type === "done") return payload.result;
    if (payload.type === "error") {
      throw new Error(payload.detail || "Stream failed");
    }
    return null;
  };

  const consume = (text: string): T | null => {
    buf += text;
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const chunk of parts) {
      const payload = parseSseEvent<T, P>(chunk);
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
        const payload = parseSseEvent<T, P>(buf);
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
  throw new Error("Stream closed before it finished");
}

export function streamChart(
  symbol: string,
  timeframe: string,
  params: GmaParams,
  refresh: boolean,
  onProgress: (progress: LoadProgress) => void
): Promise<ChartResponse> {
  const q = new URLSearchParams({
    symbol,
    timeframe,
    refresh: refresh ? "true" : "false",
  });
  return streamEvents<ChartResponse, LoadProgress>(
    `/api/chart?${q.toString()}&${query(params)}`,
    onProgress
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

export async function streamOptimize(
  symbol: string,
  timeframe: string,
  metric: OptimizeMetric,
  onProgress: (progress: OptimizeProgress) => void
) {
  const q = new URLSearchParams({ symbol, timeframe, metric });
  return streamEvents<OptimizeResult, OptimizeProgress>(`/api/optimize?${q.toString()}`, onProgress);
}

export function watchUrl(symbol: string, timeframe: string): string {
  const q = new URLSearchParams({ symbol, timeframe });
  return `/api/events?${q.toString()}`;
}
