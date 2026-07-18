/**
 * Market data behind one interface.
 *
 * Free tiers change terms without notice, so no provider detail leaks past
 * `MarketDataProvider`. Everything is cached in D1 because the free rate
 * limits (Alpha Vantage allows only a handful of calls per minute) are the
 * binding constraint, not latency.
 */

import type { PriceSeries } from "@onebook/finance";
import type { Env } from "./env.js";

export interface MarketDataProvider {
  readonly name: string;
  fetchDailyCloses(
    ticker: string,
  ): Promise<{ date: string; close: number }[]>;
  fetchQuote(ticker: string): Promise<number | null>;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}

/** Historical window used for correlation and volatility. */
export const HISTORY_DAYS = 252;
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;
const QUOTE_TTL_MS = 60 * 1000;

class AlphaVantageProvider implements MarketDataProvider {
  readonly name = "alphavantage";

  constructor(private readonly apiKey: string) {}

  async fetchDailyCloses(ticker: string) {
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "TIME_SERIES_DAILY_ADJUSTED");
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("outputsize", "compact");
    url.searchParams.set("apikey", this.apiKey);

    const response = await fetch(url);
    if (!response.ok) {
      throw new MarketDataError(
        `Alpha Vantage returned ${response.status}.`,
        response.status >= 500,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Alpha Vantage signals rate limiting with HTTP 200 and a "Note" field,
    // so a status check alone is not enough.
    if (data.Note || data.Information) {
      throw new MarketDataError(
        "Alpha Vantage rate limit reached; using cached prices.",
        true,
      );
    }
    if (data["Error Message"]) {
      throw new MarketDataError(`Unknown ticker: ${ticker}.`);
    }

    const series = data["Time Series (Daily)"] as
      | Record<string, Record<string, string>>
      | undefined;
    if (!series) {
      throw new MarketDataError(`No price history returned for ${ticker}.`);
    }

    return Object.entries(series)
      .map(([date, fields]) => ({
        date,
        close: Number(fields["5. adjusted close"] ?? fields["4. close"]),
      }))
      .filter((r) => Number.isFinite(r.close))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async fetchQuote(ticker: string): Promise<number | null> {
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "GLOBAL_QUOTE");
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("apikey", this.apiKey);

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as {
      "Global Quote"?: Record<string, string>;
    };
    const price = Number(data["Global Quote"]?.["05. price"]);
    return Number.isFinite(price) && price > 0 ? price : null;
  }
}

class FinnhubProvider implements MarketDataProvider {
  readonly name = "finnhub";

  constructor(private readonly apiKey: string) {}

  async fetchDailyCloses(ticker: string) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - HISTORY_DAYS * 2 * 86_400;
    const url = new URL("https://finnhub.io/api/v1/stock/candle");
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("resolution", "D");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));
    url.searchParams.set("token", this.apiKey);

    const response = await fetch(url);
    if (!response.ok) {
      throw new MarketDataError(
        `Finnhub returned ${response.status}.`,
        response.status >= 500,
      );
    }

    const data = (await response.json()) as {
      s: string;
      t?: number[];
      c?: number[];
    };
    if (data.s !== "ok" || !data.t || !data.c) {
      throw new MarketDataError(`No price history returned for ${ticker}.`);
    }

    return data.t.map((timestamp, i) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: data.c![i],
    }));
  }

  async fetchQuote(ticker: string): Promise<number | null> {
    const url = new URL("https://finnhub.io/api/v1/quote");
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("token", this.apiKey);

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as { c?: number };
    return data.c && data.c > 0 ? data.c : null;
  }
}

export function getProvider(env: Env): MarketDataProvider | null {
  const preferred = env.MARKET_DATA_PROVIDER?.toLowerCase();

  if (preferred === "finnhub" && env.FINNHUB_API_KEY) {
    return new FinnhubProvider(env.FINNHUB_API_KEY);
  }
  if (preferred === "alphavantage" && env.ALPHA_VANTAGE_API_KEY) {
    return new AlphaVantageProvider(env.ALPHA_VANTAGE_API_KEY);
  }
  if (env.ALPHA_VANTAGE_API_KEY) {
    return new AlphaVantageProvider(env.ALPHA_VANTAGE_API_KEY);
  }
  if (env.FINNHUB_API_KEY) return new FinnhubProvider(env.FINNHUB_API_KEY);

  return null;
}

async function cachedHistoryAge(
  env: Env,
  ticker: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(fetched_at) AS fetched_at FROM price_cache WHERE ticker = ?",
  )
    .bind(ticker)
    .first<{ fetched_at: number | null }>();
  return row?.fetched_at ?? null;
}

