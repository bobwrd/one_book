/**
 * Company headlines, cache-first.
 *
 * Follows the market-data house style: cached in D1, stale cache beats an
 * error, and an unconfigured key returns null rather than throwing — callers
 * render "no news source configured" instead of an error state, exactly as
 * they do when `getProvider` returns null.
 *
 * Finnhub is the source because its key is already an optional part of `Env`
 * for price data; no new secret is introduced.
 */

import { sha256Hex } from "./crypto.js";
import type { Env } from "./env.js";

/** Headlines age out faster than reference rates but slower than quotes. */
const NEWS_TTL_MS = 2 * 60 * 60 * 1000;
/** How far back to ask for, and how many items to keep. */
const NEWS_WINDOW_DAYS = 7;
const NEWS_LIMIT = 20;

export interface NewsItem {
  id: string;
  headline: string;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: number;
}

interface NewsRow {
  id: string;
  headline: string;
  summary: string | null;
  source: string;
  url: string;
  published_at: number;
}

async function readCached(env: Env, ticker: string): Promise<NewsItem[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, headline, summary, source, url, published_at FROM news_cache WHERE ticker = ? ORDER BY published_at DESC LIMIT ?",
  )
    .bind(ticker, NEWS_LIMIT)
    .all<NewsRow>();

  return (results ?? []).map((r) => ({
    id: r.id,
    headline: r.headline,
    summary: r.summary,
    source: r.source,
    url: r.url,
    publishedAt: r.published_at,
  }));
}

async function cachedAge(env: Env, ticker: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(fetched_at) AS fetched_at FROM news_cache WHERE ticker = ?",
  )
    .bind(ticker)
    .first<{ fetched_at: number | null }>();
  return row?.fetched_at ?? null;
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Recent headlines for a ticker.
 *
 * Returns null when no news source is configured and nothing is cached — the
 * "not available" state, distinct from an empty `items` array, which means the
 * source was reachable and had nothing to say.
 */
export async function getNews(
  env: Env,
  ticker: string,
): Promise<{ items: NewsItem[]; stale: boolean } | null> {
  const symbol = ticker.toUpperCase();

  const fetchedAt = await cachedAge(env, symbol);
  if (fetchedAt !== null && Date.now() - fetchedAt < NEWS_TTL_MS) {
    return { items: await readCached(env, symbol), stale: false };
  }

  if (!env.FINNHUB_API_KEY) {
    // Not an error: the deployment simply has no news source wired up.
    const cached = await readCached(env, symbol);
    return cached.length > 0 ? { items: cached, stale: true } : null;
  }

  try {
    const url = new URL("https://finnhub.io/api/v1/company-news");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("from", isoDay(-NEWS_WINDOW_DAYS));
    url.searchParams.set("to", isoDay(0));
    url.searchParams.set("token", env.FINNHUB_API_KEY);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Finnhub returned ${response.status}.`);

    const data = (await response.json()) as {
      headline?: string;
      summary?: string;
      source?: string;
      url?: string;
      datetime?: number;
    }[];

    const usable = (Array.isArray(data) ? data : [])
      .filter((a) => a.headline && a.url)
      .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, NEWS_LIMIT);

    const now = Date.now();
    const items: NewsItem[] = [];
    const writes = [];
    const statement = env.DB.prepare(
      "INSERT INTO news_cache (id, ticker, headline, summary, source, url, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET headline = excluded.headline, summary = excluded.summary, source = excluded.source, published_at = excluded.published_at, fetched_at = excluded.fetched_at",
    );

    for (const article of usable) {
      // Hashing ticker+url keeps re-fetches idempotent: the same story keeps
      // the same row rather than accumulating duplicates.
      const id = await sha256Hex(`${symbol}${article.url}`);
      const item: NewsItem = {
        id,
        headline: article.headline!,
        summary: article.summary?.trim() ? article.summary : null,
        source: article.source ?? "Unknown",
        url: article.url!,
        publishedAt: (article.datetime ?? 0) * 1000,
      };
      items.push(item);
      writes.push(
        statement.bind(
          item.id,
          symbol,
          item.headline,
          item.summary,
          item.source,
          item.url,
          item.publishedAt,
          now,
        ),
      );
    }

    if (writes.length > 0) await env.DB.batch(writes);
    return { items, stale: false };
  } catch {
    const cached = await readCached(env, symbol);
    return cached.length > 0 ? { items: cached, stale: true } : null;
  }
}
