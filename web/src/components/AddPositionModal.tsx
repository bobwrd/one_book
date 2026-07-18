import { useState } from "react";
import {
  DEFAULT_CONTRACT_MULTIPLIER,
  type OptionRight,
  type Position,
} from "@onebook/finance";
import { todayIso } from "../format.js";

interface Props {
  onAdd: (position: Position) => void;
  onClose: () => void;
}

function randomId(): string {
  return `p_${Math.random().toString(36).slice(2, 10)}`;
}

export function AddPositionModal({ onAdd, onClose }: Props) {
  const [type, setType] = useState<"stock" | "option">("stock");
  const [ticker, setTicker] = useState("");
  const [quantity, setQuantity] = useState("100");
  const [costBasis, setCostBasis] = useState("");
  const [strike, setStrike] = useState("");
  const [expiry, setExpiry] = useState("");
  const [right, setRight] = useState<OptionRight>("call");
  const [iv, setIv] = useState("30");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) return setError("A ticker is required.");

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty === 0) {
      return setError("Quantity must be a non-zero number. Use a negative number for a short position.");
    }

    const basis = costBasis.trim() === "" ? 0 : Number(costBasis);
    if (!Number.isFinite(basis)) return setError("Cost basis must be a number.");

    if (type === "stock") {
      onAdd({
        id: randomId(),
        type: "stock",
        ticker: symbol,
        quantity: qty,
        costBasis: basis,
      });
      return onClose();
    }

    const strikeValue = Number(strike);
    if (!Number.isFinite(strikeValue) || strikeValue <= 0) {
      return setError("Strike must be a positive number.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return setError("Expiry must be a valid date.");
    }
    const ivValue = Number(iv) / 100;
    if (!Number.isFinite(ivValue) || ivValue <= 0) {
      return setError("Implied volatility must be a positive number.");
    }

    onAdd({
      id: randomId(),
      type: "option",
      ticker: symbol,
      right,
      strike: strikeValue,
      expiry,
      quantity: qty,
      contractMultiplier: DEFAULT_CONTRACT_MULTIPLIER,
      costBasis: basis,
      iv: ivValue,
      // Hand-entered vol is an estimate by definition; the UI marks the
      // resulting Greeks accordingly.
      ivIsEstimate: true,
    });
    onClose();
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Add position</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
        <div className="tabs">
          <button
            className={`tab ${type === "stock" ? "active" : ""}`}
            onClick={() => setType("stock")}
          >
            Stock
          </button>
          <button
            className={`tab ${type === "option" ? "active" : ""}`}
            onClick={() => setType("option")}
          >
            Option
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}

        <div className="field-row">
          <div className="field">
            <label htmlFor="ticker">
              {type === "option" ? "Underlying" : "Ticker"}
            </label>
            <input
              id="ticker"
              value={ticker}
              autoFocus
              placeholder="AAPL"
              onChange={(e) => setTicker(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="qty">
              {type === "option" ? "Contracts" : "Shares"}
            </label>
            <input
              id="qty"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
        </div>

        {type === "option" && (
          <>
            <div className="field-row">
              <div className="field">
                <label htmlFor="right">Type</label>
                <select
                  id="right"
                  value={right}
                  onChange={(e) => setRight(e.target.value as OptionRight)}
                >
                  <option value="call">Call</option>
                  <option value="put">Put</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="strike">Strike</label>
                <input
                  id="strike"
                  type="number"
                  value={strike}
                  placeholder="150"
                  onChange={(e) => setStrike(e.target.value)}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="expiry">Expiry</label>
                <input
                  id="expiry"
                  type="date"
                  value={expiry}
                  min={todayIso()}
                  onChange={(e) => setExpiry(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="iv">Implied vol (%)</label>
                <input
                  id="iv"
                  type="number"
                  value={iv}
                  onChange={(e) => setIv(e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="basis">Cost basis (per share)</label>
          <input
            id="basis"
            type="number"
            value={costBasis}
            placeholder="optional"
            onChange={(e) => setCostBasis(e.target.value)}
          />
        </div>

        <p
          className="faint"
          style={{ fontSize: "0.625rem", lineHeight: 1.5, margin: 0 }}
        >
          Use a negative quantity for a short position — a written call or
          short stock.
        </p>
        </div>

        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
