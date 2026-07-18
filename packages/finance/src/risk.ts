/**
 * Portfolio risk metrics computed over delta-equivalent exposure.
 *
 * Every function here takes notional exposure per ticker rather than raw
 * positions, which is what lets a mixed stock/option book be measured with
 * ordinary portfolio math.
 */

import {
  alignSeries,
  annualizedVolatility,
  covarianceMatrix,
  logReturns,
  mean,
  type Matrix,
  type PriceSeries,
} from "./stats.js";
import { TRADING_DAYS_PER_YEAR } from "./types.js";

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError(`normInv requires 0 < p < 1, received ${p}.`);
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Annualized portfolio volatility: sqrt(wᵀ Σ w), where w is signed notional
 * exposure in dollars. Using dollar weights rather than percentage weights
 * keeps the result meaningful when the book is net short or leveraged, where
 * percentage weights are ill-defined.
 */
export function portfolioVolatility(
  notionalByTicker: Record<string, number>,
  cov: Matrix,
): number {
  const w = cov.tickers.map((t) => notionalByTicker[t] ?? 0);
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < w.length; j++) {
      acc += w[i] * w[j] * cov.values[i][j];
    }
  }
  // Numerical noise can push a near-zero (fully hedged) book slightly negative.
  return Math.sqrt(Math.max(0, acc));
}

export interface VarResult {
  /** Positive dollar loss figure. */
  value: number;
  confidence: number;
  horizonDays: number;
  method: "parametric" | "historical";
}

/**
 * Parametric (variance-covariance) VaR.
 *
 * Assumes normally distributed returns, which understates tail risk for an
 * options book with meaningful gamma. Historical VaR is reported alongside it
 * for exactly this reason.
 */
export function parametricVar(
  notionalByTicker: Record<string, number>,
  cov: Matrix,
  confidence = 0.95,
  horizonDays = 1,
): VarResult {
  const annualVol = portfolioVolatility(notionalByTicker, cov);
  const horizonVol = annualVol * Math.sqrt(horizonDays / TRADING_DAYS_PER_YEAR);
  const z = normInv(confidence);
  return {
    value: Math.max(0, z * horizonVol),
    confidence,
    horizonDays,
    method: "parametric",
  };
}

/**
 * Historical simulation VaR: replay each past day's actual returns against
 * today's exposure and read the loss percentile off the empirical distribution.
 * Makes no distributional assumption, so it captures fat tails the parametric
 * method misses.
 */
export function historicalVar(
  notionalByTicker: Record<string, number>,
  series: PriceSeries[],
  confidence = 0.95,
): VarResult & { sampleSize: number } {
  const aligned = alignSeries(series);
  const n = aligned.dates.length - 1;

  const pnl: number[] = [];
  for (let day = 0; day < n; day++) {
    let dayPnl = 0;
    for (const ticker of aligned.tickers) {
      const exposure = notionalByTicker[ticker] ?? 0;
      // Log return -> simple return, since P&L scales with the simple return.
      dayPnl += exposure * (Math.exp(aligned.returns[ticker][day]) - 1);
    }
    pnl.push(dayPnl);
  }

  pnl.sort((a, b) => a - b);
  const index = Math.min(
    pnl.length - 1,
    Math.max(0, Math.floor((1 - confidence) * pnl.length)),
  );

  return {
    value: pnl.length === 0 ? 0 : Math.max(0, -pnl[index]),
    confidence,
    horizonDays: 1,
    method: "historical",
    sampleSize: pnl.length,
  };
}

/**
 * Annualized Sharpe ratio from the book's own historical return series.
 * Returns null rather than a misleading number when the book has no variance.
 */
export function sharpeRatio(
  notionalByTicker: Record<string, number>,
  series: PriceSeries[],
  riskFreeRate: number,
): number | null {
  const aligned = alignSeries(series);
  const totalNotional = Object.values(notionalByTicker).reduce(
    (a, b) => a + Math.abs(b),
    0,
  );
  if (totalNotional === 0) return null;

  const n = aligned.dates.length - 1;
  const portfolioReturns: number[] = [];
  for (let day = 0; day < n; day++) {
    let dayPnl = 0;
    for (const ticker of aligned.tickers) {
      const exposure = notionalByTicker[ticker] ?? 0;
      dayPnl += exposure * (Math.exp(aligned.returns[ticker][day]) - 1);
    }
    portfolioReturns.push(dayPnl / totalNotional);
  }

  const vol = annualizedVolatility(portfolioReturns);
  if (vol === 0) return null;

  const annualReturn = mean(portfolioReturns) * TRADING_DAYS_PER_YEAR;
  return (annualReturn - riskFreeRate) / vol;
}

export interface ConcentrationBreakdown {
  ticker: string;
  notional: number;
  /** Share of gross notional, 0-1. */
  weight: number;
}

/**
 * Concentration by gross notional, plus a Herfindahl-based diversification
 * score in [0,1] where 1 is perfectly even and 0 is a single-name book.
 */
export function concentration(notionalByTicker: Record<string, number>): {
  breakdown: ConcentrationBreakdown[];
  herfindahl: number;
  diversificationScore: number;
} {
  const entries = Object.entries(notionalByTicker);
  const gross = entries.reduce((a, [, v]) => a + Math.abs(v), 0);

  if (gross === 0) {
    return { breakdown: [], herfindahl: 0, diversificationScore: 0 };
  }

  const breakdown = entries
    .map(([ticker, notional]) => ({
      ticker,
      notional,
      weight: Math.abs(notional) / gross,
    }))
    .sort((a, b) => b.weight - a.weight);

  const herfindahl = breakdown.reduce((a, b) => a + b.weight ** 2, 0);
  const n = breakdown.length;
  // Normalize so an even n-name book scores 1 regardless of n.
  const diversificationScore =
    n <= 1 ? 0 : (1 - herfindahl) / (1 - 1 / n);

  return { breakdown, herfindahl, diversificationScore };
}

export { logReturns, covarianceMatrix };
