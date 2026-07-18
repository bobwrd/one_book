/**
 * The flagship control.
 *
 * Three sliders drive the whole dashboard, recomputing continuously on drag
 * rather than on release — watching every metric move together is the entire
 * point, and that is lost if the numbers only update after you let go.
 */

import type { Shock } from "@onebook/finance";
import { formatSignedPercent } from "../format.js";

interface Props {
  shock: Shock;
  /** True when spot prices come from a live market-data feed. */
  live: boolean;
  onChange: (shock: Shock) => void;
}

export function ScenarioBar({ shock, live, onChange }: Props) {
  const isShocked =
    shock.priceShock !== 0 || shock.volShock !== 0 || shock.daysForward !== 0;

  return (
    <div className="scenario-bar">
      <Slider
        label="Price"
        display={formatSignedPercent(shock.priceShock)}
        ariaLabel="Underlying price shock, percent"
        min={-30}
        max={30}
        step={0.5}
        value={shock.priceShock * 100}
        onChange={(v) => onChange({ ...shock, priceShock: v / 100 })}
      />

      <Slider
        label="Volatility"
        display={`${shock.volShock >= 0 ? "+" : ""}${(shock.volShock * 100).toFixed(0)} pts`}
        ariaLabel="Implied volatility shock, percentage points"
        min={-30}
        max={30}
        step={1}
        value={shock.volShock * 100}
        onChange={(v) => onChange({ ...shock, volShock: v / 100 })}
      />

      <Slider
        label="Time"
        display={`+${shock.daysForward}d`}
        ariaLabel="Days forward for time decay"
        min={0}
        max={90}
        step={1}
        value={shock.daysForward}
        onChange={(v) => onChange({ ...shock, daysForward: v })}
      />

      <div className="scenario-state">
        <StateLabel isShocked={isShocked} live={live} />
        <button
          onClick={() =>
            onChange({ priceShock: 0, volShock: 0, daysForward: 0 })
          }
          disabled={!isShocked}
          title="Return every slider to current market"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

/**
 * Says whether the dashboard is showing the book as it stands or a
 * hypothetical. Without this the sliders read as the source of the numbers
 * rather than a departure from them — and at rest there is nothing on screen
 * to indicate which.
 *
 * The resting label never claims "live" unless prices genuinely came from a
 * feed; on local data it says so instead.
 */
function StateLabel({
  isShocked,
  live,
}: {
  isShocked: boolean;
  live: boolean;
}) {
  if (isShocked) {
    return (
      <span className="state-chip simulated" title="Showing a hypothetical market, not your book as it stands">
        <span className="state-dot" />
        simulated
      </span>
    );
  }

  return (
    <span
      className="state-chip"
      title={
        live
          ? "Your book at current market prices. Move a slider to explore a hypothetical."
          : "Your book at the prices on file. Sign in for live quotes."
      }
    >
      <span className="state-dot" />
      {live ? "at market" : "at spot"}
    </span>
  );
}

function Slider({
  label,
  display,
  ariaLabel,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  display: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="slider-group">
      <span className="slider-label">
        <span>{label}</span>
        <b>{display}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
