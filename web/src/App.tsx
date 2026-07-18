/**
 * OneBook dashboard.
 *
 * Phase 1 runs the entire risk engine client-side against localStorage, so the
 * math and the scenario interaction can be exercised with no backend at all.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
  type Shock,
} from "@onebook/finance";
import { PositionRail } from "./components/PositionRail.js";
import { ScenarioBar } from "./components/ScenarioBar.js";
import { GreekTiles, RiskTiles, Tile } from "./components/RiskTiles.js";
import { AddPositionModal } from "./components/AddPositionModal.js";
import { ImportModal } from "./components/ImportModal.js";
import {
  ConnectModal,
  type Connection,
} from "./components/ConnectModal.js";
import { PayoffChart } from "./charts/PayoffChart.js";
import { CorrelationHeatmap } from "./charts/CorrelationHeatmap.js";
import {
  useAuth,
  useBook,
  useDefaultPortfolio,
  usePriceHistory,
  useSpotPrices,
  useTheme,
} from "./store.js";
import { LoginModal } from "./components/LoginModal.js";
import {
  ApiUnavailableError,
  connectWithKeys,
  disconnect,
  fetchConnections,
  isApiConfigured,
} from "./api.js";
import {
  formatSignedUsd,
  formatPercent,
  formatUsd,
  todayIso,
} from "./format.js";

const NO_SHOCK: Shock = { priceShock: 0, volShock: 0, daysForward: 0 };

export function App() {
  const { auth, apiUp, refreshAuth, signOut } = useAuth();
  const portfolioId = useDefaultPortfolio(auth);
  const { positions, isSample, loading, error: bookError, add, addMany, remove, clear } =
    useBook(auth, portfolioId);

  const tickers = useMemo(
    () => [...new Set(positions.map((p) => p.ticker))].sort(),
    [positions],
  );
  const { spot, setPrice, live } = useSpotPrices(tickers, auth, portfolioId);
  const { history, isReal, error: historyError } = usePriceHistory(
    tickers,
    spot,
    auth,
    portfolioId,
  );

  const [shock, setShock] = useState<Shock>(NO_SHOCK);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);
  const { theme, toggleTheme } = useTheme();

  // Connections live server-side; without the API this stays empty and the
  // connect flow explains why rather than silently doing nothing.
  useEffect(() => {
    if (!isApiConfigured()) return;
    fetchConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, []);

  const handleConnect = useCallback(
    async (broker: string, credentials: Record<string, string>) => {
      setConnectError(null);
      try {
        await connectWithKeys(broker, credentials);
        setConnections(await fetchConnections());
      } catch (err) {
        setConnectError(
          err instanceof ApiUnavailableError || err instanceof Error
            ? err.message
            : "Could not connect that account.",
        );
      }
    },
    [],
  );

  const handleDisconnect = useCallback(async (broker: string) => {
    try {
      await disconnect(broker);
      setConnections(await fetchConnections());
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Disconnect failed.");
    }
  }, []);

  const market: MarketSnapshot = useMemo(
    () => ({
      spot,
      riskFreeRate: DEFAULT_RISK_FREE_RATE,
      asOf: todayIso(),
    }),
    [spot],
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
          one<em>book</em>
        </span>
        <span className="topbar-meta">
          {positions.length} pos · {tickers.length} sym
        </span>
        <div className="topbar-spacer" />
        {auth.status === "authenticated" ? (
          <>
            <span className="topbar-meta">{auth.user.email}</span>
            <button onClick={() => setShowConnect(true)}>
              Accounts
              {connections.length > 0 && ` · ${connections.length}`}
            </button>
            <button onClick={() => void signOut()}>Sign out</button>
          </>
        ) : (
          <>
            <button onClick={() => setShowConnect(true)}>Accounts</button>
            <button className="primary" onClick={() => setShowLogin(true)}>
              Sign in
            </button>
          </>
        )}
        <button onClick={() => setShowPrices(true)}>Prices</button>
        <button
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "◐" : "◑"}
        </button>
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
          onConnect={() => setShowConnect(true)}
        />

        <div className="analysis">
          <ScenarioBar shock={shock} onChange={setShock} />

          {(isSample || bookError || (positions.length > 0 && !isReal)) && (
            <div style={{ padding: "0 var(--s4)", paddingTop: "var(--s3)" }}>
              {bookError && <div className="notice error">{bookError}</div>}

              {isSample && (
                <div className="notice warn">
                  <strong>Sample book.</strong> These are illustrative
                  positions, not yours — a covered call on AAPL, a protective
                  put on NVDA, and a short SPY strangle. Drag the price slider
                  to see how they move together. Adding your own position
                  replaces them.
                </div>
              )}

              {positions.length > 0 && !isReal && !isSample && (
                <div className="notice warn">
                  Correlation and VaR use generated price history, not real
                  market data.{" "}
                  {auth.status === "authenticated"
                    ? historyError ??
                      "No price history is available for these symbols yet — it may still be loading, or the market-data provider returned nothing for them."
                    : "Sign in to compute them from actual closes."}
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="empty" style={{ padding: "4rem 1rem" }}>
              <b>Loading your book…</b>
            </div>
          ) : positions.length === 0 ? (
            <div className="empty" style={{ padding: "4rem 1rem" }}>
              <b>Your book is empty</b>
              Add a stock and write an option against it, then drag the price
              slider to watch every metric move together.
            </div>
          ) : (
            <>
              <div className="section">
                <h3 className="section-title">
                  Scenario P&amp;L
                  {isShocked && (
                    <span style={{ color: "var(--ink-muted)" }}>
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

              <div className="section">
                <h3 className="section-title">Portfolio risk</h3>
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

              <div className="section">
                <h3 className="section-title">Net Greeks — whole book</h3>
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
                <div className="section">
                  <h3 className="section-title">Combined payoff</h3>
                  <PayoffChart
                    curve={curve}
                    breakevens={breakevens(curve)}
                    currentShock={shock.priceShock}
                  />
                </div>
                <div className="section">
                  <h3 className="section-title">Correlation</h3>
                  {baseline?.correlation ? (
                    <CorrelationHeatmap
                      tickers={baseline.correlation.tickers}
                      values={baseline.correlation.values}
                    />
                  ) : (
                    <div className="empty">
                      <b>Not enough underlyings</b>
                      Correlation needs at least two tickers.
                    </div>
                  )}
                </div>
              </div>

              {callouts.length > 0 && (
                <div className="section">
                  <h3 className="section-title">Risk callouts</h3>
                  {callouts.map((callout) => (
                    <div
                      key={callout.label}
                      className={`callout ${callout.severity}`}
                    >
                      <b>{callout.label}</b>
                      <span>{callout.detail}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="section">
                <h3 className="section-title">Exposure by underlying</h3>
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
      {showLogin && (
        <LoginModal
          apiUp={apiUp}
          onClose={() => {
            setShowLogin(false);
            void refreshAuth();
          }}
        />
      )}
      {showConnect && (
        <ConnectModal
          connections={connections}
          error={connectError}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onImportCsv={() => {
            setShowConnect(false);
            setShowImport(true);
          }}
          onClose={() => {
            setShowConnect(false);
            setConnectError(null);
          }}
        />
      )}
      {showPrices && (
        <PricesModal
          tickers={tickers}
          live={live}
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
  live,
  spot,
  onSet,
  onClose,
}: {
  tickers: string[];
  live: boolean;
  spot: Record<string, number>;
  onSet: (ticker: string, price: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Spot prices</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
        <p className="faint" style={{ fontSize: "0.625rem", marginTop: 0 }}>
          {live
            ? "Live quotes from your connected data source. Edits apply to this session only."
            : "Entered by hand. Sign in to pull live quotes automatically."}
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
        </div>
        <div className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
