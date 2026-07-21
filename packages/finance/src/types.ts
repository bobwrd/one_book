/** Shared domain types for the OneBook risk engine. */

export type OptionRight = "call" | "put";

/** A long or short holding of shares in a single underlying. */
export interface StockPosition {
  id: string;
  type: "stock";
  ticker: string;
  /** Signed. Negative means short. */
  quantity: number;
  costBasis: number;
  /** ISO 4217. Absent means USD. */
  currency?: string;
}

/**
 * A single option leg. `quantity` is in contracts and is signed:
 * negative means short (written). Contract multiplier is separate so
 * non-standard (adjusted) contracts can be represented.
 */
export interface OptionPosition {
  id: string;
  type: "option";
  ticker: string;
  right: OptionRight;
  strike: number;
  /** ISO date, YYYY-MM-DD. */
  expiry: string;
  quantity: number;
  contractMultiplier: number;
  costBasis: number;
  /**
   * Implied volatility as a decimal (0.30 = 30%). When this came from the
   * user rather than a broker quote, `ivIsEstimate` is true and the UI marks
   * every dependent Greek as an estimate.
   */
  iv: number;
  ivIsEstimate: boolean;
  /** ISO 4217. Absent means USD. */
  currency?: string;
}

/**
 * A bond holding. Sized by face amount rather than a share count, which is how
 * bonds actually trade — `quantity` has no meaning here.
 *
 * Unlike stocks and options, a bond carries its own mark: no market-data
 * provider in OneBook quotes bonds, so `price` is the only valuation input.
 */
export interface BondPosition {
  id: string;
  type: "bond";
  ticker: string;
  /** Signed: negative means short. */
  faceValue: number;
  /** Annual, as a decimal. 0.0425 = 4.25%. */
  couponRate: number;
  /** ISO date, YYYY-MM-DD. */
  maturity: string;
  /** Per 100 par, e.g. 96.59 — the position's own mark. */
  price: number;
  /** Per 100 par, at purchase. */
  costBasis: number;
  /**
   * ISO 4217. Required, unlike on stocks and options: a foreign-denominated
   * bond is the case this field exists for.
   */
  currency: string;
}

export type Position = StockPosition | OptionPosition | BondPosition;

export interface Greeks {
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1 percentage point of implied vol. */
  vega: number;
  /** Per 1 percentage point of rates. */
  rho: number;
}

export const ZERO_GREEKS: Greeks = {
  delta: 0,
  gamma: 0,
  theta: 0,
  vega: 0,
  rho: 0,
};

/** Market inputs needed to value the book at a point in time. */
export interface MarketSnapshot {
  /** Spot price per ticker. */
  spot: Record<string, number>;
  /** Annualized risk-free rate as a decimal. Configurable constant in v1. */
  riskFreeRate: number;
  /** Valuation date, ISO YYYY-MM-DD. Drives time-to-expiry. */
  asOf: string;
  /**
   * Quote currency per 1 USD, e.g. `{ EUR: 0.92 }`. Divide a foreign-currency
   * amount by the rate to get USD. Absent means treat everything as USD.
   */
  fxRates?: Record<string, number>;
}

export const TRADING_DAYS_PER_YEAR = 252;
export const CALENDAR_DAYS_PER_YEAR = 365;
export const DEFAULT_RISK_FREE_RATE = 0.04;
export const DEFAULT_CONTRACT_MULTIPLIER = 100;

export function isOption(p: Position): p is OptionPosition {
  return p.type === "option";
}

export function isStock(p: Position): p is StockPosition {
  return p.type === "stock";
}

export function isBond(p: Position): p is BondPosition {
  return p.type === "bond";
}
