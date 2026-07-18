/**
 * The left rail: the book itself.
 *
 * Every row shows its delta-equivalent share count inline, which is where the
 * app's core idea becomes visible rather than staying an implementation detail.
 */

import type { PositionExposure } from "@onebook/finance";
import type { Position } from "@onebook/finance";
import { isOption } from "@onebook/finance";
import { daysUntil, formatExpiry, formatShares, formatUsd } from "../format.js";

interface Props {
  positions: Position[];
  exposures: Map<string, PositionExposure>;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onImport: () => void;
}

export function PositionRail({
  positions,
  exposures,
  onRemove,
  onAdd,
  onImport,
}: Props) {
  return (
    <div className="rail">
      <div
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 12,
        }}
      >
        <button className="primary" onClick={onAdd} style={{ flex: 1 }}>
          + Add position
        </button>
        <button onClick={onImport} title="Import a broker CSV export">
          Import
        </button>
      </div>

      {positions.length === 0 ? (
        <div className="empty">
          <h3>No positions yet</h3>
          Add a stock or option, or import a CSV export from your broker.
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

  return (
    <div className="position-row">
      <div className="position-main">
        <div>
          <span className="position-ticker">{position.ticker}</span>{" "}
          {option ? (
            <span className="position-detail">
              {position.quantity > 0 ? "+" : ""}
              {position.quantity} {position.right === "call" ? "C" : "P"}
              {position.strike} {formatExpiry(position.expiry)}
            </span>
          ) : (
            <span className="position-detail">
              {position.quantity > 0 ? "+" : ""}
              {position.quantity} sh
            </span>
          )}
        </div>
        <div className="position-detail">
          {option && dte !== null && (
            <>
              {dte < 0 ? (
                <span className="badge">expired</span>
              ) : (
                <>{dte}d</>
              )}
              {" · "}
              IV {(position.iv * 100).toFixed(0)}%{" "}
              {position.ivIsEstimate && (
                <span className="badge estimate">est</span>
              )}
              {" · "}
            </>
          )}
          {exposure ? formatUsd(exposure.marketValue, 0) : "no price"}
        </div>
      </div>

      <div>
        <div className="position-delta-eq">
          {exposure ? (
            <>
              {formatShares(exposure.shareEquivalents)}
              <small>Δ-equiv sh</small>
            </>
          ) : (
            <span className="position-detail">—</span>
          )}
        </div>
        <button
          className="ghost"
          onClick={onRemove}
          aria-label={`Remove ${position.ticker} position`}
          style={{ float: "right", marginTop: 2 }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
