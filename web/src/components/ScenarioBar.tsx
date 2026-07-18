/**
 * The flagship control (brief section 9.2).
 *
 * Three sliders drive the whole dashboard. They recompute continuously on
 * drag rather than on release — the point of the interaction is watching every
 * metric move together, which is lost if the numbers only update after you let
 * go.
 */

import type { Shock } from "@onebook/finance";
import { formatSignedPercent } from "../format.js";

interface Props {
  shock: Shock;
  onChange: (shock: Shock) => void;
}

export function ScenarioBar({ shock, onChange }: Props) {
  const isShocked =
    shock.priceShock !== 0 || shock.volShock !== 0 || shock.daysForward !== 0;

  return (
    <div className="scenario-bar">
      <div className="slider-group">
        <div className="slider-label">
          <span>Price shock</span>
          <span className="num">{formatSignedPercent(shock.priceShock)}</span>
        </div>
        <input
          type="range"
          min={-30}
          max={30}
          step={0.5}
          value={shock.priceShock * 100}
          aria-label="Underlying price shock, percent"
          onChange={(e) =>
            onChange({ ...shock, priceShock: Number(e.target.value) / 100 })
          }
        />
      </div>

      <div className="slider-group">
        <div className="slider-label">
          <span>Vol shock</span>
          <span className="num">
            {shock.volShock >= 0 ? "+" : ""}
            {(shock.volShock * 100).toFixed(0)} pts
          </span>
        </div>
        <input
          type="range"
          min={-30}
          max={30}
          step={1}
          value={shock.volShock * 100}
          aria-label="Implied volatility shock, percentage points"
          onChange={(e) =>
            onChange({ ...shock, volShock: Number(e.target.value) / 100 })
          }
        />
      </div>

      <div className="slider-group">
        <div className="slider-label">
          <span>Days forward</span>
          <span className="num">{shock.daysForward}d</span>
        </div>
        <input
          type="range"
          min={0}
          max={90}
          step={1}
          value={shock.daysForward}
          aria-label="Days forward for time decay"
          onChange={(e) =>
            onChange({ ...shock, daysForward: Number(e.target.value) })
          }
        />
      </div>

      <button
        onClick={() =>
          onChange({ priceShock: 0, volShock: 0, daysForward: 0 })
        }
        disabled={!isShocked}
        title="Return all sliders to current market"
      >
        Reset to spot
      </button>
    </div>
  );
}
