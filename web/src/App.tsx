/**
 * OneBook dashboard.
 *
 * Phase 1 runs the entire risk engine client-side against localStorage, so the
 * math and the scenario interaction can be exercised with no backend at all.
 */

import { useMemo, useState } from "react";
import {
  alignSeries,
  bookExposure,
  breakevens,
  concentration,
  correlationMatrix,
  covarianceMatrix,
  DEFAULT_RISK_FREE_RATE,
  isOption,
  parametricVar,
  payoffCurve,
  portfolioVolatility,
  riskCallouts,
  runScenario,
  shockMarket,
  type MarketSnapshot,
  type PositionExposure,
  type PriceSeries,
  type Shock,
} from "@onebook/finance";
import { PositionRail } from "./components/PositionRail.js";
import { ScenarioBar } from "./components/ScenarioBar.js";
import { GreekTiles, RiskTiles, Tile } from "./components/RiskTiles.js";
import { AddPositionModal } from "./components/AddPositionModal.js";
import { ImportModal } from "./components/ImportModal.js";
import { PayoffChart } from "./charts/PayoffChart.js";
import { CorrelationHeatmap } from "./charts/CorrelationHeatmap.js";
import { usePositions, useSpotPrices } from "./store.js";
import {
  formatSignedUsd,
  formatPercent,
  formatUsd,
  todayIso,
} from "./format.js";
import { syntheticHistory } from "./syntheticHistory.js";

const NO_SHOCK: Shock = { priceShock: 0, volShock: 0, daysForward: 0 };

