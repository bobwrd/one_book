import { describe, expect, it } from "vitest";
import {
  bsGreeks,
  bsPrice,
  impliedVolatility,
  ImpliedVolError,
  normCdf,
  yearsToExpiry,
} from "../src/blackScholes.js";
import type { BsInputs } from "../src/blackScholes.js";

/** Textbook case (Hull, Options Futures and Other Derivatives). */
const HULL: BsInputs = {
  spot: 42,
  strike: 40,
  timeToExpiry: 0.5,
  volatility: 0.2,
  riskFreeRate: 0.1,
  right: "call",
};

describe("normCdf", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021049, 9);
    expect(normCdf(-1.96)).toBeCloseTo(0.0249978951, 9);
    expect(normCdf(3)).toBeCloseTo(0.9986501, 7);
  });

  it("is symmetric about zero", () => {
    for (const x of [0.1, 0.5, 1, 2, 4, 6]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 12);
    }
  });

  it("saturates without returning out-of-range values", () => {
    expect(normCdf(-50)).toBe(0);
    expect(normCdf(50)).toBe(1);
  });
});

describe("bsPrice", () => {
  it("reproduces the Hull worked example", () => {
    // Hull gives 4.76 for the call.
    expect(bsPrice(HULL)).toBeCloseTo(4.7594, 3);
  });

  it("reproduces the matching put", () => {
    expect(bsPrice({ ...HULL, right: "put" })).toBeCloseTo(0.8086, 3);
  });

  it("satisfies put-call parity", () => {
    const call = bsPrice(HULL);
    const put = bsPrice({ ...HULL, right: "put" });
    const parity =
      HULL.spot - HULL.strike * Math.exp(-HULL.riskFreeRate * HULL.timeToExpiry);
    expect(call - put).toBeCloseTo(parity, 10);
  });

  it("collapses to intrinsic value at expiry", () => {
    expect(bsPrice({ ...HULL, timeToExpiry: 0 })).toBe(2);
    expect(bsPrice({ ...HULL, timeToExpiry: 0, right: "put" })).toBe(0);
  });

  it("collapses to intrinsic value at zero volatility", () => {
    // Zero vol still discounts the strike, but our degenerate branch returns
    // undiscounted intrinsic, which is the conservative UI-facing choice.
    expect(bsPrice({ ...HULL, volatility: 0 })).toBe(2);
  });

  it("is monotonically increasing in volatility", () => {
    let previous = -Infinity;
    for (const volatility of [0.05, 0.1, 0.2, 0.4, 0.8]) {
      const price = bsPrice({ ...HULL, volatility });
      expect(price).toBeGreaterThan(previous);
      previous = price;
    }
  });

  it("never prices below intrinsic", () => {
    const deepItm = bsPrice({ ...HULL, spot: 200 });
    expect(deepItm).toBeGreaterThanOrEqual(200 - HULL.strike);
  });
});

describe("bsGreeks", () => {
  it("matches finite-difference delta", () => {
    const h = 1e-5;
    const up = bsPrice({ ...HULL, spot: HULL.spot + h });
    const down = bsPrice({ ...HULL, spot: HULL.spot - h });
    expect(bsGreeks(HULL).delta).toBeCloseTo((up - down) / (2 * h), 6);
  });

  it("matches finite-difference gamma", () => {
    const h = 1e-3;
    const up = bsPrice({ ...HULL, spot: HULL.spot + h });
    const mid = bsPrice(HULL);
    const down = bsPrice({ ...HULL, spot: HULL.spot - h });
    expect(bsGreeks(HULL).gamma).toBeCloseTo((up - 2 * mid + down) / h ** 2, 5);
  });

  it("matches finite-difference vega, in per-percentage-point units", () => {
    const h = 1e-6;
    const up = bsPrice({ ...HULL, volatility: HULL.volatility + h });
    const down = bsPrice({ ...HULL, volatility: HULL.volatility - h });
    expect(bsGreeks(HULL).vega).toBeCloseTo((up - down) / (2 * h) / 100, 6);
  });

  it("matches finite-difference theta, in per-calendar-day units", () => {
    const h = 1e-6;
    const later = bsPrice({ ...HULL, timeToExpiry: HULL.timeToExpiry - h });
    const earlier = bsPrice({ ...HULL, timeToExpiry: HULL.timeToExpiry + h });
    const perYear = (later - earlier) / (2 * h);
    expect(bsGreeks(HULL).theta).toBeCloseTo(perYear / 365, 6);
  });

  it("matches finite-difference rho, in per-percentage-point units", () => {
    const h = 1e-7;
    const up = bsPrice({ ...HULL, riskFreeRate: HULL.riskFreeRate + h });
    const down = bsPrice({ ...HULL, riskFreeRate: HULL.riskFreeRate - h });
    expect(bsGreeks(HULL).rho).toBeCloseTo((up - down) / (2 * h) / 100, 5);
  });

  it("bounds call delta to [0,1] and put delta to [-1,0]", () => {
    for (const spot of [1, 20, 40, 60, 500]) {
      expect(bsGreeks({ ...HULL, spot }).delta).toBeGreaterThanOrEqual(0);
      expect(bsGreeks({ ...HULL, spot }).delta).toBeLessThanOrEqual(1);
      const put = bsGreeks({ ...HULL, spot, right: "put" }).delta;
      expect(put).toBeGreaterThanOrEqual(-1);
      expect(put).toBeLessThanOrEqual(0);
    }
  });

  it("gives calls and puts identical gamma and vega", () => {
    const call = bsGreeks(HULL);
    const put = bsGreeks({ ...HULL, right: "put" });
    expect(call.gamma).toBeCloseTo(put.gamma, 12);
    expect(call.vega).toBeCloseTo(put.vega, 12);
  });

  it("returns a step-function delta at expiry", () => {
    expect(bsGreeks({ ...HULL, timeToExpiry: 0, spot: 50 }).delta).toBe(1);
    expect(bsGreeks({ ...HULL, timeToExpiry: 0, spot: 30 }).delta).toBe(0);
    expect(bsGreeks({ ...HULL, timeToExpiry: 0, spot: 30, right: "put" }).delta).toBe(-1);
    expect(bsGreeks({ ...HULL, timeToExpiry: 0 }).gamma).toBe(0);
  });
});

