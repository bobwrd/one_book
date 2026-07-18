/**
 * The left rail: the book itself.
 *
 * Every row carries its delta-equivalent share count, which is where the
 * app's core idea stops being an implementation detail and becomes something
 * you can read directly.
 */

import type { Position, PositionExposure } from "@onebook/finance";
import { isOption } from "@onebook/finance";
import { daysUntil, formatExpiry, formatShares, formatUsd } from "../format.js";

interface Props {
  positions: Position[];
  exposures: Map<string, PositionExposure>;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onImport: () => void;
  onConnect: () => void;
}

export function PositionRail({
  positions,
  exposures,
  onRemove,
  onAdd,
  onImport,
  onConnect,
}: Props) {
  return (
    <div className="rail">
      <div className="rail-head">
        <button className="primary" onClick={onAdd} style={{ flex: 1 }}>
          Add position
        </button>
        <button onClick={onImport} title="Import a broker CSV export">
          CSV
        </button>
        <button onClick={onConnect} title="Connect a brokerage account">
          Connect
        </button>
      </div>

      <div className="rail-body">
        {positions.length === 0 ? (
          <div className="empty">
            <b>No positions</b>
            Add one by hand, import a CSV, or connect a brokerage account.
          </div>
        ) : (
          positions.map((position) => (
            <PositionRow
              key={position.id}
              position={position}
              exposure={exposures.get(position.id)}
              onRemove={() => onRemove(position.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PositionRow({
  position,
  exposure,
  onRemove,
}: {
  position: Position;
  exposure: PositionExposure | undefined;
  onRemove: () => void;
}) {
  const option = isOption(position);
  const dte = option ? daysUntil(position.expiry) : null;
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

  return (
    <div className="position">
      <div style={{ minWidth: 0 }}>
        <div className="position-sym">
          {position.ticker}
          <span className="muted">
            {" "}
            {option
              ? `${signed(position.quantity)} ${position.right === "call" ? "C" : "P"}${position.strike}`
              : `${signed(position.quantity)} sh`}
          </span>
        </div>

        <div className="position-meta">
          {option && (
            <>
              {formatExpiry(position.expiry)}
              {" · "}
              {dte !== null && dte < 0 ? (
                <span className="tag warn">expired</span>
              ) : (
                `${dte}d`
              )}
              {" · "}
              {(position.iv * 100).toFixed(0)}%
              {position.ivIsEstimate && <span className="tag warn"> est</span>}
              {" · "}
            </>
          )}
          {exposure ? formatUsd(exposure.marketValue, 0) : "no price"}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div className="position-eq">
          {exposure ? (
            <>
              {formatShares(exposure.shareEquivalents)}
              <small>Δ-eq</small>
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </div>
        <button
          className="icon position-remove"
          onClick={onRemove}
          aria-label={`Remove ${position.ticker} position`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
