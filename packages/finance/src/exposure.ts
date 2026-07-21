/**
 * Delta-equivalent exposure — the idea that ties OneBook together.
 *
 * Every option leg is translated into the number of underlying shares that
 * would carry the same first-order price risk. Once stocks and options are
 * both expressed as share-equivalents, one exposure vector feeds the
 * covariance matrix, portfolio volatility, and VaR. A covered call correctly
 * nets down against its stock, which is exactly what most retail tools miss.
 *
 * The translation is first-order only: it is accurate for small moves and
 * degrades as gamma bites. The scenario engine (scenario.ts) does a full
 * reprice instead, so large shocks are never approximated this way.
 */

import { bsGreeks, bsPrice, yearsToExpiry } from "./blackScholes.js";
import type {
  Greeks,
  MarketSnapshot,
  OptionPosition,
  Position,
} from "./types.js";
import { ZERO_GREEKS, isBond, isOption } from "./types.js";

export interface PositionExposure {
  positionId: string;
  ticker: string;
  /** Signed share-equivalents. */
  shareEquivalents: number;
  /** Signed notional at current spot. */
  notional: number;
  /** Book-level Greeks, already scaled by quantity and multiplier. */
  greeks: Greeks;
  marketValue: number;
}

export interface BookExposure {
  positions: PositionExposure[];
  /** Net share-equivalents keyed by ticker. */
  byTicker: Record<string, number>;
  /** Net notional exposure keyed by ticker. */
  notionalByTicker: Record<string, number>;
  netGreeks: Greeks;
  grossNotional: number;
  netNotional: number;
  marketValue: number;
}

export class MissingPriceError extends Error {
  constructor(public readonly ticker: string) {
    super(`No spot price available for ${ticker}.`);
    this.name = "MissingPriceError";
  }
}

function optionGreeksPerShare(
  position: OptionPosition,
  market: MarketSnapshot,
): Greeks {
  const spot = market.spot[position.ticker];
  if (spot === undefined) throw new MissingPriceError(position.ticker);

  return bsGreeks({
    spot,
    strike: position.strike,
    timeToExpiry: yearsToExpiry(market.asOf, position.expiry),
    volatility: position.iv,
    riskFreeRate: market.riskFreeRate,
    right: position.right,
  });
}

function scaleGreeks(g: Greeks, factor: number): Greeks {
  return {
    delta: g.delta * factor,
    gamma: g.gamma * factor,
    theta: g.theta * factor,
    vega: g.vega * factor,
    rho: g.rho * factor,
  };
}

function addGreeks(a: Greeks, b: Greeks): Greeks {
  return {
    delta: a.delta + b.delta,
    gamma: a.gamma + b.gamma,
    theta: a.theta + b.theta,
    vega: a.vega + b.vega,
    rho: a.rho + b.rho,
  };
}

/**
 * Translate one position into share-equivalent exposure.
 *
 * A stock position is trivially its own share count (delta 1.0). An option
 * leg is `delta x contracts x multiplier`, signed by the position direction.
 */
export function positionExposure(
  position: Position,
  market: MarketSnapshot,
): PositionExposure {
  // Bonds resolve before the spot lookup on purpose: no market-data provider
  // quotes them, so the position's own mark is the only valuation input and a
  // missing spot must not skip the position.
  if (isBond(position)) {
    const fxRate = market.fxRates?.[position.currency] ?? 1; // quote per 1 USD
    const markPer100 = market.spot[position.ticker] ?? position.price;
    const notionalLocal = position.faceValue * (markPer100 / 100);
    const notionalUsd = notionalLocal / fxRate;
    return {
      positionId: position.id,
      ticker: position.ticker,
      // "Delta-equivalent shares of an underlying" has no meaning for a bond.
      shareEquivalents: 0,
      notional: notionalUsd,
      greeks: ZERO_GREEKS,
      marketValue: notionalUsd,
    };
  }

  const spot = market.spot[position.ticker];
  if (spot === undefined) throw new MissingPriceError(position.ticker);

  if (!isOption(position)) {
    return {
      positionId: position.id,
      ticker: position.ticker,
      shareEquivalents: position.quantity,
      notional: position.quantity * spot,
      greeks: { ...ZERO_GREEKS, delta: position.quantity },
      marketValue: position.quantity * spot,
    };
  }

  const perShare = optionGreeksPerShare(position, market);
  const scale = position.quantity * position.contractMultiplier;
  const shareEquivalents = perShare.delta * scale;

  return {
    positionId: position.id,
    ticker: position.ticker,
    shareEquivalents,
    notional: shareEquivalents * spot,
    greeks: scaleGreeks(perShare, scale),
    marketValue: optionMarketValue(position, market),
  };
}

/** Theoretical market value of an option leg, signed by direction. */
export function optionMarketValue(
  position: OptionPosition,
  market: MarketSnapshot,
): number {
  const spot = market.spot[position.ticker];
  if (spot === undefined) throw new MissingPriceError(position.ticker);

  const perShare = bsPrice({
    spot,
    strike: position.strike,
    timeToExpiry: yearsToExpiry(market.asOf, position.expiry),
    volatility: position.iv,
    riskFreeRate: market.riskFreeRate,
    right: position.right,
  });
  return perShare * position.quantity * position.contractMultiplier;
}

/**
 * Roll the whole book up into one exposure view.
 *
 * Positions whose ticker has no price are skipped and reported rather than
 * throwing, so one bad symbol cannot blank the entire dashboard.
 */
export function bookExposure(
  positions: Position[],
  market: MarketSnapshot,
): BookExposure & { skipped: { positionId: string; reason: string }[] } {
  const exposures: PositionExposure[] = [];
  const skipped: { positionId: string; reason: string }[] = [];

  for (const p of positions) {
    try {
      exposures.push(positionExposure(p, market));
    } catch (err) {
      skipped.push({
        positionId: p.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const byTicker: Record<string, number> = {};
  const notionalByTicker: Record<string, number> = {};
  let netGreeks = { ...ZERO_GREEKS };
  let grossNotional = 0;
  let netNotional = 0;
  let marketValue = 0;

  for (const e of exposures) {
    byTicker[e.ticker] = (byTicker[e.ticker] ?? 0) + e.shareEquivalents;
    notionalByTicker[e.ticker] =
      (notionalByTicker[e.ticker] ?? 0) + e.notional;
    netGreeks = addGreeks(netGreeks, e.greeks);
    grossNotional += Math.abs(e.notional);
    netNotional += e.notional;
    marketValue += e.marketValue;
  }

  return {
    positions: exposures,
    byTicker,
    notionalByTicker,
    netGreeks,
    grossNotional,
    netNotional,
    marketValue,
    skipped,
  };
}
