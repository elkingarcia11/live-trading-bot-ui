import type {
  CatalogResponse,
  ChartResponse,
  GmaParams,
  LoadProgress,
  OptimizeMetric,
  OptimizeProgress,
  OptimizeResult,
  OptimizeViz,
  ResultSummary,
  ResultsCatalog,
} from "./types";

type DataSource = "ohlcv" | "trades" | "continuous";

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
      if (typeof body.detail === "string") {
        detail = body.detail;
      } else if (body.detail !== undefined) {
        // FastAPI returns an array of validation errors for 422 responses;
        // stringify it so the message renders (not "[object Object]").
        detail = typeof body.detail === "string"
          ? body.detail
          : JSON.stringify(body.detail);
      } else {
        detail = JSON.stringify(body);
      }
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

export function fetchTimeframes(symbol: string): Promise<string[]> {
  const q = new URLSearchParams({ symbol });
  return fetch(`/api/timeframes?${q.toString()}`)
    .then((r) => readJson<{ symbol: string; timeframes: string[] }>(r))
    .then((data) => data.timeframes);
}

type StreamEvent<T, P extends { type: "progress" } = { type: "progress" }> =
  | P
  | { type: "ping" }
  | { type: "done"; result: T }
  | { type: "error"; detail: string };

function parseSseEvent<T, P extends { type: "progress" }>(
  chunk: string,
): StreamEvent<T, P> | null {
  const dataLine = chunk
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  return JSON.parse(dataLine.replace(/^data:\s?/, "")) as StreamEvent<T, P>;
}

async function streamEvents<T, P extends { type: "progress" }>(
  url: string,
  onProgress: (progress: P) => void,
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
  onProgress: (progress: LoadProgress) => void,
  source: DataSource,
): Promise<ChartResponse> {
  const q = new URLSearchParams({
    symbol,
    timeframe,
    refresh: refresh ? "true" : "false",
    source,
  });
  return streamEvents<ChartResponse, LoadProgress>(
    `/api/chart?${q.toString()}&${query(params)}`,
    onProgress,
  );
}

export function fetchMeta(
  symbol: string,
  timeframe: string,
  source: DataSource,
) {
  const q = new URLSearchParams({ symbol, timeframe, source });
  return fetch(`/api/meta?${q.toString()}`).then((r) =>
    readJson<{ fingerprint: string; stale: boolean }>(r),
  );
}

/** Non-streaming chart load – used by the cross-timeframe optimizer to grab
 *  bars for every timeframe without attaching progress listeners. */
export function fetchChart(
  symbol: string,
  timeframe: string,
  source: DataSource,
  signal?: AbortSignal,
): Promise<ChartResponse> {
  const q = new URLSearchParams({ symbol, timeframe, source });
  return fetch(`/api/chart?${q.toString()}`, { signal }).then((r) =>
    readJson<ChartResponse>(r),
  );
}

export async function streamOptimize(
  symbol: string,
  timeframe: string,
  metric: OptimizeMetric,
  onProgress: (progress: OptimizeProgress) => void,
  source: DataSource,
) {
  const q = new URLSearchParams({ symbol, timeframe, metric, source });
  return streamEvents<OptimizeResult, OptimizeProgress>(
    `/api/optimize?${q.toString()}`,
    onProgress,
  );
}

export function watchUrl(
  symbol: string,
  timeframe: string,
  source: DataSource,
): string {
  const q = new URLSearchParams({ symbol, timeframe, source });
  return `/api/events?${q.toString()}`;
}

export function fetchResultsCatalog(): Promise<ResultsCatalog> {
  return fetch("/api/results").then((r) => readJson<ResultsCatalog>(r));
}

export function fetchResultSummary(
  symbol: string,
  metric: string,
): Promise<ResultSummary> {
  const q = new URLSearchParams({ symbol, metric });
  return fetch(`/api/results/summary?${q.toString()}`).then((r) =>
    readJson<ResultSummary>(r),
  );
}

export function fetchResultDetail(
  symbol: string,
  metric: string,
  timeframe: string,
): Promise<{ result: OptimizeResult; viz: OptimizeViz | null }> {
  const q = new URLSearchParams({ symbol, metric, timeframe });
  return fetch(`/api/results/detail?${q.toString()}`).then((r) =>
    readJson<{ result: OptimizeResult; viz: OptimizeViz | null }>(r),
  );
}