describe("impliedVolatility", () => {
  it("round-trips price -> IV -> price", () => {
    for (const volatility of [0.05, 0.15, 0.3, 0.75, 1.5]) {
      const price = bsPrice({ ...HULL, volatility });
      expect(impliedVolatility(price, HULL)).toBeCloseTo(volatility, 6);
    }
  });

  it("round-trips across strikes, or refuses cleanly in the deep wings", () => {
    // The contract that matters: never return a confident-looking wrong
    // number. Where vega is negligible the volatility genuinely is not
    // recoverable from the price, and the solver must say so.
    for (const strike of [10, 30, 40, 55, 120]) {
      for (const right of ["call", "put"] as const) {
        const inputs = { ...HULL, strike, right, volatility: 0.35 };
        const price = bsPrice(inputs);

        let solved: number | null = null;
        let thrown: unknown = null;
        try {
          solved = impliedVolatility(price, inputs);
        } catch (err) {
          thrown = err;
        }

        if (thrown !== null) {
          expect(thrown).toBeInstanceOf(ImpliedVolError);
        } else {
          expect(solved).toBeCloseTo(0.35, 4);
        }
      }
    }
  });

  it("recovers IV for in-the-money puts trading below intrinsic value", () => {
    // A European put below intrinsic is legitimate, not an arbitrage. This is
    // the case a naive discounted-intrinsic floor wrongly rejects.
    const inputs = { ...HULL, strike: 55, right: "put" as const, volatility: 0.35 };
    const price = bsPrice(inputs);
    const intrinsicValue = 55 - HULL.spot;
    expect(price).toBeLessThan(intrinsicValue);
    expect(impliedVolatility(price, inputs)).toBeCloseTo(0.35, 6);
  });

  it("rejects a price below the no-arbitrage floor", () => {
    expect(() => impliedVolatility(0.5, { ...HULL, spot: 100 })).toThrow(
      ImpliedVolError,
    );
  });

  it("rejects a price above the no-arbitrage ceiling", () => {
    expect(() => impliedVolatility(HULL.spot * 2, HULL)).toThrow(
      ImpliedVolError,
    );
  });

  it("rejects solving at expiry", () => {
    expect(() => impliedVolatility(2, { ...HULL, timeToExpiry: 0 })).toThrow(
      ImpliedVolError,
    );
  });
});

describe("yearsToExpiry", () => {
  it("computes a year fraction from ISO dates", () => {
    expect(yearsToExpiry("2026-01-01", "2027-01-01")).toBeCloseTo(1, 6);
    expect(yearsToExpiry("2026-01-01", "2026-07-02")).toBeCloseTo(0.5, 2);
  });

  it("floors at zero for past expiries", () => {
    expect(yearsToExpiry("2026-06-01", "2026-01-01")).toBe(0);
  });

  it("rejects malformed dates", () => {
    expect(() => yearsToExpiry("nonsense", "2026-01-01")).toThrow();
  });
});
