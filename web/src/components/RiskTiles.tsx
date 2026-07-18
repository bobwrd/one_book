/**
 * Risk and Greek tiles.
 *
 * Every tile carries a plain-English gloss on hover, and shows a delta chip
 * against the unshocked baseline so the scenario sliders visibly move them.
 */

import type { ReactNode } from "react";
import { formatSignedUsd, formatUsd } from "../format.js";

interface TileProps {
  label: string;
  value: ReactNode;
  /** Change against the unshocked baseline. */
  delta?: number;
  /** Formatter for the delta chip. */
  formatDelta?: (value: number) => string;
  /** Whether a larger value is worse; drives the delta chip's color. */
  higherIsWorse?: boolean;
  hint: string;
  estimate?: boolean;
}

export function Tile({
  label,
  value,
  delta,
  formatDelta = (v) => formatSignedUsd(v),
  higherIsWorse = false,
  hint,
  estimate,
}: TileProps) {
  const showDelta = delta !== undefined && Math.abs(delta) > 1e-9;
  // A rising VaR is bad news; a rising P&L is good. Same chip, opposite sense.
  const isGood = higherIsWorse ? delta! < 0 : delta! > 0;

  return (
    <div className="tile" title={hint}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {showDelta && (
        <span className={`tile-delta ${isGood ? "gain" : "loss"}`}>
          {isGood ? "▼" : "▲"} {formatDelta(Math.abs(delta!))}
        </span>
      )}
      {estimate && <span className="tile-flag">est. IV</span>}
    </div>
  );
}

interface RiskTilesProps {
  annualizedVolatility: number | null;
  var95: number | null;
  var99: number | null;
  historicalVar95: number | null;
  sharpe: number | null;
  baseline?: {
    annualizedVolatility: number | null;
    var95: number | null;
    var99: number | null;
  };
}

export function RiskTiles({
  annualizedVolatility,
  var95,
  var99,
  historicalVar95,
  sharpe,
  baseline,
}: RiskTilesProps) {
  const delta = (
    current: number | null,
    base: number | null | undefined,
  ): number | undefined =>
    current !== null && base !== null && base !== undefined
      ? current - base
      : undefined;

  return (
    <div className="tiles">
      <Tile
        label="Ann. vol"
        value={
          annualizedVolatility === null ? "—" : formatUsd(annualizedVolatility, 0)
        }
        delta={delta(annualizedVolatility, baseline?.annualizedVolatility)}
        higherIsWorse
        hint="One standard deviation of the book's value over a year, from the covariance matrix of delta-equivalent exposure."
      />
      <Tile
        label="VaR 95 · 1d"
        value={var95 === null ? "—" : formatUsd(var95, 0)}
        delta={delta(var95, baseline?.var95)}
        higherIsWorse
        hint="On 95 of 100 days, the one-day loss stays under this. Parametric (variance-covariance) method."
      />
      <Tile
        label="VaR 99 · 1d"
        value={var99 === null ? "—" : formatUsd(var99, 0)}
        delta={delta(var99, baseline?.var99)}
        higherIsWorse
        hint="On 99 of 100 days, the one-day loss stays under this. The tail beyond it is not bounded."
      />
      <Tile
        label="VaR 95 · hist"
        value={historicalVar95 === null ? "—" : formatUsd(historicalVar95, 0)}
        higherIsWorse
        hint="The same 95% loss threshold, read off actual past returns rather than assuming a normal distribution. Usually the more honest number for an options book."
      />
      <Tile
        label="Sharpe"
        value={sharpe === null ? "—" : sharpe.toFixed(2)}
        hint="Annualized excess return per unit of volatility, computed from the book's own historical return series."
      />
    </div>
  );
}

interface GreekTilesProps {
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
  baseline?: { delta: number; gamma: number; theta: number; vega: number };
  hasEstimatedIv: boolean;
}

export function GreekTiles({ greeks, baseline, hasEstimatedIv }: GreekTilesProps) {
  return (
    <div className="tiles">
      <Tile
        label="Net delta"
        value={greeks.delta.toFixed(1)}
        delta={baseline ? greeks.delta - baseline.delta : undefined}
        formatDelta={(v) => v.toFixed(1)}
        hint="Net share-equivalent exposure across the whole book. This is the number that lets stocks and options be measured together."
        estimate={hasEstimatedIv}
      />
      <Tile
        label="Net gamma"
        value={greeks.gamma.toFixed(2)}
        delta={baseline ? greeks.gamma - baseline.gamma : undefined}
        formatDelta={(v) => v.toFixed(2)}
        hint="How fast delta changes as the underlying moves. Negative gamma means losses accelerate in both directions."
        estimate={hasEstimatedIv}
      />
      <Tile
        label="Net theta"
        value={formatUsd(greeks.theta, 0)}
        delta={baseline ? greeks.theta - baseline.theta : undefined}
        hint="Dollars gained or lost per calendar day from time decay alone, holding price and vol fixed."
        estimate={hasEstimatedIv}
      />
      <Tile
        label="Net vega"
        value={formatUsd(greeks.vega, 0)}
        delta={baseline ? greeks.vega - baseline.vega : undefined}
        hint="Dollars gained or lost per one-point rise in implied volatility."
        estimate={hasEstimatedIv}
      />
      <Tile
        label="Net rho"
        value={formatUsd(greeks.rho, 0)}
        hint="Dollars gained or lost per one-point rise in interest rates. Usually the least significant Greek for short-dated books."
        estimate={hasEstimatedIv}
      />
    </div>
  );
}
