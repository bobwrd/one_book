/**
 * FX rate caching and degradation, against recorded payload shapes rather than
 * the live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getFxRate } from "../src/fx.js";
import type { Env } from "../src/env.js";

/**
 * Minimal D1 stand-in: one `fx_rate_cache` row per quote currency, enough to
 * exercise cache-hit, cache-miss, and write-through without a real database.
 */
function fakeDb(seed: Record<string, { rate: number; fetched_at: number }> = {}) {
  const rows = { ...seed };
  const statements: string[] = [];

  const db = {
    rows,
    statements,
    prepare(sql: string) {
      statements.push(sql);
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          return (rows[String(bound[0])] as T) ?? null;
        },
        async run() {
          const [quote, rate, fetchedAt] = bound as [string, number, number];
          rows[quote] = { rate, fetched_at: fetchedAt };
          return { success: true };
        },
      };
    },
  };

  return db;
}

function env(db: ReturnType<typeof fakeDb>): Env {
  return {
    DB: db as unknown as D1Database,
    KV: {} as KVNamespace,
    TOKEN_ENCRYPTION_KEY: "k",
    STATE_SIGNING_SECRET: "s",
    APP_ORIGIN: "http://localhost:5173",
    API_ORIGIN: "http://localhost:8787",
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getFxRate", () => {
  it("short-circuits USD without touching the network or the cache", async () => {
    const db = fakeDb();
    mockFetch(() => {
      throw new Error("should not fetch");
    });

    expect(await getFxRate(env(db), "USD")).toEqual({ rate: 1, stale: false });
    expect(db.statements).toHaveLength(0);
  });

  it("uppercases the requested currency", async () => {
    mockFetch((url) => {
      expect(url.searchParams.get("to")).toBe("EUR");
      return json({ rates: { EUR: 0.92 } });
    });

    expect(await getFxRate(env(fakeDb()), "eur")).toEqual({
      rate: 0.92,
      stale: false,
    });
  });

  it("fetches and caches on a miss", async () => {
    const db = fakeDb();
    mockFetch((url) => {
      expect(url.hostname).toBe("api.frankfurter.app");
      expect(url.searchParams.get("from")).toBe("USD");
      return json({ rates: { EUR: 0.92 } });
    });

    expect(await getFxRate(env(db), "EUR")).toEqual({ rate: 0.92, stale: false });
    expect(db.rows.EUR.rate).toBe(0.92);
  });

  it("serves a fresh cache entry without fetching", async () => {
    const db = fakeDb({ EUR: { rate: 0.9, fetched_at: Date.now() } });
    mockFetch(() => {
      throw new Error("should not fetch");
    });

    expect(await getFxRate(env(db), "EUR")).toEqual({ rate: 0.9, stale: false });
  });

  it("refetches once the 24h TTL has passed", async () => {
    const db = fakeDb({
      EUR: { rate: 0.9, fetched_at: Date.now() - 25 * 60 * 60 * 1000 },
    });
    mockFetch(() => json({ rates: { EUR: 0.95 } }));

    expect(await getFxRate(env(db), "EUR")).toEqual({ rate: 0.95, stale: false });
  });

  it("falls back to a stale cache entry when the fetch fails", async () => {
    // A day-old reference rate beats an unconverted total that reads as USD.
    const db = fakeDb({
      EUR: { rate: 0.9, fetched_at: Date.now() - 48 * 60 * 60 * 1000 },
    });
    mockFetch(() => json({ error: "down" }, 500));

    expect(await getFxRate(env(db), "EUR")).toEqual({ rate: 0.9, stale: true });
  });

  it("falls back to a stale entry when the network throws outright", async () => {
    const db = fakeDb({
      EUR: { rate: 0.9, fetched_at: Date.now() - 48 * 60 * 60 * 1000 },
    });
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

    expect(await getFxRate(env(db), "EUR")).toEqual({ rate: 0.9, stale: true });
  });

  it("returns null when the fetch fails and nothing is cached", async () => {
    mockFetch(() => json({ error: "down" }, 500));

    expect(await getFxRate(env(fakeDb()), "EUR")).toBeNull();
  });

  it("returns null when the response omits the requested currency", async () => {
    mockFetch(() => json({ rates: { GBP: 0.78 } }));

    expect(await getFxRate(env(fakeDb()), "EUR")).toBeNull();
  });

  it("rejects a non-positive rate rather than caching it", async () => {
    const db = fakeDb();
    mockFetch(() => json({ rates: { EUR: 0 } }));

    expect(await getFxRate(env(db), "EUR")).toBeNull();
    expect(db.rows.EUR).toBeUndefined();
  });
});
