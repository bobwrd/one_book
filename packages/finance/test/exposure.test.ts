import { describe, expect, it } from "vitest";
import {
  bookExposure,
  MissingPriceError,
  positionExposure,
} from "../src/exposure.js";
import { bsGreeks, yearsToExpiry } from "../src/blackScholes.js";
import type {
  MarketSnapshot,
  OptionPosition,
  StockPosition,
} from "../src/types.js";

const MARKET: MarketSnapshot = {
  spot: { AAPL: 100, MSFT: 200 },
  riskFreeRate: 0.04,
  asOf: "2026-01-01",
};

const STOCK: StockPosition = {
  id: "s1",
  type: "stock",
  ticker: "AAPL",
  quantity: 100,
  costBasis: 90,
};

function call(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: "o1",
    type: "option",
    ticker: "AAPL",
    right: "call",
    strike: 100,
    expiry: "2026-07-01",
    quantity: 1,
    contractMultiplier: 100,
    costBasis: 5,
    iv: 0.3,
    ivIsEstimate: false,
    ...overrides,
  };
}

describe("positionExposure", () => {
  it("treats a stock as its own share count with delta 1", () => {
    const e = positionExposure(STOCK, MARKET);
    expect(e.shareEquivalents).toBe(100);
    expect(e.notional).toBe(10_000);
    expect(e.greeks.delta).toBe(100);
    expect(e.greeks.gamma).toBe(0);
  });

  it("signs a short stock position negatively", () => {
    const e = positionExposure({ ...STOCK, quantity: -100 }, MARKET);
    expect(e.shareEquivalents).toBe(-100);
    expect(e.notional).toBe(-10_000);
  });

  it("converts a long call to delta x contracts x multiplier", () => {
    const option = call();
    const perShare = bsGreeks({
      spot: 100,
      strike: 100,
      timeToExpiry: yearsToExpiry(MARKET.asOf, option.expiry),
      volatility: 0.3,
      riskFreeRate: 0.04,
      right: "call",
    });
    const e = positionExposure(option, MARKET);
    expect(e.shareEquivalents).toBeCloseTo(perShare.delta * 100, 10);
    // An ATM call sits near 50-60 delta, so ~55 share-equivalents.
    expect(e.shareEquivalents).toBeGreaterThan(40);
    expect(e.shareEquivalents).toBeLessThan(70);
  });

  it("flips exposure sign for a short call", () => {
    const long = positionExposure(call(), MARKET);
    const short = positionExposure(call({ quantity: -1 }), MARKET);
    expect(short.shareEquivalents).toBeCloseTo(-long.shareEquivalents, 10);
    expect(short.greeks.gamma).toBeCloseTo(-long.greeks.gamma, 10);
  });

  it("gives a long put negative share-equivalent exposure", () => {
    const e = positionExposure(call({ right: "put" }), MARKET);
    expect(e.shareEquivalents).toBeLessThan(0);
  });

  it("throws a typed error when the ticker has no price", () => {
    expect(() => positionExposure({ ...STOCK, ticker: "NOPE" }, MARKET)).toThrow(
      MissingPriceError,
    );
  });
});

describe("bookExposure — the core insight", () => {
  it("nets a covered call down against its stock", () => {
    const stockOnly = bookExposure([STOCK], MARKET);
    const covered = bookExposure([STOCK, call({ quantity: -1 })], MARKET);

    // This is the whole thesis: writing a call reduces net long exposure.
    expect(covered.byTicker.AAPL).toBeLessThan(stockOnly.byTicker.AAPL);
    expect(covered.byTicker.AAPL).toBeGreaterThan(0);
  });

  it("nets a delta-hedged long call to approximately zero", () => {
    const option = call();
    const optionExposure = positionExposure(option, MARKET).shareEquivalents;
    const hedge: StockPosition = {
      ...STOCK,
      id: "hedge",
      quantity: -optionExposure,
    };

    const book = bookExposure([option, hedge], MARKET);
    expect(book.byTicker.AAPL).toBeCloseTo(0, 8);
    expect(book.netGreeks.delta).toBeCloseTo(0, 8);
    // Delta-neutral is not risk-neutral: gamma survives the hedge.
    expect(book.netGreeks.gamma).toBeGreaterThan(0);
  });

  it("keeps underlyings separate", () => {
    const msft: StockPosition = {
      id: "s2",
      type: "stock",
      ticker: "MSFT",
      quantity: 50,
      costBasis: 180,
    };
    const book = bookExposure([STOCK, msft], MARKET);
    expect(book.byTicker.AAPL).toBe(100);
    expect(book.byTicker.MSFT).toBe(50);
    expect(book.netNotional).toBe(10_000 + 10_000);
  });

  it("sums Greeks across the book", () => {
    const book = bookExposure([call(), call({ id: "o2" })], MARKET);
    const single = positionExposure(call(), MARKET);
    expect(book.netGreeks.vega).toBeCloseTo(single.greeks.vega * 2, 10);
    expect(book.netGreeks.theta).toBeCloseTo(single.greeks.theta * 2, 10);
  });

  it("distinguishes gross from net notional on a long/short book", () => {
    const short: StockPosition = {
      id: "s3",
      type: "stock",
      ticker: "MSFT",
      quantity: -50,
      costBasis: 180,
    };
    const book = bookExposure([STOCK, short], MARKET);
    expect(book.netNotional).toBe(0);
    expect(book.grossNotional).toBe(20_000);
  });

  it("isolates an unpriceable position instead of blanking the book", () => {
    const book = bookExposure(
      [STOCK, { ...STOCK, id: "bad", ticker: "NOPE" }],
      MARKET,
    );
    expect(book.positions).toHaveLength(1);
    expect(book.skipped).toHaveLength(1);
    expect(book.skipped[0].positionId).toBe("bad");
    expect(book.byTicker.AAPL).toBe(100);
  });

  it("returns an empty book cleanly", () => {
    const book = bookExposure([], MARKET);
    expect(book.netNotional).toBe(0);
    expect(book.netGreeks.delta).toBe(0);
    expect(book.positions).toHaveLength(0);
  });
});
