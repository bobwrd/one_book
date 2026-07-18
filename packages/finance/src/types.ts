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
}

export type Position = StockPosition | OptionPosition;

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
