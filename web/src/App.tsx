/**
 * OneBook.
 *
 * This file does one job: assemble the state every page shares and wire up the
 * routes. All rendering lives in `Layout` and the pages under `pages/`.
 */

import { useMemo } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import type { SharedBookState } from "./context.js";
import { Dashboard } from "./pages/Dashboard.js";
import { History } from "./pages/History.js";
import { Instruments } from "./pages/Instruments.js";
import { InstrumentDetail } from "./pages/InstrumentDetail.js";
import { Settings } from "./pages/Settings.js";
import {
  useAuth,
  useBook,
  useDefaultPortfolio,
  usePriceHistory,
  useSpotPrices,
  useTheme,
} from "./store.js";

export function App() {
  const { auth, apiUp, refreshAuth, signOut } = useAuth();
  const portfolioId = useDefaultPortfolio(auth);
  const {
    positions,
    isSample,
    loading,
    error: bookError,
    add,
    addMany,
    remove,
    clear,
    reload,
  } = useBook(auth, portfolioId);

  const tickers = useMemo(
    () => [...new Set(positions.map((p) => p.ticker))].sort(),
    [positions],
  );

  /**
   * Tickers that need a spot price. Bonds are excluded deliberately: no
   * provider quotes them, and `useSpotPrices` seeds anything unpriced with a
   * placeholder 100 so the dashboard is never blank. For a bond that
   * placeholder would take precedence over its own mark and quietly restate
   * the position's value.
   */
  const pricedTickers = useMemo(
    () =>
      [
        ...new Set(
          positions.filter((p) => p.type !== "bond").map((p) => p.ticker),
        ),
      ].sort(),
    [positions],
  );

  const { spot, setPrice, live } = useSpotPrices(
    pricedTickers,
    auth,
    portfolioId,
  );
  const {
    history,
    isReal,
    error: historyError,
    feed,
  } = usePriceHistory(pricedTickers, spot, auth, portfolioId);
  const { theme, toggleTheme } = useTheme();

  const state: SharedBookState = {
    auth,
    apiUp,
    refreshAuth,
    signOut,
    portfolioId,
    positions,
    isSample,
    loading,
    bookError,
    add,
    addMany,
    remove,
    clear,
    reload,
    tickers,
    spot,
    setPrice,
    live,
    history,
    isReal,
    historyError,
    feed,
    theme,
    toggleTheme,
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout state={state} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/history" element={<History />} />
          <Route path="/instruments" element={<Instruments />} />
          <Route path="/instruments/:ticker" element={<InstrumentDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
