/**
 * Scenario engine — the app's centerpiece.
 *
 * Shocks the book along three axes (price, implied vol, time) and fully
 * reprices every position. This is a genuine reprice, not a delta/gamma
 * approximation, so a -30% shock on a short-gamma book shows the real
 * convexity rather than a tangent-line estimate.
 */

import { bsPrice, yearsToExpiry } from "./blackScholes.js";
import { bookExposure } from "./exposure.js";
import type {
  MarketSnapshot,
  OptionPosition,
  Position,
} from "./types.js";
import { isBond, isOption } from "./types.js";

export interface Shock {
  /** Fractional move in every underlying. 0.10 = +10%. */
  priceShock: number;
  /** Additive shift in implied vol, in vol points. 0.05 = +5 vol points. */
  volShock: number;
  /** Calendar days forward, for theta decay. */
  daysForward: number;
}

export const NO_SHOCK: Shock = {
  priceShock: 0,
  volShock: 0,
  daysForward: 0,
};

/** Apply a shock to a market snapshot, producing the shocked market. */
export function shockMarket(
  market: MarketSnapshot,
  shock: Shock,
): MarketSnapshot {
  const spot: Record<string, number> = {};
  for (const [ticker, price] of Object.entries(market.spot)) {
    spot[ticker] = price * (1 + shock.priceShock);
  }

  const asOf = shock.daysForward
    ? addDays(market.asOf, shock.daysForward)
    : market.asOf;

  return { ...market, spot, asOf };
}

