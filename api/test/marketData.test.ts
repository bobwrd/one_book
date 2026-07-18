/**
 * Provider selection and Alpaca response parsing, against recorded payload
 * shapes rather than the live API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getProvider, MarketDataError } from "../src/marketData.js";
import type { Env } from "../src/env.js";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    TOKEN_ENCRYPTION_KEY: "k",
    STATE_SIGNING_SECRET: "s",
    APP_ORIGIN: "http://localhost:5173",
    API_ORIGIN: "http://localhost:8787",
    ...overrides,
  } as Env;
}

const ALPACA_KEYS = {
  ALPACA_API_KEY_ID: "PKTEST",
  ALPACA_API_SECRET_KEY: "secret",
};

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

describe("provider selection", () => {
  it("prefers Alpaca when its keys are present", () => {
    expect(getProvider(env(ALPACA_KEYS))?.name).toBe("alpaca");
  });

  it("honors an explicit provider choice", () => {
    const e = env({ ...ALPACA_KEYS, ALPHA_VANTAGE_API_KEY: "av", MARKET_DATA_PROVIDER: "alphavantage" });
    expect(getProvider(e)?.name).toBe("alphavantage");
  });

  it("falls back to another provider when Alpaca is unconfigured", () => {
    expect(getProvider(env({ ALPHA_VANTAGE_API_KEY: "av" }))?.name).toBe(
      "alphavantage",
    );
    expect(getProvider(env({ FINNHUB_API_KEY: "fh" }))?.name).toBe("finnhub");
  });

  it("returns null when nothing is configured", () => {
    expect(getProvider(env())).toBeNull();
  });

  it("returns null when the requested provider lacks credentials", () => {
    expect(getProvider(env({ MARKET_DATA_PROVIDER: "alpaca" }))).toBeNull();
  });
});

describe("Alpaca bars", () => {
  it("parses daily closes and sorts them oldest-first", async () => {
    mockFetch(() =>
      json({
        bars: {
          AAPL: [
            { t: "2026-01-05T05:00:00Z", c: 189.2 },
            { t: "2026-01-02T05:00:00Z", c: 185.64 },
          ],
        },
        next_page_token: null,
      }),
    );

    const closes = await getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL");
    expect(closes).toEqual([
      { date: "2026-01-02", close: 185.64 },
      { date: "2026-01-05", close: 189.2 },
    ]);
  });

  it("requests the configured feed and adjusted bars", async () => {
    let seen: URL | null = null;
    mockFetch((url) => {
      seen = url;
      return json({ bars: { AAPL: [{ t: "2026-01-02T05:00:00Z", c: 1 }] } });
    });

    await getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL");
    expect(seen!.searchParams.get("feed")).toBe("iex");
    // Unadjusted bars would put a split-sized jump in the return series.
    expect(seen!.searchParams.get("adjustment")).toBe("all");
    expect(seen!.searchParams.get("timeframe")).toBe("1Day");
  });

  it("uses the sip feed when configured", async () => {
    let seen: URL | null = null;
    mockFetch((url) => {
      seen = url;
      return json({ bars: { AAPL: [{ t: "2026-01-02T05:00:00Z", c: 1 }] } });
    });

    await getProvider(
      env({ ...ALPACA_KEYS, ALPACA_DATA_FEED: "sip" }),
    )!.fetchDailyCloses("AAPL");
    expect(seen!.searchParams.get("feed")).toBe("sip");
  });

  it("follows pagination rather than truncating history", async () => {
    let call = 0;
    mockFetch(() => {
      call++;
      return call === 1
        ? json({
            bars: { AAPL: [{ t: "2026-01-02T05:00:00Z", c: 100 }] },
            next_page_token: "page2",
          })
        : json({
            bars: { AAPL: [{ t: "2026-01-03T05:00:00Z", c: 101 }] },
            next_page_token: null,
          });
    });

    const closes = await getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL");
    expect(closes).toHaveLength(2);
    expect(call).toBe(2);
  });

  it("raises a clear error on bad credentials", async () => {
    mockFetch(() => json({ message: "forbidden" }, 403));
    await expect(
      getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL"),
    ).rejects.toThrow(/credentials/i);
  });

  it("marks a rate limit as retryable", async () => {
    mockFetch(() => json({}, 429));
    await expect(
      getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL"),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("raises when a symbol has no bars", async () => {
    mockFetch(() => json({ bars: {} }));
    await expect(
      getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("NOPE"),
    ).rejects.toThrow(MarketDataError);
  });
});

describe("Alpaca quotes", () => {
  it("batches every symbol into one request", async () => {
    let seen: URL | null = null;
    let calls = 0;
    mockFetch((url) => {
      seen = url;
      calls++;
      return json({
        trades: {
          AAPL: { p: 232.11 },
          MSFT: { p: 498.4 },
          NVDA: { p: 178.02 },
        },
      });
    });

    const quotes = await getProvider(env(ALPACA_KEYS))!.fetchQuotes!([
      "AAPL",
      "MSFT",
      "NVDA",
    ]);

    // The whole reason to prefer Alpaca: one call, not three.
    expect(calls).toBe(1);
    expect(seen!.searchParams.get("symbols")).toBe("AAPL,MSFT,NVDA");
    expect(quotes).toEqual({ AAPL: 232.11, MSFT: 498.4, NVDA: 178.02 });
  });

  it("omits symbols with no trade rather than inventing a price", async () => {
    mockFetch(() => json({ trades: { AAPL: { p: 232.11 } } }));
    const quotes = await getProvider(env(ALPACA_KEYS))!.fetchQuotes!([
      "AAPL",
      "DELISTED",
    ]);
    expect(quotes).toEqual({ AAPL: 232.11 });
    expect(quotes.DELISTED).toBeUndefined();
  });

  it("rejects non-positive prices", async () => {
    mockFetch(() => json({ trades: { AAPL: { p: 0 } } }));
    expect(
      await getProvider(env(ALPACA_KEYS))!.fetchQuotes!(["AAPL"]),
    ).toEqual({});
  });

  it("returns null from the single-quote path when unavailable", async () => {
    mockFetch(() => json({ trades: {} }));
    expect(await getProvider(env(ALPACA_KEYS))!.fetchQuote("AAPL")).toBeNull();
  });

  it("makes no request for an empty symbol list", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return json({ trades: {} });
    });
    expect(await getProvider(env(ALPACA_KEYS))!.fetchQuotes!([])).toEqual({});
    expect(calls).toBe(0);
  });
});

describe("Alpaca error diagnostics", () => {
  it("surfaces the X-Request-ID on failures", async () => {
    // Alpaca asks for this in support requests and it cannot be looked up
    // afterwards, so an error without it is effectively unreportable.
    mockFetch(
      () =>
        new Response(JSON.stringify({}), {
          status: 403,
          headers: { "X-Request-ID": "0d29ba8d9a51ee0eb4e7bbaa9acff223" },
        }),
    );

    await expect(
      getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL"),
    ).rejects.toThrow(/0d29ba8d9a51ee0eb4e7bbaa9acff223/);
  });

  it("names the feed in a credentials error", async () => {
    // A rejected 'sip' request usually means no paid plan, not a bad key.
    mockFetch(() => json({}, 403));
    await expect(
      getProvider(
        env({ ...ALPACA_KEYS, ALPACA_DATA_FEED: "sip" }),
      )!.fetchDailyCloses("AAPL"),
    ).rejects.toThrow(/"sip" feed/);
  });

  it("still errors cleanly when no request id is present", async () => {
    mockFetch(() => json({}, 500));
    await expect(
      getProvider(env(ALPACA_KEYS))!.fetchDailyCloses("AAPL"),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("feed compatibility between endpoints", () => {
  it("maps delayed_sip down to iex for bars", async () => {
    // Bars accept sip/iex/boats/otc only. Sending delayed_sip there is
    // rejected outright, which silently kills correlation and VaR while
    // quotes keep working — a confusing half-broken state.
    let seen: URL | null = null;
    mockFetch((url) => {
      seen = url;
      return json({ bars: { AAPL: [{ t: "2026-01-02T05:00:00Z", c: 1 }] } });
    });

    await getProvider(
      env({ ...ALPACA_KEYS, ALPACA_DATA_FEED: "delayed_sip" }),
    )!.fetchDailyCloses("AAPL");

    expect(seen!.searchParams.get("feed")).toBe("iex");
  });

  it("still uses delayed_sip for latest trades", async () => {
    // The same config value is valid here, so it must pass through unchanged.
    let seen: URL | null = null;
    mockFetch((url) => {
      seen = url;
      return json({ trades: { AAPL: { p: 1 } } });
    });

    await getProvider(
      env({ ...ALPACA_KEYS, ALPACA_DATA_FEED: "delayed_sip" }),
    )!.fetchQuotes!(["AAPL"]);

    expect(seen!.searchParams.get("feed")).toBe("delayed_sip");
  });

  it("passes sip through to bars unchanged", async () => {
    let seen: URL | null = null;
    mockFetch((url) => {
      seen = url;
      return json({ bars: { AAPL: [{ t: "2026-01-02T05:00:00Z", c: 1 }] } });
    });

    await getProvider(
      env({ ...ALPACA_KEYS, ALPACA_DATA_FEED: "sip" }),
    )!.fetchDailyCloses("AAPL");

    expect(seen!.searchParams.get("feed")).toBe("sip");
  });
});
