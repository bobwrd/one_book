/** Return series, covariance, and correlation from historical prices. */

import { TRADING_DAYS_PER_YEAR } from "./types.js";

/** A ticker's historical closes, oldest first. */
export interface PriceSeries {
  ticker: string;
  /** Parallel arrays; `dates[i]` is the date of `closes[i]`. */
  dates: string[];
  closes: number[];
}

export class InsufficientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientDataError";
  }
}

/**
 * Daily log returns. Log rather than simple returns because they aggregate
 * additively over time, which the scenario engine relies on.
 */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (prev <= 0 || curr <= 0) {
      throw new InsufficientDataError(
        "Non-positive close price; cannot take log returns.",
      );
    }
    out.push(Math.log(curr / prev));
  }
  return out;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample variance (Bessel-corrected). */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
}

export function stdDev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

export function covariance(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length) {
    throw new InsufficientDataError(
      `Series length mismatch: ${xs.length} vs ${ys.length}.`,
    );
  }
  if (xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) acc += (xs[i] - mx) * (ys[i] - my);
  return acc / (xs.length - 1);
}

export function correlation(xs: number[], ys: number[]): number {
  const sx = stdDev(xs);
  const sy = stdDev(ys);
  // A constant series has no correlation with anything; report 0, not NaN.
  if (sx === 0 || sy === 0) return 0;
  return covariance(xs, ys) / (sx * sy);
}

/**
 * Align several price series onto the dates they all share.
 *
 * Tickers listed on different exchanges, or added mid-history, will not have
 * identical date coverage. Intersecting first means the covariance matrix is
 * always built from genuinely contemporaneous observations.
 */
export function alignSeries(series: PriceSeries[]): {
  tickers: string[];
  dates: string[];
  returns: Record<string, number[]>;
} {
  if (series.length === 0) {
    return { tickers: [], dates: [], returns: {} };
  }

  let shared: string[] = series[0].dates.slice();
  for (const s of series.slice(1)) {
    const set = new Set(s.dates);
    shared = shared.filter((d) => set.has(d));
  }
  shared.sort();

  if (shared.length < 2) {
    throw new InsufficientDataError(
      `Only ${shared.length} overlapping date(s) across ${series.length} tickers; need at least 2.`,
    );
  }

  const returns: Record<string, number[]> = {};
  for (const s of series) {
    const index = new Map(s.dates.map((d, i) => [d, i]));
    const closes = shared.map((d) => s.closes[index.get(d)!]);
    returns[s.ticker] = logReturns(closes);
  }

  return {
    tickers: series.map((s) => s.ticker),
    dates: shared,
    returns,
  };
}

export interface Matrix {
  tickers: string[];
  /** Row-major; `values[i][j]` pairs `tickers[i]` with `tickers[j]`. */
  values: number[][];
}

/** Annualized covariance matrix from aligned daily returns. */
export function covarianceMatrix(
  returns: Record<string, number[]>,
  tickers: string[],
): Matrix {
  const values = tickers.map((a) =>
    tickers.map((b) =>
      covariance(returns[a], returns[b]) * TRADING_DAYS_PER_YEAR,
    ),
  );
  return { tickers, values };
}

export function correlationMatrix(
  returns: Record<string, number[]>,
  tickers: string[],
): Matrix {
  const values = tickers.map((a) =>
    tickers.map((b) => (a === b ? 1 : correlation(returns[a], returns[b]))),
  );
  return { tickers, values };
}

/** Annualized volatility of a single return series. */
export function annualizedVolatility(dailyReturns: number[]): number {
  return stdDev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}
