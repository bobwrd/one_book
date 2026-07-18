/**
 * Black-Scholes-Merton pricing and Greeks for European options.
 *
 * v1 prices everything as European, including single-name US equity options
 * that are contractually American. This overstates nothing for calls on
 * non-dividend payers (early exercise is never optimal) but does understate
 * deep-ITM American puts. The UI discloses this; binomial pricing is Phase 3.
 */

import type { Greeks, OptionRight } from "./types.js";
import { CALENDAR_DAYS_PER_YEAR } from "./types.js";

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF via Hart's rational approximation.
 * Accurate to roughly double precision across the full range, which matters
 * because the IV solver differentiates through this function.
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;

  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let d = z + 0.65;
      d = z + 4 / d;
      d = z + 3 / d;
      d = z + 2 / d;
      d = z + 1 / d;
      c = e / (d * 2.506628274631);
    }
  }

  return x > 0 ? 1 - c : c;
}

export interface BsInputs {
  /** Spot price of the underlying. */
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiry: number;
  /** Annualized volatility as a decimal. */
  volatility: number;
  /** Annualized risk-free rate as a decimal. */
  riskFreeRate: number;
  right: OptionRight;
  /** Continuous dividend yield as a decimal. */
  dividendYield?: number;
}

/**
 * At expiry, or with zero vol, the model degenerates and the standard formulas
 * divide by zero. Both cases have well-defined limits, so handle them
 * explicitly rather than letting NaN propagate into the whole book.
 */
function isDegenerate(i: BsInputs): boolean {
  return i.timeToExpiry <= 0 || i.volatility <= 0 || i.spot <= 0;
}

function intrinsic(spot: number, strike: number, right: OptionRight): number {
  return right === "call"
    ? Math.max(0, spot - strike)
    : Math.max(0, strike - spot);
}

function d1d2(i: BsInputs): { d1: number; d2: number; sqrtT: number } {
  const q = i.dividendYield ?? 0;
  const sqrtT = Math.sqrt(i.timeToExpiry);
  const d1 =
    (Math.log(i.spot / i.strike) +
      (i.riskFreeRate - q + (i.volatility * i.volatility) / 2) *
        i.timeToExpiry) /
    (i.volatility * sqrtT);
  return { d1, d2: d1 - i.volatility * sqrtT, sqrtT };
}

/** Theoretical value of one share-unit of the option (not per contract). */
export function bsPrice(i: BsInputs): number {
  if (isDegenerate(i)) return intrinsic(i.spot, i.strike, i.right);

  const q = i.dividendYield ?? 0;
  const { d1, d2 } = d1d2(i);
  const dfR = Math.exp(-i.riskFreeRate * i.timeToExpiry);
  const dfQ = Math.exp(-q * i.timeToExpiry);

  return i.right === "call"
    ? i.spot * dfQ * normCdf(d1) - i.strike * dfR * normCdf(d2)
    : i.strike * dfR * normCdf(-d2) - i.spot * dfQ * normCdf(-d1);
}

/**
 * Greeks for one share-unit. Theta is per calendar day and vega/rho are per
 * percentage point, because those are the units traders actually read.
 */
export function bsGreeks(i: BsInputs): Greeks {
  if (isDegenerate(i)) {
    // At expiry delta is a step function; everything else collapses to zero.
    const itm =
      i.right === "call" ? i.spot > i.strike : i.spot < i.strike;
    const sign = i.right === "call" ? 1 : -1;
    return {
      delta: itm ? sign : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }

  const q = i.dividendYield ?? 0;
  const { d1, d2, sqrtT } = d1d2(i);
  const dfR = Math.exp(-i.riskFreeRate * i.timeToExpiry);
  const dfQ = Math.exp(-q * i.timeToExpiry);
  const pdfD1 = normPdf(d1);

  const gamma = (dfQ * pdfD1) / (i.spot * i.volatility * sqrtT);
  const vegaPerUnitVol = i.spot * dfQ * pdfD1 * sqrtT;

  // Shared decay term, then the carry terms differ by right.
  const decay = -(i.spot * dfQ * pdfD1 * i.volatility) / (2 * sqrtT);

  let delta: number;
  let thetaPerYear: number;
  let rhoPerUnitRate: number;

  if (i.right === "call") {
    delta = dfQ * normCdf(d1);
    thetaPerYear =
      decay -
      i.riskFreeRate * i.strike * dfR * normCdf(d2) +
      q * i.spot * dfQ * normCdf(d1);
    rhoPerUnitRate = i.strike * i.timeToExpiry * dfR * normCdf(d2);
  } else {
    delta = dfQ * (normCdf(d1) - 1);
    thetaPerYear =
      decay +
      i.riskFreeRate * i.strike * dfR * normCdf(-d2) -
      q * i.spot * dfQ * normCdf(-d1);
    rhoPerUnitRate = -i.strike * i.timeToExpiry * dfR * normCdf(-d2);
  }

  return {
    delta,
    gamma,
    theta: thetaPerYear / CALENDAR_DAYS_PER_YEAR,
    vega: vegaPerUnitVol / 100,
    rho: rhoPerUnitRate / 100,
  };
}

export class ImpliedVolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpliedVolError";
  }
}

