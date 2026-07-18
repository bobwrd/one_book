/**
 * Combined P&L curve, drawn as inline SVG.
 *
 * Hand-rolled rather than pulled from a charting library: the app needs
 * exactly two chart types, and both are simple enough that a dependency would
 * cost more than it saves.
 */

import { useMemo } from "react";
import type { PayoffPoint } from "@onebook/finance";
import { formatUsd } from "../format.js";

interface Props {
  curve: PayoffPoint[];
  breakevens: number[];
  /** Current shock position, so the marker rides the curve as sliders move. */
  currentShock: number;
  height?: number;
}

const PAD = { top: 14, right: 12, bottom: 26, left: 62 };

export function PayoffChart({
  curve,
  breakevens,
  currentShock,
  height = 240,
}: Props) {
  const width = 560;

  const geometry = useMemo(() => {
    if (curve.length === 0) return null;

    const prices = curve.map((p) => p.price);
    const pnls = curve.map((p) => p.pnl);

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const minPnl = Math.min(...pnls, 0);
    const maxPnl = Math.max(...pnls, 0);

    // Pad the value axis so the curve never touches the frame.
    const pnlPad = (maxPnl - minPnl) * 0.08 || 1;
    const lo = minPnl - pnlPad;
    const hi = maxPnl + pnlPad;

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;

    const x = (price: number) =>
      PAD.left +
      ((price - minPrice) / (maxPrice - minPrice || 1)) * plotW;
    const y = (pnl: number) =>
      PAD.top + (1 - (pnl - lo) / (hi - lo || 1)) * plotH;

    return { x, y, minPrice, maxPrice, lo, hi, plotW, plotH };
  }, [curve, height]);

  if (!geometry || curve.length === 0) {
    return <div className="empty">No positions to plot.</div>;
  }

  const { x, y, minPrice, maxPrice, lo, hi } = geometry;

  // Points above zero, used to shade the profitable region. Green here is the
  // one place semantic color is allowed, since this genuinely is P&L.
  const gainPath = curve
    .filter((point) => point.pnl >= 0)
    .map((point) => `${x(point.price).toFixed(2)},${y(point.pnl).toFixed(2)}`);

  const fullPath = curve
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${x(p.price).toFixed(2)},${y(p.pnl).toFixed(2)}`,
    )
    .join(" ");

  const zeroY = y(0);
  const currentPoint =
    curve.find((p) => p.priceShock >= currentShock) ?? curve[curve.length - 1];

  const yTicks = [hi, (hi + lo) / 2, lo].map((value) => ({
    value,
    y: y(value),
  }));
  const xTicks = [minPrice, (minPrice + maxPrice) / 2, maxPrice].map(
    (value) => ({ value, x: x(value) }),
  );

  return (
    <div className="scroll-x">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Combined profit and loss curve across underlying price"
      >
        {/* Keyed by index: on a flat book the three tick values collapse to
            the same number, and value-based keys would collide. */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={tick.y + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--ink-faint)"
              fontFamily="var(--mono)"
            >
              {formatUsd(tick.value, 0)}
            </text>
          </g>
        ))}

        {/* Breakeven line, drawn under the curve. */}
        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--border)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />

        {xTicks.map((tick, i) => (
          <text
            key={i}
            x={tick.x}
            y={height - 8}
            textAnchor="middle"
            fontSize="9"
            fill="var(--ink-faint)"
            fontFamily="var(--mono)"
          >
            {tick.value.toFixed(0)}
          </text>
        ))}

        {/* Shade above and below zero, clipped to the curve. */}
        <defs>
          <linearGradient id="gainFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--gain)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--gain)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gainPath.length > 1 && (
          <polygon
            points={`${gainPath.join(" ")} ${x(curve[curve.length - 1].price)},${zeroY} ${x(curve[0].price)},${zeroY}`}
            fill="url(#gainFill)"
          />
        )}

        <path d={fullPath} fill="none" stroke="var(--chart-line)" strokeWidth="1.8" />

        {breakevens.map((price, i) => (
          <g key={i}>
            <line
              x1={x(price)}
              x2={x(price)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="var(--ink-faint)"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text
              x={x(price)}
              y={PAD.top - 3}
              textAnchor="middle"
              fontSize="9"
              fill="var(--ink-faint)"
              fontFamily="var(--mono)"
            >
              BE {price.toFixed(0)}
            </text>
          </g>
        ))}

        {/* The marker rides the curve as the price slider moves. */}
        {currentPoint && (
          <g>
            <circle
              cx={x(currentPoint.price)}
              cy={y(currentPoint.pnl)}
              r="4"
              fill={currentPoint.pnl >= 0 ? "var(--gain)" : "var(--loss)"}
              stroke="var(--bg)"
              strokeWidth="1.5"
            />
            <text
              x={x(currentPoint.price)}
              y={y(currentPoint.pnl) - 9}
              textAnchor="middle"
              fontSize="10"
              fontFamily="var(--mono)"
              fill={currentPoint.pnl >= 0 ? "var(--gain)" : "var(--loss)"}
            >
              {formatUsd(currentPoint.pnl, 0)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
