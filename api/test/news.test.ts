/**
 * News caching and degradation, against recorded payload shapes rather than
 * the live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getNews } from "../src/news.js";
import type { Env } from "../src/env.js";

interface CachedArticle {
  id: string;
  ticker: string;
  headline: string;
  summary: string | null;
  source: string;
  url: string;
  published_at: number;
  fetched_at: number;
}

/**
 * Minimal D1 stand-in covering the three statements `getNews` issues: a
 * MAX(fetched_at) freshness probe, a per-ticker read, and a batched upsert.
 */
function fakeDb(seed: CachedArticle[] = []) {
  let rows = [...seed];

  const db = {
    get rows() {
      return rows;
    },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        sql,
        get bound() {
          return bound;
        },
        bind(...args: unknown[]) {
          // Each bind produces an independent statement so a batch of upserts
          // does not share one mutable set of parameters.
          const next = { ...statement, bind: statement.bind };
          Object.defineProperty(next, "bound", { get: () => args });
          if (sql.startsWith("SELECT")) {
            bound = args;
            return statement;
          }
          return next as typeof statement;
        },
        async first<T>(): Promise<T | null> {
          const ticker = String(bound[0]);
          const matching = rows.filter((r) => r.ticker === ticker);
          if (sql.includes("MAX(fetched_at)")) {
            return {
              fetched_at: matching.length
                ? Math.max(...matching.map((r) => r.fetched_at))
                : null,
            } as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const ticker = String(bound[0]);
          const limit = Number(bound[1] ?? 100);
          return {
            results: rows
              .filter((r) => r.ticker === ticker)
              .sort((a, b) => b.published_at - a.published_at)
              .slice(0, limit) as T[],
          };
        },
      };
      return statement;
    },
    async batch(statements: { bound: unknown[] }[]) {
      for (const s of statements) {
        const [id, ticker, headline, summary, source, url, publishedAt, fetchedAt] =
          s.bound as [string, string, string, string | null, string, string, number, number];
        rows = rows.filter((r) => r.id !== id);
        rows.push({
          id,
          ticker,
          headline,
          summary,
          source,
          url,
          published_at: publishedAt,
          fetched_at: fetchedAt,
        });
      }
      return [];
    },
  };

  return db;
}

function env(db: ReturnType<typeof fakeDb>, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    KV: {} as KVNamespace,
    TOKEN_ENCRYPTION_KEY: "k",
    STATE_SIGNING_SECRET: "s",
    APP_ORIGIN: "http://localhost:5173",
    API_ORIGIN: "http://localhost:8787",
    ...overrides,
  } as Env;
}

function mockFetch(handler: (url: URL, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init)),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const ARTICLE = {
  headline: "Apple announces results",
  summary: "Revenue beat expectations.",
  source: "Reuters",
  url: "https://example.com/a",
  datetime: 1_760_000_000,
};