/**
 * Solve implied volatility from a market price.
 *
 * Newton-Raphson converges fast near the money but stalls where vega is tiny,
 * so this falls back to bisection on a bracketed range rather than returning a
 * garbage root.
 *
 * Deep in-the-money options are the hard case: vega is near zero there, so a
 * wide range of volatilities reproduce the same price to within any sane
 * tolerance and the root is numerically unrecoverable. Since a call and a put
 * at the same strike share one implied volatility, we solve the out-of-the-
 * money counterpart instead — same answer, well-conditioned problem.
 */
export function impliedVolatility(
  marketPrice: number,
  i: Omit<BsInputs, "volatility">,
  opts: { tolerance?: number; maxIterations?: number } = {},
): number {
  const tolerance = opts.tolerance ?? 1e-8;
  const maxIterations = opts.maxIterations ?? 100;

  if (i.timeToExpiry <= 0) {
    throw new ImpliedVolError("Cannot solve implied volatility at expiry.");
  }

  const q = i.dividendYield ?? 0;
  const discountedSpot = i.spot * Math.exp(-q * i.timeToExpiry);
  const discountedStrike = i.strike * Math.exp(-i.riskFreeRate * i.timeToExpiry);

  // European no-arbitrage bounds. Note this is NOT discounted intrinsic value:
  // a European put can legitimately trade below intrinsic (which is exactly
  // why early exercise carries value for American puts), so using discounted
  // intrinsic here would reject perfectly valid ITM put quotes.
  const lowerBound =
    i.right === "call"
      ? Math.max(0, discountedSpot - discountedStrike)
      : Math.max(0, discountedStrike - discountedSpot);
  const upperBound = i.right === "call" ? discountedSpot : discountedStrike;

  if (marketPrice < lowerBound - tolerance) {
    throw new ImpliedVolError(
      `Price ${marketPrice} is below the no-arbitrage floor ${lowerBound.toFixed(4)}; no volatility reproduces it.`,
    );
  }
  if (marketPrice > upperBound + tolerance) {
    throw new ImpliedVolError(
      `Price ${marketPrice} exceeds the no-arbitrage ceiling ${upperBound.toFixed(4)}; check the inputs.`,
    );
  }

  // All of an option's volatility information lives in its time value — the
  // amount above the no-arbitrage floor. When that is negligible so is vega,
  // and a wide band of volatilities reproduces the same price to any sane
  // tolerance. This covers both deep-ITM and deep-OTM legs. Refuse rather
  // than return a confident-looking but arbitrary number.
  const timeValue = marketPrice - lowerBound;
  if (timeValue <= tolerance) {
    throw new ImpliedVolError(
      "Option carries no meaningful time value; implied volatility is not recoverable.",
    );
  }

  // Reflect an ITM option onto its OTM twin through put-call parity:
  //   C - P = S*e^(-qT) - K*e^(-rT)
  // Both share one implied volatility, and the OTM side is the numerically
  // well-conditioned one.
  const isItm = i.right === "call" ? i.spot > i.strike : i.spot < i.strike;
  if (isItm) {
    const forward = discountedSpot - discountedStrike;
    const flippedRight: OptionRight = i.right === "call" ? "put" : "call";
    const flippedPrice =
      i.right === "call" ? marketPrice - forward : marketPrice + forward;

    return impliedVolatility(
      flippedPrice,
      { ...i, right: flippedRight },
      opts,
    );
  }

  const MIN_VOL = 1e-6;
  const MAX_VOL = 10;

  // Newton first, seeded with a rough Brenner-Subrahmanyam style guess.
  let vol = Math.max(
    0.1,
    Math.sqrt((2 * Math.PI) / i.timeToExpiry) * (marketPrice / i.spot),
  );

  for (let n = 0; n < maxIterations; n++) {
    const inputs = { ...i, volatility: vol };
    const diff = bsPrice(inputs) - marketPrice;
    if (Math.abs(diff) < tolerance) return vol;

    const vegaPerUnitVol = bsGreeks(inputs).vega * 100;
    if (vegaPerUnitVol < 1e-10) break; // Stalled — hand off to bisection.

    const next = vol - diff / vegaPerUnitVol;
    if (!Number.isFinite(next) || next <= MIN_VOL || next >= MAX_VOL) break;
    vol = next;
  }

  // Bisection fallback: slower but cannot diverge.
  let lo = MIN_VOL;
  let hi = MAX_VOL;
  if (bsPrice({ ...i, volatility: hi }) < marketPrice) {
    throw new ImpliedVolError(
      `Price ${marketPrice} exceeds the model maximum; check the inputs.`,
    );
  }

  for (let n = 0; n < maxIterations * 2; n++) {
    const mid = (lo + hi) / 2;
    const diff = bsPrice({ ...i, volatility: mid }) - marketPrice;
    if (Math.abs(diff) < tolerance || hi - lo < tolerance) return mid;
    if (diff > 0) hi = mid;
    else lo = mid;
  }

  return (lo + hi) / 2;
}

/** Year fraction between two ISO dates, floored at zero. */
export function yearsToExpiry(asOf: string, expiry: string): number {
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const end = Date.parse(`${expiry}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`Invalid date pair: asOf=${asOf} expiry=${expiry}`);
  }
  const days = (end - start) / 86_400_000;
  return Math.max(0, days / CALENDAR_DAYS_PER_YEAR);
}
