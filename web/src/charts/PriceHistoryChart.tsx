/**
 * A price series as an inline SVG line.
 *
 * Hand-rolled for the same reason as PayoffChart and CorrelationHeatmap: a
 * charting library would cost more in bundle size and API surface than the
 * forty lines of path math it replaces.
 */

import type { PriceSeries } from "@onebook/finance";
import { formatUsd } from "../format.js";

const WIDTH = 640;
const HEIGHT = 200;
const PAD_X = 8;
const PAD_Y = 12;

export function PriceHistoryChart({ series }: { series: PriceSeries }) {
  const closes = series.closes;

  if (closes.length < 2) {
    return (
      <div className="empty">
        <b>No price history</b>
        There aren't enough closes for {series.ticker} to draw a series.
      </div>
    );
  }

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  // A perfectly flat series would divide by zero; give it a nominal band so
  // the line renders down the middle instead of vanishing.
  const range = max - min || Math.abs(max) || 1;

  const x = (i: number) =>
    PAD_X + (i / (closes.length - 1)) * (WIDTH - PAD_X * 2);
  const y = (value: number) =>
    HEIGHT - PAD_Y - ((value - min) / range) * (HEIGHT - PAD_Y * 2);

  const line = closes.map((c, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(c)}`).join(" ");
  const fill = `${line} L${x(closes.length - 1)},${HEIGHT} L${x(0)},${HEIGHT} Z`;

  const first = closes[0];
  const last = closes[closes.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="chart"
        role="img"
        aria-label={`Price history for ${series.ticker}`}
        preserveAspectRatio="none"
      >
        <path d={fill} fill="var(--chart-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--chart-line)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="chart-legend">
        <span>
          {series.dates[0]} · {formatUsd(first)}
        </span>
        <span>
          {series.dates[series.dates.length - 1]} · {formatUsd(last)}
        </span>
      </div>
    </div>
  );
}