function cached(overrides: Partial<CachedArticle> = {}): CachedArticle {
  return {
    id: "cached-1",
    ticker: "AAPL",
    headline: "Older story",
    summary: null,
    source: "AP",
    url: "https://example.com/old",
    published_at: 1_750_000_000_000,
    fetched_at: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getNews", () => {
  it("returns null when no key is set and nothing is cached", async () => {
    // Distinct from an empty item list: the source was never reachable.
    expect(await getNews(env(fakeDb()), "AAPL")).toBeNull();
  });

  it("serves stale cache when no key is set", async () => {
    const db = fakeDb([
      cached({ fetched_at: Date.now() - 5 * 60 * 60 * 1000 }),
    ]);

    const result = await getNews(env(db), "AAPL");
    expect(result?.stale).toBe(true);
    expect(result?.items).toHaveLength(1);
  });

  it("fetches and caches when configured", async () => {
    const db = fakeDb();
    mockFetch((url) => {
      expect(url.hostname).toBe("finnhub.io");
      expect(url.searchParams.get("symbol")).toBe("AAPL");
      expect(url.searchParams.get("token")).toBe("fh");
      return json([ARTICLE]);
    });

    const result = await getNews(env(db, { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.stale).toBe(false);
    expect(result?.items[0].headline).toBe("Apple announces results");
    // Finnhub reports seconds; the item carries milliseconds.
    expect(result?.items[0].publishedAt).toBe(1_760_000_000_000);
    expect(db.rows).toHaveLength(1);
  });

  it("uppercases the ticker", async () => {
    mockFetch((url) => {
      expect(url.searchParams.get("symbol")).toBe("AAPL");
      return json([ARTICLE]);
    });

    await getNews(env(fakeDb(), { FINNHUB_API_KEY: "fh" }), "aapl");
  });

  it("gives the same story the same id across refetches", async () => {
    const db = fakeDb();
    mockFetch(() => json([ARTICLE]));
    const e = env(db, { FINNHUB_API_KEY: "fh" });

    const first = await getNews(e, "AAPL");
    // Age the cache out so the second call refetches rather than serving cache.
    db.rows.forEach((r) => (r.fetched_at = Date.now() - 3 * 60 * 60 * 1000));
    const second = await getNews(e, "AAPL");

    expect(second?.items[0].id).toBe(first?.items[0].id);
    expect(db.rows).toHaveLength(1);
  });

  it("serves a fresh cache without fetching", async () => {
    const db = fakeDb([cached()]);
    mockFetch(() => {
      throw new Error("should not fetch");
    });

    const result = await getNews(env(db, { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.stale).toBe(false);
    expect(result?.items[0].headline).toBe("Older story");
  });

  it("refetches once the 2h TTL has passed", async () => {
    const db = fakeDb([cached({ fetched_at: Date.now() - 3 * 60 * 60 * 1000 })]);
    mockFetch(() => json([ARTICLE]));

    const result = await getNews(env(db, { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.items.map((i) => i.headline)).toContain(
      "Apple announces results",
    );
  });

  it("falls back to stale cache when the fetch fails", async () => {
    const db = fakeDb([cached({ fetched_at: Date.now() - 3 * 60 * 60 * 1000 })]);
    mockFetch(() => json({ error: "down" }, 500));

    const result = await getNews(env(db, { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.stale).toBe(true);
    expect(result?.items[0].headline).toBe("Older story");
  });

  it("returns null when the fetch fails with nothing cached", async () => {
    mockFetch(() => json({ error: "down" }, 500));

    expect(
      await getNews(env(fakeDb(), { FINNHUB_API_KEY: "fh" }), "AAPL"),
    ).toBeNull();
  });

  it("returns an empty list when the source has nothing to say", async () => {
    // Empty is not the same as unavailable, so this must not be null.
    mockFetch(() => json([]));

    const result = await getNews(env(fakeDb(), { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result).toEqual({ items: [], stale: false });
  });

  it("skips articles missing a headline or url", async () => {
    mockFetch(() =>
      json([ARTICLE, { summary: "no headline", url: "https://x" }, { headline: "no url" }]),
    );

    const result = await getNews(env(fakeDb(), { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.items).toHaveLength(1);
  });

  it("caps at the 20 most recent", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...ARTICLE,
      url: `https://example.com/${i}`,
      datetime: 1_760_000_000 + i,
    }));
    mockFetch(() => json(many));

    const result = await getNews(env(fakeDb(), { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.items).toHaveLength(20);
    // Newest first.
    expect(result?.items[0].publishedAt).toBe((1_760_000_000 + 29) * 1000);
  });

  it("normalizes a blank summary to null", async () => {
    mockFetch(() => json([{ ...ARTICLE, summary: "   " }]));

    const result = await getNews(env(fakeDb(), { FINNHUB_API_KEY: "fh" }), "AAPL");
    expect(result?.items[0].summary).toBeNull();
  });
});
