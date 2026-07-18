import { describe, expect, it } from "vitest";
import {
  addDays,
  breakevens,
  NO_SHOCK,
  payoffCurve,
  riskCallouts,
  runScenario,
  shockMarket,
} from "../src/scenario.js";
import { bookExposure } from "../src/exposure.js";
import type {
  MarketSnapshot,
  OptionPosition,
  StockPosition,
} from "../src/types.js";

const MARKET: MarketSnapshot = {
  spot: { AAPL: 100 },
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

function opt(overrides: Partial<OptionPosition> = {}): OptionPosition {
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

describe("addDays", () => {
  it("advances an ISO date", () => {
    expect(addDays("2026-01-01", 31)).toBe("2026-02-01");
    expect(addDays("2026-01-01", 0)).toBe("2026-01-01");
  });

  it("handles leap years", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("shockMarket", () => {
  it("scales every spot price", () => {
    const shocked = shockMarket(MARKET, { ...NO_SHOCK, priceShock: 0.1 });
    expect(shocked.spot.AAPL).toBeCloseTo(110, 12);
  });

  it("rolls the valuation date forward", () => {
    const shocked = shockMarket(MARKET, { ...NO_SHOCK, daysForward: 30 });
    expect(shocked.asOf).toBe("2026-01-31");
  });

  it("leaves the original snapshot untouched", () => {
    shockMarket(MARKET, { ...NO_SHOCK, priceShock: 0.5 });
    expect(MARKET.spot.AAPL).toBe(100);
  });
});

describe("runScenario", () => {
  it("produces zero P&L under no shock", () => {
    const result = runScenario([STOCK, opt()], MARKET, NO_SHOCK);
    expect(result.pnl).toBeCloseTo(0, 10);
  });

  it("moves stock P&L linearly with the price shock", () => {
    const up = runScenario([STOCK], MARKET, { ...NO_SHOCK, priceShock: 0.1 });
    expect(up.pnl).toBeCloseTo(1_000, 10);

    const down = runScenario([STOCK], MARKET, { ...NO_SHOCK, priceShock: -0.1 });
    expect(down.pnl).toBeCloseTo(-1_000, 10);
  });

  it("gains on a long call when the underlying rallies", () => {
    const result = runScenario([opt()], MARKET, { ...NO_SHOCK, priceShock: 0.2 });
    expect(result.pnl).toBeGreaterThan(0);
  });

  it("loses on a short call when the underlying rallies", () => {
    const result = runScenario([opt({ quantity: -1 })], MARKET, {
      ...NO_SHOCK,
      priceShock: 0.2,
    });
    expect(result.pnl).toBeLessThan(0);
  });

  it("captures convexity that a linear delta estimate would miss", () => {
    const option = opt();
    const delta = bookExposure([option], MARKET).netGreeks.delta;
    const shock = 0.3;
    const linearEstimate = delta * MARKET.spot.AAPL * shock;
    const actual = runScenario([option], MARKET, {
      ...NO_SHOCK,
      priceShock: shock,
    }).pnl;

    // Long gamma means the true payoff beats the tangent line.
    expect(actual).toBeGreaterThan(linearEstimate);
  });

  it("gains on a long option when volatility rises", () => {
    const result = runScenario([opt()], MARKET, { ...NO_SHOCK, volShock: 0.1 });
    expect(result.pnl).toBeGreaterThan(0);
  });

  it("loses on a long option as time passes", () => {
    const result = runScenario([opt()], MARKET, {
      ...NO_SHOCK,
      daysForward: 30,
    });
    expect(result.pnl).toBeLessThan(0);
  });

  it("leaves a stock unaffected by vol and time shocks", () => {
    const result = runScenario([STOCK], MARKET, {
      priceShock: 0,
      volShock: 0.5,
      daysForward: 90,
    });
    expect(result.pnl).toBeCloseTo(0, 10);
  });

  it("recomputes Greeks under the shocked market", () => {
    const base = bookExposure([opt()], MARKET).netGreeks;
    const shocked = runScenario([opt()], MARKET, {
      ...NO_SHOCK,
      priceShock: 0.25,
    }).shockedGreeks;
    // A call driven deep ITM gains delta.
    expect(shocked.delta).toBeGreaterThan(base.delta);
  });

  it("floors shocked volatility above zero", () => {
    const result = runScenario([opt()], MARKET, {
      ...NO_SHOCK,
      volShock: -5,
    });
    expect(Number.isFinite(result.pnl)).toBe(true);
    expect(result.shockedValue).toBeGreaterThanOrEqual(0);
  });

  it("isolates unpriceable positions", () => {
    const result = runScenario(
      [STOCK, { ...STOCK, id: "bad", ticker: "NOPE" }],
      MARKET,
      { ...NO_SHOCK, priceShock: 0.1 },
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.pnl).toBeCloseTo(1_000, 10);
  });

  it("reports null percent P&L on a flat book rather than dividing by zero", () => {
    const result = runScenario([], MARKET, { ...NO_SHOCK, priceShock: 0.1 });
    expect(result.pnlPercent).toBeNull();
  });
});

describe("payoffCurve", () => {
  it("spans the requested shock range", () => {
    const curve = payoffCurve([STOCK], MARKET, { steps: 11 });
    expect(curve).toHaveLength(11);
    expect(curve[0].priceShock).toBeCloseTo(-0.3, 12);
    expect(curve[10].priceShock).toBeCloseTo(0.3, 12);
    expect(curve[0].price).toBeCloseTo(70, 10);
    expect(curve[10].price).toBeCloseTo(130, 10);
  });

  it("is monotonically increasing for a long stock position", () => {
    const curve = payoffCurve([STOCK], MARKET, { steps: 21 });
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].pnl).toBeGreaterThan(curve[i - 1].pnl);
    }
  });

  it("bends upward at both ends for a long straddle", () => {
    const straddle = [opt(), opt({ id: "o2", right: "put" })];
    const curve = payoffCurve(straddle, MARKET, { steps: 61 });
    const left = curve[0].pnl;
    const middle = curve[30].pnl;
    const right = curve[60].pnl;
    expect(left).toBeGreaterThan(middle);
    expect(right).toBeGreaterThan(middle);
  });
});

describe("breakevens", () => {
  it("finds the zero crossing of a long stock position", () => {
    const curve = payoffCurve([STOCK], MARKET, { steps: 121 });
    const points = breakevens(curve);
    expect(points).toHaveLength(1);
    // Stock P&L is measured against current spot, so it crosses zero there.
    expect(points[0]).toBeCloseTo(100, 1);
  });

  it("finds both crossings of a long straddle", () => {
    const straddle = [opt(), opt({ id: "o2", right: "put" })];
    const curve = payoffCurve(straddle, MARKET, {
      steps: 201,
      daysForward: 181,
    });
    expect(breakevens(curve).length).toBeGreaterThanOrEqual(2);
  });

  it("returns nothing for a curve that never crosses zero", () => {
    const curve = payoffCurve([opt()], MARKET, {
      steps: 21,
      minShock: 0.05,
      maxShock: 0.3,
    });
    expect(breakevens(curve)).toHaveLength(0);
  });
});

describe("riskCallouts", () => {
  it("flags a net short gamma book", () => {
    const callouts = riskCallouts(
      [opt({ quantity: -10 })],
      MARKET,
      [{ ticker: "AAPL", weight: 1 }],
    );
    expect(callouts.some((c) => c.label === "Net short gamma")).toBe(true);
  });

  it("flags theta bleed on a long options book", () => {
    const callouts = riskCallouts(
      [opt({ quantity: 50 })],
      MARKET,
      [{ ticker: "AAPL", weight: 1 }],
    );
    expect(callouts.some((c) => c.label.includes("Theta bleed"))).toBe(true);
  });

  it("flags single-name concentration", () => {
    const callouts = riskCallouts([STOCK], MARKET, [
      { ticker: "AAPL", weight: 0.85 },
    ]);
    const hit = callouts.find((c) => c.label.includes("concentrated"));
    expect(hit?.severity).toBe("critical");
  });

  it("flags imminent expiries", () => {
    const callouts = riskCallouts(
      [opt({ expiry: "2026-01-05" })],
      MARKET,
      [{ ticker: "AAPL", weight: 1 }],
    );
    expect(callouts.some((c) => c.label.includes("expiring within"))).toBe(true);
  });

  it("says nothing alarming about a plain diversified stock book", () => {
    const callouts = riskCallouts([STOCK], MARKET, [
      { ticker: "AAPL", weight: 0.2 },
    ]);
    expect(callouts.filter((c) => c.severity === "critical")).toHaveLength(0);
  });
});