async function readHistory(env: Env, ticker: string): Promise<PriceSeries> {
  const { results } = await env.DB.prepare(
    "SELECT date, close FROM price_cache WHERE ticker = ? ORDER BY date DESC LIMIT ?",
  )
    .bind(ticker, HISTORY_DAYS)
    .all<{ date: string; close: number }>();

  const rows = (results ?? []).slice().reverse();
  return {
    ticker,
    dates: rows.map((r) => r.date),
    closes: rows.map((r) => r.close),
  };
}

async function writeHistory(
  env: Env,
  ticker: string,
  rows: { date: string; close: number }[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  const statement = env.DB.prepare(
    "INSERT INTO price_cache (ticker, date, close, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(ticker, date) DO UPDATE SET close = excluded.close, fetched_at = excluded.fetched_at",
  );
  await env.DB.batch(
    rows.slice(-HISTORY_DAYS).map((r) =>
      statement.bind(ticker, r.date, r.close, now),
    ),
  );
}

/**
 * Daily closes for a ticker, cache-first.
 *
 * On a provider failure with usable cached data, the cache wins and the error
 * is swallowed — a stale correlation matrix beats a blank dashboard. The
 * caller gets `stale: true` so the UI can label it honestly.
 */
export async function getPriceHistory(
  env: Env,
  ticker: string,
): Promise<{ series: PriceSeries; stale: boolean }> {
  const symbol = ticker.toUpperCase();
  const fetchedAt = await cachedHistoryAge(env, symbol);
  const isFresh = fetchedAt !== null && Date.now() - fetchedAt < HISTORY_TTL_MS;

  if (isFresh) {
    return { series: await readHistory(env, symbol), stale: false };
  }

  const provider = getProvider(env);
  if (!provider) {
    const cached = await readHistory(env, symbol);
    if (cached.closes.length > 0) return { series: cached, stale: true };
    throw new MarketDataError(
      "No market-data provider is configured. Set ALPHA_VANTAGE_API_KEY or FINNHUB_API_KEY.",
    );
  }

  try {
    const rows = await provider.fetchDailyCloses(symbol);
    await writeHistory(env, symbol, rows);
    return { series: await readHistory(env, symbol), stale: false };
  } catch (err) {
    const cached = await readHistory(env, symbol);
    if (cached.closes.length > 0) return { series: cached, stale: true };
    throw err;
  }
}

/** Latest price, cache-first, falling back to the most recent close. */
export async function getQuote(
  env: Env,
  ticker: string,
): Promise<{ price: number; stale: boolean } | null> {
  const symbol = ticker.toUpperCase();

  const cached = await env.DB.prepare(
    "SELECT price, fetched_at FROM quote_cache WHERE ticker = ?",
  )
    .bind(symbol)
    .first<{ price: number; fetched_at: number }>();

  if (cached && Date.now() - cached.fetched_at < QUOTE_TTL_MS) {
    return { price: cached.price, stale: false };
  }

  const provider = getProvider(env);
  if (provider) {
    try {
      const price = await provider.fetchQuote(symbol);
      if (price !== null) {
        await env.DB.prepare(
          "INSERT INTO quote_cache (ticker, price, fetched_at) VALUES (?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, fetched_at = excluded.fetched_at",
        )
          .bind(symbol, price, Date.now())
          .run();
        return { price, stale: false };
      }
    } catch {
      // Fall through to cached or historical values.
    }
  }

  if (cached) return { price: cached.price, stale: true };

  const lastClose = await env.DB.prepare(
    "SELECT close FROM price_cache WHERE ticker = ? ORDER BY date DESC LIMIT 1",
  )
    .bind(symbol)
    .first<{ close: number }>();

  return lastClose ? { price: lastClose.close, stale: true } : null;
}

/** Batch quote fetch, tolerating individual failures. */
export async function getQuotes(
  env: Env,
  tickers: string[],
): Promise<{ spot: Record<string, number>; stale: string[]; missing: string[] }> {
  const spot: Record<string, number> = {};
  const stale: string[] = [];
  const missing: string[] = [];

  for (const ticker of [...new Set(tickers.map((t) => t.toUpperCase()))]) {
    const quote = await getQuote(env, ticker);
    if (!quote) {
      missing.push(ticker);
      continue;
    }
    spot[ticker] = quote.price;
    if (quote.stale) stale.push(ticker);
  }

  return { spot, stale, missing };
}
