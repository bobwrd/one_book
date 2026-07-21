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

const CURRENCIES = ["USD", "EUR", "GBP", "JPY"];

export function AddPositionModal({ onAdd, onClose }: Props) {
  const [type, setType] = useState<"stock" | "option" | "bond">("stock");
  const [ticker, setTicker] = useState("");
  const [quantity, setQuantity] = useState("100");
  const [costBasis, setCostBasis] = useState("");
  const [strike, setStrike] = useState("");
  const [expiry, setExpiry] = useState("");
  const [right, setRight] = useState<OptionRight>("call");
  const [iv, setIv] = useState("30");
  const [couponRate, setCouponRate] = useState("4.25");
  const [maturity, setMaturity] = useState("");
  const [faceValue, setFaceValue] = useState("100000");
  const [price, setPrice] = useState("100");
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) return setError("A ticker is required.");

    const basis = costBasis.trim() === "" ? 0 : Number(costBasis);
    if (!Number.isFinite(basis)) return setError("Cost basis must be a number.");

    // Bonds are sized by face amount, so they skip the quantity check
    // entirely rather than carrying a share count that has no meaning.
    if (type === "bond") {
      const face = Number(faceValue);
      if (!Number.isFinite(face) || face === 0) {
        return setError(
          "Face value must be a non-zero number. Use a negative number for a short position.",
        );
      }
      const coupon = Number(couponRate) / 100;
      if (!Number.isFinite(coupon) || coupon < 0) {
        return setError("Coupon rate must be a non-negative number.");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(maturity)) {
        return setError("Maturity must be a valid date.");
      }
      const priceValue = Number(price);
      if (!Number.isFinite(priceValue) || priceValue <= 0) {
        return setError("Price must be a positive number, quoted per 100 par.");
      }

      onAdd({
        id: randomId(),
        type: "bond",
        ticker: symbol,
        faceValue: face,
        couponRate: coupon,
        maturity,
        price: priceValue,
        costBasis: basis === 0 ? priceValue : basis,
        currency,
      });
      return onClose();
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty === 0) {
      return setError("Quantity must be a non-zero number. Use a negative number for a short position.");
    }

    if (type === "stock") {
      onAdd({
        id: randomId(),
        type: "stock",
        ticker: symbol,
        quantity: qty,
        costBasis: basis,
        currency,
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
      currency,
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
          <button
            className={`tab ${type === "bond" ? "active" : ""}`}
            onClick={() => setType("bond")}
          >
            Bond
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
              placeholder={type === "bond" ? "DBR-2.5-2034" : "AAPL"}
              onChange={(e) => setTicker(e.target.value)}
            />
          </div>
          <div className="field">
            {type === "bond" ? (
              <>
                <label htmlFor="face-value">Face value</label>
                <input
                  id="face-value"
                  type="number"
                  value={faceValue}
                  onChange={(e) => setFaceValue(e.target.value)}
                />
              </>
            ) : (
              <>
                <label htmlFor="qty">
                  {type === "option" ? "Contracts" : "Shares"}
                </label>
                <input
                  id="qty"
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </>
            )}
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

        {type === "bond" && (
          <>
            <div className="field-row">
              <div className="field">
                <label htmlFor="coupon">Coupon (%)</label>
                <input
                  id="coupon"
                  type="number"
                  value={couponRate}
                  onChange={(e) => setCouponRate(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="maturity">Maturity</label>
                <input
                  id="maturity"
                  type="date"
                  value={maturity}
                  min={todayIso()}
                  onChange={(e) => setMaturity(e.target.value)}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="price">Price (per 100 par)</label>
                <input
                  id="price"
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="currency">Currency</label>
                <select
                  id="currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="basis">
            {type === "bond" ? "Cost basis (per 100 par)" : "Cost basis (per share)"}
          </label>
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
          {type === "bond"
            ? "Use a negative face value for a short position. No market-data provider quotes bonds, so the price you enter is the mark — it holds constant under the scenario sliders."
            : "Use a negative quantity for a short position — a written call or short stock."}
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
