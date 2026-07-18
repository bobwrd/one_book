/**
 * Correlation heatmap.
 *
 * Uses a purple/amber diverging scale rather than green/red on purpose:
 * green and red are reserved for P&L throughout the app, and a correlation
 * matrix painted in profit colors reads as a profit map. Every cell also
 * carries its numeric value, so the encoding never depends on hue alone.
 */

interface Props {
  tickers: string[];
  values: number[][];
}

/** Map a correlation in [-1,1] onto the diverging scale. */
function cellColor(value: number): string {
  const magnitude = Math.min(1, Math.abs(value));
  // Floor the alpha so a near-zero cell is still visibly a cell.
  const alpha = 0.12 + magnitude * 0.65;
  // color-mix keeps the scale tied to the theme tokens, so it tracks the
  // light/dark switch instead of being frozen to one palette.
  const token = value >= 0 ? "--corr-pos" : "--corr-neg";
  return `color-mix(in oklab, var(${token}) ${(alpha * 100).toFixed(0)}%, transparent)`;
}

/** Keep label text readable against the strongest fills. */
function textColor(value: number): string {
  return Math.abs(value) > 0.6 ? "var(--ink)" : "var(--ink-muted)";
}

export function CorrelationHeatmap({ tickers, values }: Props) {
  if (tickers.length < 2) {
    return (
      <div className="empty">
        <h3>Not enough underlyings</h3>
        Correlation needs at least two tickers with overlapping price history.
      </div>
    );
  }

  const cell = Math.max(28, Math.min(52, 320 / tickers.length));

  return (
    <div className="scroll-x">
      <table
        style={{ borderCollapse: "separate", borderSpacing: 2 }}
        aria-label="Correlation matrix across underlyings"
      >
        <thead>
          <tr>
            <th />
            {tickers.map((t) => (
              <th
                key={t}
                style={{ textAlign: "center", fontSize: 10, width: cell }}
              >
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickers.map((rowTicker, i) => (
            <tr key={rowTicker}>
              <th style={{ textAlign: "right", paddingRight: 6, fontSize: 10 }}>
                {rowTicker}
              </th>
              {tickers.map((colTicker, j) => {
                const value = values[i]?.[j] ?? 0;
                return (
                  <td
                    key={colTicker}
                    title={`${rowTicker} vs ${colTicker}: ${value.toFixed(3)}`}
                    style={{
                      background: cellColor(value),
                      color: textColor(value),
                      textAlign: "center",
                      fontFamily: "var(--mono)",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 10,
                      width: cell,
                      height: cell,
                      borderRadius: 3,
                      borderTop: "none",
                    }}
                  >
                    {value.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 10,
          fontSize: 10,
          color: "var(--ink-faint)",
          alignItems: "center",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: cellColor(1),
            }}
          />
          moves together
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: cellColor(-1),
            }}
          />
          moves opposite
        </span>
      </div>
    </div>
  );
}
