import { describe, expect, it } from "vitest";
import { bookExposure, positionExposure } from "../src/exposure.js";
import { valuePosition } from "../src/scenario.js";
import type { BondPosition, MarketSnapshot } from "../src/types.js";

const MARKET: MarketSnapshot = {
  spot: { AAPL: 100 },
  riskFreeRate: 0.04,
  asOf: "2026-01-01",
};

/** Quote currency per 1 USD, so a USD amount is `local / rate`. */
const FX_MARKET: MarketSnapshot = { ...MARKET, fxRates: { EUR: 0.92 } };

function bond(overrides: Partial<BondPosition> = {}): BondPosition {
  return {
    id: "b1",
    type: "bond",
    ticker: "T-4.25-2034",
    faceValue: 100_000,
    couponRate: 0.0425,
    maturity: "2034-05-15",
    price: 96.59,
    costBasis: 98.1,
    currency: "USD",
    ...overrides,
  };
}

describe("bond exposure", () => {
  it("values a long USD bond at face x price/100", () => {
    const e = positionExposure(bond(), MARKET);

    expect(e.notional).toBeCloseTo(96_590, 6);
    expect(e.marketValue).toBeCloseTo(96_590, 6);
  });

  it("carries no share-equivalents or Greeks", () => {
    // Delta-equivalent exposure is a statement about an underlying's shares.
    // A bond has no underlying, so it must not perturb the covariance inputs.
    const e = positionExposure(bond(), MARKET);

    expect(e.shareEquivalents).toBe(0);
    expect(e.greeks).toEqual({
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    });
  });

  it("signs a short bond negative", () => {
    const e = positionExposure(bond({ faceValue: -100_000 }), MARKET);

    expect(e.notional).toBeCloseTo(-96_590, 6);
  });

  it("divides by the FX rate to reach USD", () => {
    // EUR 96,590 at 0.92 EUR per USD is ~USD 104,989 — dividing, not
    // multiplying, is the whole point of the convention.
    const e = positionExposure(bond({ currency: "EUR" }), FX_MARKET);

    expect(e.notional).toBeCloseTo(96_590 / 0.92, 6);
    expect(e.notional).toBeGreaterThan(96_590);
  });

  it("treats a currency with no rate as USD", () => {
    const e = positionExposure(bond({ currency: "EUR" }), MARKET);

    expect(e.notional).toBeCloseTo(96_590, 6);
  });

  it("values without a spot price, since no provider quotes bonds", () => {
    // The ticker is deliberately absent from MARKET.spot.
    expect(() => positionExposure(bond(), MARKET)).not.toThrow();
  });

  it("prefers a spot mark when one happens to exist", () => {
    const market: MarketSnapshot = {
      ...MARKET,
      spot: { ...MARKET.spot, "T-4.25-2034": 99 },
    };

    expect(positionExposure(bond(), market).notional).toBeCloseTo(99_000, 6);
  });

  it("participates in gross and net notional", () => {
    const book = bookExposure(
      [bond(), bond({ id: "b2", faceValue: -50_000 })],
      MARKET,
    );

    expect(book.skipped).toHaveLength(0);
    expect(book.netNotional).toBeCloseTo(96_590 - 48_295, 6);
    expect(book.grossNotional).toBeCloseTo(96_590 + 48_295, 6);
  });
});

describe("bonds under scenario shocks", () => {
  it("holds constant across a price shock", () => {
    const base = valuePosition(bond(), MARKET);
    const shocked = valuePosition(bond(), MARKET, {
      priceShock: -0.3,
      volShock: 0.1,
      daysForward: 30,
    });

    expect(shocked).toBeCloseTo(base, 6);
    expect(base).toBeCloseTo(96_590, 6);
  });

  it("still converts currency under a shock", () => {
    const shocked = valuePosition(bond({ currency: "EUR" }), FX_MARKET, {
      priceShock: 0.25,
      volShock: 0,
      daysForward: 0,
    });

    expect(shocked).toBeCloseTo(96_590 / 0.92, 6);
  });
});
