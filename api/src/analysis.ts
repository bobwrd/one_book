/**
 * Composes the finance package into the single analysis payload the dashboard
 * renders. Kept server-side so the client does one round trip per book rather
 * than one per metric.
 */

import {
  alignSeries,
  bookExposure,
  concentration,
  correlationMatrix,
  covarianceMatrix,
  DEFAULT_RISK_FREE_RATE,
  historicalVar,
  parametricVar,
  payoffCurve,
  breakevens,
  portfolioVolatility,
  riskCallouts,
  runScenario,
  sharpeRatio,
  type MarketSnapshot,
  type Position,
  type PriceSeries,
} from "@onebook/finance";

export function analyzePortfolio(
  positions: Position[],
  spot: Record<string, number>,
  history: PriceSeries[],
  riskFreeRate = DEFAULT_RISK_FREE_RATE,
) {
  const market: MarketSnapshot = {
    spot,
    riskFreeRate,
    asOf: new Date().toISOString().slice(0, 10),
  };

  const exposure = bookExposure(positions, market);
  const conc = concentration(exposure.notionalByTicker);

  // Correlation needs at least two tickers with overlapping history. Below
  // that the matrix is meaningless, and VaR falls back to what it can compute.
  let correlation = null;
  let annualizedVol: number | null = null;
  let var95 = null;
  let var99 = null;
  let sharpe: number | null = null;

  const usable = history.filter((s) => s.closes.length >= 2);

  if (usable.length >= 1) {
    try {
      const aligned = alignSeries(usable);
      const cov = covarianceMatrix(aligned.returns, aligned.tickers);

      annualizedVol = portfolioVolatility(exposure.notionalByTicker, cov);
      var95 = parametricVar(exposure.notionalByTicker, cov, 0.95);
      var99 = parametricVar(exposure.notionalByTicker, cov, 0.99);
      sharpe = sharpeRatio(exposure.notionalByTicker, usable, riskFreeRate);

      if (usable.length >= 2) {
        const corr = correlationMatrix(aligned.returns, aligned.tickers);
        correlation = { tickers: corr.tickers, values: corr.values };
      }
    } catch {
      // Insufficient overlap; the exposure and Greeks below remain valid.
    }
  }

  let historicalVar95 = null;
  try {
    if (usable.length >= 1) {
      historicalVar95 = historicalVar(
        exposure.notionalByTicker,
        usable,
        0.95,
      );
    }
  } catch {
    // Historical VaR needs a longer overlapping window than parametric.
  }

  const curve = payoffCurve(positions, market, { steps: 121 });

  return {
    asOf: market.asOf,
    riskFreeRate,
    // Echoed back so the client never has to reverse-engineer spot from
    // notional/share ratios.
    spot,
    exposure: {
      byTicker: exposure.byTicker,
      notionalByTicker: exposure.notionalByTicker,
      grossNotional: exposure.grossNotional,
      netNotional: exposure.netNotional,
      marketValue: exposure.marketValue,
      positions: exposure.positions,
    },
    netGreeks: exposure.netGreeks,
    risk: {
      annualizedVolatility: annualizedVol,
      var95,
      var99,
      historicalVar95,
      sharpe,
      concentration: conc,
    },
    correlation,
    payoff: {
      curve,
      breakevens: breakevens(curve),
    },
    callouts: riskCallouts(positions, market, conc.breakdown),
    skipped: exposure.skipped,
  };
}

/** Recompute under a shock. Used by the scenario sliders. */
export function analyzeScenario(
  positions: Position[],
  spot: Record<string, number>,
  shock: { priceShock: number; volShock: number; daysForward: number },
  riskFreeRate = DEFAULT_RISK_FREE_RATE,
) {
  const market: MarketSnapshot = {
    spot,
    riskFreeRate,
    asOf: new Date().toISOString().slice(0, 10),
  };
  return runScenario(positions, market, shock);
}