export function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${isoDate}`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Apply a vol shock to an option leg, floored just above zero.
 * A negative vol is meaningless, and a zero vol makes the pricer degenerate
 * to intrinsic, which reads as a bug in the UI rather than a modeling choice.
 */
function shockedIv(position: OptionPosition, shock: Shock): number {
  return Math.max(0.001, position.iv + shock.volShock);
}

/** Value one position under a given market. */
export function valuePosition(
  position: Position,
  market: MarketSnapshot,
  shock: Shock = NO_SHOCK,
): number {
  // A bond holds constant under every shock. The three sliders model equity and
  // option dynamics — price, implied vol, time to expiry — and a bond's mark is
  // not a function of an equity price shock. Keeping it flat means Scenario P&L
  // is attributable entirely to the stock and option legs, which is what the
  // sliders actually simulate. This also resolves before the spot lookup: no
  // provider quotes bonds, so requiring a spot would skip the position.
  if (isBond(position)) {
    const fxRate = market.fxRates?.[position.currency] ?? 1;
    return (position.faceValue * (position.price / 100)) / fxRate;
  }

  const spot = market.spot[position.ticker];
  if (spot === undefined) {
    throw new Error(`No spot price for ${position.ticker}.`);
  }

  if (!isOption(position)) return position.quantity * spot;

  const perShare = bsPrice({
    spot,
    strike: position.strike,
    timeToExpiry: yearsToExpiry(market.asOf, position.expiry),
    volatility: shockedIv(position, shock),
    riskFreeRate: market.riskFreeRate,
    right: position.right,
  });
  return perShare * position.quantity * position.contractMultiplier;
}

export interface PositionScenarioResult {
  positionId: string;
  ticker: string;
  baseValue: number;
  shockedValue: number;
  pnl: number;
}

export interface ScenarioResult {
  shock: Shock;
  positions: PositionScenarioResult[];
  baseValue: number;
  shockedValue: number;
  /** Total P&L in dollars. */
  pnl: number;
  /** P&L as a fraction of the base book value, or null if the book is flat. */
  pnlPercent: number | null;
  /** Greeks recomputed under the shocked market. */
  shockedGreeks: ReturnType<typeof bookExposure>["netGreeks"];
  skipped: { positionId: string; reason: string }[];
}

/** Reprice the whole book under one shock. */
export function runScenario(
  positions: Position[],
  market: MarketSnapshot,
  shock: Shock,
): ScenarioResult {
  const shocked = shockMarket(market, shock);
  const results: PositionScenarioResult[] = [];
  const skipped: { positionId: string; reason: string }[] = [];

  for (const p of positions) {
    try {
      const baseValue = valuePosition(p, market, NO_SHOCK);
      const shockedValue = valuePosition(p, shocked, shock);
      results.push({
        positionId: p.id,
        ticker: p.ticker,
        baseValue,
        shockedValue,
        pnl: shockedValue - baseValue,
      });
    } catch (err) {
      skipped.push({
        positionId: p.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const baseValue = results.reduce((a, r) => a + r.baseValue, 0);
  const shockedValue = results.reduce((a, r) => a + r.shockedValue, 0);

  // Shocked Greeks need the shocked IV baked into the positions themselves,
  // since Greeks are a function of vol, not just of spot and time.
  const shockedPositions = positions.map((p) =>
    isOption(p) ? { ...p, iv: shockedIv(p, shock) } : p,
  );
  const exposure = bookExposure(shockedPositions, shocked);

  return {
    shock,
    positions: results,
    baseValue,
    shockedValue,
    pnl: shockedValue - baseValue,
    pnlPercent:
      Math.abs(baseValue) < 1e-9 ? null : (shockedValue - baseValue) / Math.abs(baseValue),
    shockedGreeks: exposure.netGreeks,
    skipped,
  };
}

export interface PayoffPoint {
  /** Fractional price move from spot. */
  priceShock: number;
  /** Absolute price level for the reference underlying. */
  price: number;
  pnl: number;
}

/**
 * Sweep the price axis to build the combined payoff curve.
 *
 * `referenceTicker` only sets the x-axis price labels; the shock is applied
 * to every underlying, since the curve represents a market-wide move.
 */
export function payoffCurve(
  positions: Position[],
  market: MarketSnapshot,
  opts: {
    referenceTicker?: string;
    minShock?: number;
    maxShock?: number;
    steps?: number;
    volShock?: number;
    daysForward?: number;
  } = {},
): PayoffPoint[] {
  const minShock = opts.minShock ?? -0.3;
  const maxShock = opts.maxShock ?? 0.3;
  const steps = opts.steps ?? 121;
  const reference =
    opts.referenceTicker ?? positions[0]?.ticker ?? Object.keys(market.spot)[0];
  const referenceSpot = reference ? (market.spot[reference] ?? 0) : 0;

  const points: PayoffPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const priceShock =
      minShock + ((maxShock - minShock) * i) / Math.max(1, steps - 1);
    const result = runScenario(positions, market, {
      priceShock,
      volShock: opts.volShock ?? 0,
      daysForward: opts.daysForward ?? 0,
    });
    points.push({
      priceShock,
      price: referenceSpot * (1 + priceShock),
      pnl: result.pnl,
    });
  }
  return points;
}

/**
 * Find where the payoff curve crosses zero, by linear interpolation between
 * adjacent sample points. Resolution is bounded by the curve's step count.
 */
export function breakevens(curve: PayoffPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.pnl === 0) out.push(a.price);
    else if ((a.pnl < 0 && b.pnl > 0) || (a.pnl > 0 && b.pnl < 0)) {
      const t = -a.pnl / (b.pnl - a.pnl);
      out.push(a.price + t * (b.price - a.price));
    }
  }
  return out;
}

export interface RiskCallout {
  severity: "info" | "warning" | "critical";
  label: string;
  detail: string;
}

/**
 * Plain-English risk observations. These are descriptive readings of the
 * book's own numbers, never recommendations — the disclaimer depends on that
 * distinction holding.
 */
export function riskCallouts(
  positions: Position[],
  market: MarketSnapshot,
  concentrationBreakdown: { ticker: string; weight: number }[],
): RiskCallout[] {
  const out: RiskCallout[] = [];
  const { netGreeks } = bookExposure(positions, market);

  if (netGreeks.gamma < -0.5) {
    out.push({
      severity: "critical",
      label: "Net short gamma",
      detail:
        "Losses accelerate as the underlying moves in either direction. The payoff curve bends against you.",
    });
  } else if (netGreeks.gamma > 0.5) {
    out.push({
      severity: "info",
      label: "Net long gamma",
      detail: "Gains accelerate on large moves in either direction.",
    });
  }

  if (netGreeks.theta < -1) {
    out.push({
      severity: "warning",
      label: `Theta bleed ${formatUsd(netGreeks.theta)}/day`,
      detail:
        "The book loses this much per calendar day from time decay alone, holding price and vol fixed.",
    });
  } else if (netGreeks.theta > 1) {
    out.push({
      severity: "info",
      label: `Theta income ${formatUsd(netGreeks.theta)}/day`,
      detail: "Time decay works in your favor at current levels.",
    });
  }

  const top = concentrationBreakdown[0];
  if (top && top.weight > 0.4) {
    out.push({
      severity: top.weight > 0.6 ? "critical" : "warning",
      label: `${Math.round(top.weight * 100)}% concentrated in ${top.ticker}`,
      detail:
        "A single underlying dominates gross exposure, so diversification benefits are limited.",
    });
  }

  const expiringSoon = positions.filter(
    (p) => isOption(p) && yearsToExpiry(market.asOf, p.expiry) * 365 <= 7,
  );
  if (expiringSoon.length > 0) {
    out.push({
      severity: "warning",
      label: `${expiringSoon.length} position(s) expiring within 7 days`,
      detail:
        "Gamma and theta both spike near expiry; small price moves produce outsized swings.",
    });
  }

  return out;
}

function formatUsd(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