export function App() {
  const { positions, add, addMany, remove, clear } = usePositions();
  const tickers = useMemo(
    () => [...new Set(positions.map((p) => p.ticker))].sort(),
    [positions],
  );
  const { spot, setPrice } = useSpotPrices(tickers);

  const [shock, setShock] = useState<Shock>(NO_SHOCK);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showPrices, setShowPrices] = useState(false);

  const market: MarketSnapshot = useMemo(
    () => ({
      spot,
      riskFreeRate: DEFAULT_RISK_FREE_RATE,
      asOf: todayIso(),
    }),
    [spot],
  );

  /**
   * Phase 1 has no market-data feed, so correlation and VaR run on a
   * deterministic synthetic history seeded per ticker. Phase 2 swaps this for
   * real closes from the API without changing anything downstream.
   */
  const history: PriceSeries[] = useMemo(
    () => tickers.map((ticker) => syntheticHistory(ticker, spot[ticker] ?? 100)),
    [tickers.join(","), tickers.map((t) => spot[t]).join(",")],
  );

  // The unshocked book: the baseline every delta chip is measured against.
  const baseline = useMemo(() => {
    if (positions.length === 0) return null;
    const exposure = bookExposure(positions, market);
    const conc = concentration(exposure.notionalByTicker);

    let vol: number | null = null;
    let var95: number | null = null;
    let var99: number | null = null;
    let correlation: { tickers: string[]; values: number[][] } | null = null;

    if (history.length >= 1) {
      try {
        const aligned = alignSeries(history);
        const cov = covarianceMatrix(aligned.returns, aligned.tickers);
        vol = portfolioVolatility(exposure.notionalByTicker, cov);
        var95 = parametricVar(exposure.notionalByTicker, cov, 0.95).value;
        var99 = parametricVar(exposure.notionalByTicker, cov, 0.99).value;
        if (history.length >= 2) {
          correlation = correlationMatrix(aligned.returns, aligned.tickers);
        }
      } catch {
        // Not enough overlapping history; exposure and Greeks still hold.
      }
    }

    return { exposure, conc, vol, var95, var99, correlation };
  }, [positions, market, history]);

  // The shocked book: everything the sliders drive.
  const shocked = useMemo(() => {
    if (positions.length === 0) return null;

    const scenario = runScenario(positions, market, shock);
    const shockedMarket = shockMarket(market, shock);
    const shockedPositions = positions.map((p) =>
      isOption(p) ? { ...p, iv: Math.max(0.001, p.iv + shock.volShock) } : p,
    );
    const exposure = bookExposure(shockedPositions, shockedMarket);
    const conc = concentration(exposure.notionalByTicker);

    let vol: number | null = null;
    let var95: number | null = null;
    let var99: number | null = null;

    if (history.length >= 1) {
      try {
        const aligned = alignSeries(history);
        const cov = covarianceMatrix(aligned.returns, aligned.tickers);
        vol = portfolioVolatility(exposure.notionalByTicker, cov);
        var95 = parametricVar(exposure.notionalByTicker, cov, 0.95).value;
        var99 = parametricVar(exposure.notionalByTicker, cov, 0.99).value;
      } catch {
        // As above.
      }
    }

    return { scenario, exposure, conc, vol, var95, var99 };
  }, [positions, market, shock, history]);

  const curve = useMemo(
    () =>
      positions.length === 0
        ? []
        : payoffCurve(positions, market, {
            steps: 121,
            volShock: shock.volShock,
            daysForward: shock.daysForward,
          }),
    [positions, market, shock.volShock, shock.daysForward],
  );

  const exposureById = useMemo(() => {
    const map = new Map<string, PositionExposure>();
    for (const e of shocked?.exposure.positions ?? []) {
      map.set(e.positionId, e);
    }
    return map;
  }, [shocked]);

  const callouts = useMemo(
    () =>
      positions.length === 0
        ? []
        : riskCallouts(positions, market, baseline?.conc.breakdown ?? []),
    [positions, market, baseline],
  );

  const hasEstimatedIv = positions.some((p) => isOption(p) && p.ivIsEstimate);
  const isShocked =
    shock.priceShock !== 0 || shock.volShock !== 0 || shock.daysForward !== 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          One<span>Book</span>
        </span>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
          {positions.length} position{positions.length === 1 ? "" : "s"} ·{" "}
          {tickers.length} underlying{tickers.length === 1 ? "" : "s"}
        </span>
        <div className="topbar-spacer" />
        <button onClick={() => setShowPrices(true)}>Prices</button>
        {positions.length > 0 && (
          <button
            onClick={() => {
              if (confirm("Remove all positions from this book?")) clear();
            }}
          >
            Clear
          </button>
        )}
      </header>

      <div className="main">
        <PositionRail
          positions={positions}
          exposures={exposureById}
          onRemove={remove}
          onAdd={() => setShowAdd(true)}
          onImport={() => setShowImport(true)}
        />

        <div className="analysis">
          <ScenarioBar shock={shock} onChange={setShock} />

          {positions.length === 0 ? (
            <div className="empty" style={{ padding: 64 }}>
              <h3>Your book is empty</h3>
              Add a stock and an option against it, then drag the price slider
              to watch every metric move together.
            </div>
          ) : (
            <>
              <div className="panel">
                <h3 className="panel-title">
                  Scenario P&amp;L
                  {isShocked && (
                    <span style={{ color: "var(--text-dim)" }}>
                      {" "}
                      — vs. current market
                    </span>
                  )}
                </h3>
                <div className="tiles">
                  <Tile
                    label="Book value"
                    value={formatUsd(shocked?.exposure.marketValue ?? 0, 0)}
                    hint="Theoretical mark-to-market value of every position under the current scenario."
                  />
                  <Tile
                    label="Scenario P&L"
                    value={
                      <span
                        className={
                          (shocked?.scenario.pnl ?? 0) >= 0 ? "gain" : "loss"
                        }
                      >
                        {formatSignedUsd(shocked?.scenario.pnl ?? 0)}
                      </span>
                    }
                    hint="Change in book value under the current price, volatility, and time shock. A full reprice, not a delta approximation."
                  />
                  <Tile
                    label="Gross exposure"
                    value={formatUsd(shocked?.exposure.grossNotional ?? 0, 0)}
                    hint="Sum of absolute delta-equivalent notional. Longs and shorts add rather than cancel."
                  />
                  <Tile
                    label="Net exposure"
                    value={formatUsd(shocked?.exposure.netNotional ?? 0, 0)}
                    hint="Signed delta-equivalent notional. This is what a covered call reduces."
                  />
                  <Tile
                    label="Diversification"
                    value={formatPercent(
                      shocked?.conc.diversificationScore ?? 0,
                      0,
                    )}
                    hint="1.0 means gross exposure is spread evenly across underlyings; 0 means it sits in a single name."
                  />
                </div>
              </div>

              <div className="panel">
                <h3 className="panel-title">Portfolio risk</h3>
                <RiskTiles
                  annualizedVolatility={shocked?.vol ?? null}
                  var95={shocked?.var95 ?? null}
                  var99={shocked?.var99 ?? null}
                  historicalVar95={null}
                  sharpe={null}
                  baseline={
                    isShocked && baseline
                      ? {
                          annualizedVolatility: baseline.vol,
                          var95: baseline.var95,
                          var99: baseline.var99,
                        }
                      : undefined
                  }
                />
              </div>

              <div className="panel">
                <h3 className="panel-title">Net Greeks — whole book</h3>
                <GreekTiles
                  greeks={
                    shocked?.exposure.netGreeks ?? {
                      delta: 0,
                      gamma: 0,
                      theta: 0,
                      vega: 0,
                      rho: 0,
                    }
                  }
                  baseline={
                    isShocked && baseline
                      ? baseline.exposure.netGreeks
                      : undefined
                  }
                  hasEstimatedIv={hasEstimatedIv}
                />
              </div>

              <div className="split">
                <div className="panel" style={{ borderBottom: "none" }}>
                  <h3 className="panel-title">Combined payoff</h3>
                  <PayoffChart
                    curve={curve}
                    breakevens={breakevens(curve)}
                    currentShock={shock.priceShock}
                  />
                </div>
                <div className="panel" style={{ borderBottom: "none" }}>
                  <h3 className="panel-title">Correlation</h3>
                  {baseline?.correlation ? (
                    <CorrelationHeatmap
                      tickers={baseline.correlation.tickers}
                      values={baseline.correlation.values}
                    />
                  ) : (
                    <div className="empty">
                      <h3>Not enough underlyings</h3>
                      Correlation needs at least two tickers.
                    </div>
                  )}
                </div>
              </div>

              {callouts.length > 0 && (
                <div className="panel">
                  <h3 className="panel-title">Risk callouts</h3>
                  {callouts.map((callout) => (
                    <div
                      key={callout.label}
                      className={`callout ${callout.severity}`}
                    >
                      <span className="callout-label">{callout.label}</span>
                      <span className="callout-detail">{callout.detail}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel">
                <h3 className="panel-title">Exposure by underlying</h3>
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th style={{ textAlign: "right" }}>Δ-equiv shares</th>
                        <th style={{ textAlign: "right" }}>Notional</th>
                        <th style={{ textAlign: "right" }}>% of gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(shocked?.conc.breakdown ?? []).map((row) => (
                        <tr key={row.ticker}>
                          <td>{row.ticker}</td>
                          <td className="num" style={{ textAlign: "right" }}>
                            {(
                              shocked?.exposure.byTicker[row.ticker] ?? 0
                            ).toFixed(1)}
                          </td>
                          <td className="num" style={{ textAlign: "right" }}>
                            {formatUsd(row.notional, 0)}
                          </td>
                          <td className="num" style={{ textAlign: "right" }}>
                            {formatPercent(row.weight, 1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="disclaimer">
        OneBook is an informational risk tool, not investment advice. Options
        are priced with a European Black-Scholes model; American early exercise
        is not modeled. Verify all figures independently before acting on them.
      </footer>

      {showAdd && (
        <AddPositionModal onAdd={add} onClose={() => setShowAdd(false)} />
      )}
      {showImport && (
        <ImportModal
          onImport={addMany}
          onClose={() => setShowImport(false)}
        />
      )}
      {showPrices && (
        <PricesModal
          tickers={tickers}
          spot={spot}
          onSet={setPrice}
          onClose={() => setShowPrices(false)}
        />
      )}
    </div>
  );
}

function PricesModal({
  tickers,
  spot,
  onSet,
  onClose,
}: {
  tickers: string[];
  spot: Record<string, number>;
  onSet: (ticker: string, price: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Spot prices</h2>
        <p style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 0 }}>
          Prices are entered by hand in this build. Connecting the API replaces
          these with live quotes.
        </p>
        {tickers.length === 0 ? (
          <div className="empty">Add a position first.</div>
        ) : (
          tickers.map((ticker) => (
            <div className="field" key={ticker}>
              <label htmlFor={`price-${ticker}`}>{ticker}</label>
              <input
                id={`price-${ticker}`}
                type="number"
                value={spot[ticker] ?? 0}
                onChange={(e) => onSet(ticker, Number(e.target.value))}
              />
            </div>
          ))
        )}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
