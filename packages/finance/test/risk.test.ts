import { describe, expect, it } from "vitest";
import {
  alignSeries,
  annualizedVolatility,
  correlation,
  correlationMatrix,
  covariance,
  covarianceMatrix,
  InsufficientDataError,
  logReturns,
  stdDev,
  type PriceSeries,
} from "../src/stats.js";
import {
  concentration,
  historicalVar,
  normInv,
  parametricVar,
  portfolioVolatility,
  riskContributions,
  sharpeRatio,
} from "../src/risk.js";

/** Deterministic pseudo-random walk, so tests never flake. */
function walk(seed: number, n: number, drift = 0, vol = 0.01): number[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const closes = [100];
  for (let i = 1; i < n; i++) {
    // Box-Muller for a normal shock.
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    closes.push(closes[i - 1] * Math.exp(drift + vol * z));
  }
  return closes;
}

function dates(n: number): string[] {
  const out: string[] = [];
  const start = Date.parse("2025-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function series(ticker: string, closes: number[]): PriceSeries {
  return { ticker, dates: dates(closes.length), closes };
}

describe("logReturns", () => {
  it("computes log returns and drops one observation", () => {
    const r = logReturns([100, 110, 121]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(r[1]).toBeCloseTo(Math.log(1.1), 12);
  });

  it("rejects non-positive prices", () => {
    expect(() => logReturns([100, 0])).toThrow(InsufficientDataError);
    expect(() => logReturns([100, -5])).toThrow(InsufficientDataError);
  });
});

describe("covariance and correlation", () => {
  it("gives a perfectly correlated series a correlation of 1", () => {
    const xs = [0.01, -0.02, 0.03, 0.005];
    expect(correlation(xs, xs)).toBeCloseTo(1, 12);
  });

  it("gives an exactly inverted series a correlation of -1", () => {
    const xs = [0.01, -0.02, 0.03, 0.005];
    const ys = xs.map((x) => -x);
    expect(correlation(xs, ys)).toBeCloseTo(-1, 12);
  });

  it("reports zero rather than NaN for a constant series", () => {
    expect(correlation([0.01, 0.01, 0.01], [0.02, -0.01, 0.03])).toBe(0);
  });

  it("equals variance when a series is covaried with itself", () => {
    const xs = [0.01, -0.02, 0.03, 0.005];
    expect(covariance(xs, xs)).toBeCloseTo(stdDev(xs) ** 2, 12);
  });

  it("rejects mismatched series lengths", () => {
    expect(() => covariance([1, 2, 3], [1, 2])).toThrow(InsufficientDataError);
  });

  it("produces a symmetric correlation matrix with a unit diagonal", () => {
    const aligned = alignSeries([
      series("A", walk(1, 60)),
      series("B", walk(2, 60)),
      series("C", walk(3, 60)),
    ]);
    const m = correlationMatrix(aligned.returns, aligned.tickers);
    for (let i = 0; i < 3; i++) {
      expect(m.values[i][i]).toBe(1);
      for (let j = 0; j < 3; j++) {
        expect(m.values[i][j]).toBeCloseTo(m.values[j][i], 12);
        expect(Math.abs(m.values[i][j])).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});

describe("alignSeries", () => {
  it("intersects onto shared dates only", () => {
    const a: PriceSeries = {
      ticker: "A",
      dates: ["2025-01-01", "2025-01-02", "2025-01-03"],
      closes: [100, 101, 102],
    };
    const b: PriceSeries = {
      ticker: "B",
      dates: ["2025-01-02", "2025-01-03", "2025-01-04"],
      closes: [50, 51, 52],
    };
    const aligned = alignSeries([a, b]);
    expect(aligned.dates).toEqual(["2025-01-02", "2025-01-03"]);
    expect(aligned.returns.A).toHaveLength(1);
    expect(aligned.returns.B).toHaveLength(1);
  });

  it("throws when overlap is too small to be usable", () => {
    const a: PriceSeries = { ticker: "A", dates: ["2025-01-01"], closes: [100] };
    const b: PriceSeries = { ticker: "B", dates: ["2025-02-01"], closes: [50] };
    expect(() => alignSeries([a, b])).toThrow(InsufficientDataError);
  });
});

describe("normInv", () => {
  it("matches known critical values", () => {
    expect(normInv(0.5)).toBeCloseTo(0, 9);
    expect(normInv(0.95)).toBeCloseTo(1.6448536, 6);
    expect(normInv(0.99)).toBeCloseTo(2.3263479, 6);
    expect(normInv(0.975)).toBeCloseTo(1.959964, 6);
  });

  it("is antisymmetric", () => {
    expect(normInv(0.3)).toBeCloseTo(-normInv(0.7), 6);
  });

  it("rejects probabilities outside (0,1)", () => {
    expect(() => normInv(0)).toThrow(RangeError);
    expect(() => normInv(1)).toThrow(RangeError);
  });
});

describe("portfolioVolatility", () => {
  const aligned = alignSeries([
    series("A", walk(11, 200)),
    series("B", walk(22, 200)),
  ]);
  const cov = covarianceMatrix(aligned.returns, aligned.tickers);

  it("is zero for an empty book", () => {
    expect(portfolioVolatility({}, cov)).toBe(0);
  });

  it("scales linearly with position size", () => {
    const single = portfolioVolatility({ A: 10_000 }, cov);
    const double = portfolioVolatility({ A: 20_000 }, cov);
    expect(double).toBeCloseTo(single * 2, 6);
  });

  it("never exceeds the sum of standalone volatilities", () => {
    // Subadditivity: diversification cannot make a book riskier than the
    // sum of its parts.
    const combined = portfolioVolatility({ A: 10_000, B: 10_000 }, cov);
    const standalone =
      portfolioVolatility({ A: 10_000 }, cov) +
      portfolioVolatility({ B: 10_000 }, cov);
    expect(combined).toBeLessThanOrEqual(standalone + 1e-9);
  });

  it("stays non-negative on a perfectly offsetting book", () => {
    const hedged = portfolioVolatility({ A: 10_000, B: -10_000 }, cov);
    expect(hedged).toBeGreaterThanOrEqual(0);
  });
});

describe("parametricVar", () => {
  const aligned = alignSeries([series("A", walk(7, 300))]);
  const cov = covarianceMatrix(aligned.returns, aligned.tickers);

  it("is monotonically increasing in confidence", () => {
    const v95 = parametricVar({ A: 100_000 }, cov, 0.95).value;
    const v99 = parametricVar({ A: 100_000 }, cov, 0.99).value;
    expect(v99).toBeGreaterThan(v95);
  });

  it("is monotonically increasing in horizon", () => {
    const oneDay = parametricVar({ A: 100_000 }, cov, 0.95, 1).value;
    const tenDay = parametricVar({ A: 100_000 }, cov, 0.95, 10).value;
    expect(tenDay).toBeGreaterThan(oneDay);
    // Square-root-of-time scaling.
    expect(tenDay).toBeCloseTo(oneDay * Math.sqrt(10), 6);
  });

  it("is monotonically increasing in volatility", () => {
    const calm = alignSeries([series("A", walk(7, 300, 0, 0.005))]);
    const wild = alignSeries([series("A", walk(7, 300, 0, 0.02))]);
    const calmVar = parametricVar(
      { A: 100_000 },
      covarianceMatrix(calm.returns, calm.tickers),
    ).value;
    const wildVar = parametricVar(
      { A: 100_000 },
      covarianceMatrix(wild.returns, wild.tickers),
    ).value;
    expect(wildVar).toBeGreaterThan(calmVar);
  });

  it("is zero for an empty book", () => {
    expect(parametricVar({}, cov).value).toBe(0);
  });

  it("reports a positive loss figure", () => {
    expect(parametricVar({ A: -100_000 }, cov).value).toBeGreaterThan(0);
  });
});

describe("historicalVar", () => {
  const priceSeries = [series("A", walk(5, 300))];

  it("is monotonically increasing in confidence", () => {
    const v95 = historicalVar({ A: 100_000 }, priceSeries, 0.95).value;
    const v99 = historicalVar({ A: 100_000 }, priceSeries, 0.99).value;
    expect(v99).toBeGreaterThanOrEqual(v95);
  });

  it("lands in the same order of magnitude as parametric VaR", () => {
    const aligned = alignSeries(priceSeries);
    const cov = covarianceMatrix(aligned.returns, aligned.tickers);
    const parametric = parametricVar({ A: 100_000 }, cov, 0.95).value;
    const historical = historicalVar({ A: 100_000 }, priceSeries, 0.95).value;
    // Normally-generated data, so the two methods should broadly agree.
    expect(historical).toBeGreaterThan(parametric * 0.5);
    expect(historical).toBeLessThan(parametric * 2);
  });

  it("reports its sample size", () => {
    const result = historicalVar({ A: 100_000 }, priceSeries, 0.95);
    // 300 closes yield 299 daily returns, each replayed as one scenario.
    expect(result.sampleSize).toBe(299);
    expect(result.method).toBe("historical");
  });
});

describe("sharpeRatio", () => {
  it("returns null for an empty book", () => {
    expect(sharpeRatio({}, [series("A", walk(1, 50))], 0.04)).toBeNull();
  });

  it("is higher for a stronger drift at comparable volatility", () => {
    const flat = [series("A", walk(9, 400, 0, 0.01))];
    const rising = [series("A", walk(9, 400, 0.001, 0.01))];
    const flatSharpe = sharpeRatio({ A: 10_000 }, flat, 0.04)!;
    const risingSharpe = sharpeRatio({ A: 10_000 }, rising, 0.04)!;
    expect(risingSharpe).toBeGreaterThan(flatSharpe);
  });
});

describe("riskContributions", () => {
  /** Three correlated names with genuinely different vols. */
  function threeNameCov() {
    const series: PriceSeries[] = [
      { ticker: "AAPL", dates: [], closes: walk(1, 260, 0, 0.012) },
      { ticker: "MSFT", dates: [], closes: walk(2, 260, 0, 0.009) },
      { ticker: "NVDA", dates: [], closes: walk(3, 260, 0, 0.028) },
    ];
    const dates = series[0].closes.map((_, i) =>
      new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    );
    for (const s of series) s.dates = dates;
    const aligned = alignSeries(series);
    return covarianceMatrix(aligned.returns, aligned.tickers);
  }

  it("contributions sum exactly to portfolio volatility", () => {
    const cov = threeNameCov();
    const notional = { AAPL: 120_000, MSFT: 80_000, NVDA: 45_000 };

    const d = riskContributions(notional, cov)!;
    const total = d.contributions.reduce((a, c) => a + c.contribution, 0);

    // Euler's theorem: this identity is what makes the split an attribution
    // rather than a heuristic. It should hold to floating-point precision.
    expect(total).toBeCloseTo(d.portfolioVolatility, 9);
    expect(d.portfolioVolatility).toBeCloseTo(
      portfolioVolatility(notional, cov),
      12,
    );
  });

  it("contribution shares sum to one", () => {
    const cov = threeNameCov();
    const d = riskContributions(
      { AAPL: 120_000, MSFT: 80_000, NVDA: 45_000 },
      cov,
    )!;
    const shares = d.contributions.reduce((a, c) => a + c.contributionShare, 0);
    expect(shares).toBeCloseTo(1, 9);
  });

  it("holds the summation identity when a leg is short", () => {
    const cov = threeNameCov();
    // A short leg contributes negatively; the identity must still close.
    const d = riskContributions(
      { AAPL: 120_000, MSFT: -90_000, NVDA: 30_000 },
      cov,
    )!;
    const total = d.contributions.reduce((a, c) => a + c.contribution, 0);
    expect(total).toBeCloseTo(d.portfolioVolatility, 9);
  });

  it("separates risk share from notional weight", () => {
    const cov = threeNameCov();
    // NVDA is the smallest position by notional but much the most volatile,
    // so its risk share should exceed its weight. This divergence is the
    // entire point of the metric.
    const d = riskContributions(
      { AAPL: 100_000, MSFT: 100_000, NVDA: 50_000 },
      cov,
    )!;
    const nvda = d.contributions.find((c) => c.ticker === "NVDA")!;
    expect(nvda.contributionShare).toBeGreaterThan(nvda.weight);
  });

  it("sorts by descending contribution", () => {
    const cov = threeNameCov();
    const d = riskContributions(
      { AAPL: 100_000, MSFT: 100_000, NVDA: 50_000 },
      cov,
    )!;
    const contribs = d.contributions.map((c) => c.contribution);
    expect(contribs).toEqual([...contribs].sort((a, b) => b - a));
  });

  it("returns null for a flat book rather than dividing by zero", () => {
    expect(riskContributions({}, threeNameCov())).toBeNull();
    expect(riskContributions({ AAPL: 0, MSFT: 0, NVDA: 0 }, threeNameCov()))
      .toBeNull();
  });

  it("returns null for a fully hedged book rather than infinities", () => {
    // Perfectly offsetting exposure on a single name drives sigma to zero.
    // The roadmap flags this as the case that blows up the division.
    const series: PriceSeries[] = [
      { ticker: "AAPL", dates: [], closes: walk(1, 120, 0, 0.012) },
    ];
    series[0].dates = series[0].closes.map((_, i) =>
      new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    );
    const aligned = alignSeries(series);
    const cov = covarianceMatrix(aligned.returns, aligned.tickers);

    const d = riskContributions({ AAPL: 0 }, cov);
    expect(d).toBeNull();
    // And every contribution stays finite in the near-hedged case.
    const nearlyHedged = riskContributions({ AAPL: 1e-4 }, cov);
    if (nearlyHedged) {
      for (const c of nearlyHedged.contributions) {
        expect(Number.isFinite(c.contribution)).toBe(true);
        expect(Number.isFinite(c.marginal)).toBe(true);
      }
    }
  });

  it("ignores tickers absent from the covariance matrix", () => {
    const cov = threeNameCov();
    // A position with no price history must not silently drop the others.
    const d = riskContributions(
      { AAPL: 100_000, MSFT: 50_000, NVDA: 25_000, UNKNOWN: 999_999 },
      cov,
    )!;
    expect(d.contributions.map((c) => c.ticker).sort()).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
    ]);
    const total = d.contributions.reduce((a, c) => a + c.contribution, 0);
    expect(total).toBeCloseTo(d.portfolioVolatility, 9);
  });
});

describe("concentration", () => {
  it("reports an even two-name book as fully diversified", () => {
    const c = concentration({ A: 5_000, B: 5_000 });
    expect(c.breakdown[0].weight).toBeCloseTo(0.5, 12);
    expect(c.herfindahl).toBeCloseTo(0.5, 12);
    expect(c.diversificationScore).toBeCloseTo(1, 12);
  });

  it("scores a single-name book at zero", () => {
    const c = concentration({ A: 10_000 });
    expect(c.herfindahl).toBeCloseTo(1, 12);
    expect(c.diversificationScore).toBe(0);
  });

  it("sorts the breakdown by descending weight", () => {
    const c = concentration({ A: 1_000, B: 9_000, C: 5_000 });
    expect(c.breakdown.map((b) => b.ticker)).toEqual(["B", "C", "A"]);
  });

  it("uses gross exposure so shorts still count as concentration", () => {
    const c = concentration({ A: 10_000, B: -10_000 });
    expect(c.breakdown[0].weight).toBeCloseTo(0.5, 12);
  });

  it("handles a flat book without dividing by zero", () => {
    const c = concentration({});
    expect(c.diversificationScore).toBe(0);
    expect(c.breakdown).toHaveLength(0);
  });
});

describe("annualizedVolatility", () => {
  it("scales daily volatility by sqrt(252)", () => {
    const daily = [0.01, -0.01, 0.02, -0.015, 0.005];
    expect(annualizedVolatility(daily)).toBeCloseTo(
      stdDev(daily) * Math.sqrt(252),
      12,
    );
  });
});
