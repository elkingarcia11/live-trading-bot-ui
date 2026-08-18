import type { CatalogResponse, ChartResponse, GmaParams } from "./types";

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

export function watchUrl(symbol: string, timeframe: string): string {
  const q = new URLSearchParams({ symbol, timeframe });
  return `/api/events?${q.toString()}`;
}
