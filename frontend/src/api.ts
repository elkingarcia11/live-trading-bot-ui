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

type StreamEvent<T> =
  | { type: "progress" }
  | { type: "done"; result: T }
  | { type: "error"; detail: string };

function parseSseEvent<T>(chunk: string): StreamEvent<T> | null {
  const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  return JSON.parse(dataLine.replace(/^data:\s?/, "")) as StreamEvent<T>;
}

async function streamEvents<T>(
  url: string,
  onProgress: (progress: { type: "progress" } & Record<string, unknown>) => void
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

  const apply = (payload: StreamEvent<T>): T | null => {
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
      const payload = parseSseEvent<T>(chunk);
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
        const payload = parseSseEvent<T>(buf);
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
  throw new Error("Stream ended early");
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
  return streamEvents<ChartResponse>(
    `/api/chart?${q.toString()}&${query(params)}`,
    (progress) => onProgress(progress as LoadProgress)
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
  return streamEvents<OptimizeResult>(`/api/optimize?${q.toString()}`, (progress) =>
    onProgress(progress as OptimizeProgress)
  );
}

export function watchUrl(symbol: string, timeframe: string): string {
  const q = new URLSearchParams({ symbol, timeframe });
  return `/api/events?${q.toString()}`;
}
