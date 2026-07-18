/**
 * Book state, in two interchangeable modes behind one interface.
 *
 *   signed out — localStorage, seeded with the sample book. Fully functional
 *                offline; nothing leaves the browser.
 *   signed in  — the Worker API, with positions in D1 and real cached closes.
 *
 * The dashboard consumes the same shape either way, so nothing downstream
 * knows or cares which mode is active.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Position, PriceSeries } from "@onebook/finance";
import {
  addPositions,
  createPortfolio,
  deletePosition,
  fetchPortfolio,
  fetchPortfolios,
  fetchHistory,
  fetchSession,
  fetchSpot,
  isApiConfigured,
  logout as apiLogout,
  type SessionUser,
} from "./api.js";
import { SAMPLE_SPOT, sampleBook } from "./sampleBook.js";
import { demoHistory } from "./demoHistory.js";

const POSITIONS_KEY = "onebook.positions.v1";
const SPOT_KEY = "onebook.spot.v1";
const THEME_KEY = "onebook.theme.v1";
const SEEDED_KEY = "onebook.seeded.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Corrupt or unavailable storage must not take the app down.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full quota; the session still works in memory.
  }
}

// ------------------------------------------------------------------- auth

export type AuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: SessionUser };

export function useAuth() {
  const [state, setState] = useState<AuthState>(
    // With no API there is nothing to check, so skip straight to anonymous
    // rather than flashing a loading state that can never resolve.
    isApiConfigured() ? { status: "checking" } : { status: "anonymous" },
  );

  const refresh = useCallback(async () => {
    if (!isApiConfigured()) {
      setState({ status: "anonymous" });
      return;
    }
    try {
      const user = await fetchSession();
      setState(
        user ? { status: "authenticated", user } : { status: "anonymous" },
      );
    } catch {
      // API unreachable: fall back to local mode rather than blocking.
      setState({ status: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Even if the call fails, drop the local session view.
    }
    setState({ status: "anonymous" });
  }, []);

  return { auth: state, refreshAuth: refresh, signOut };
}

// ------------------------------------------------------------------- book

export interface BookState {
  positions: Position[];
  /** True while the first API load is in flight. */
  loading: boolean;
  /** Set when the book is the built-in demo rather than the user's own. */
  isSample: boolean;
  error: string | null;
  add: (position: Position) => void;
  addMany: (positions: Position[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  reload: () => void;
}

const isDemo = (p: { id: string }) => p.id.startsWith("demo-");

/**
 * Signed-out book. Seeds the sample portfolio exactly once, so clearing it
 * stays cleared instead of the demo reappearing on every reload.
 */
function useLocalBook(): BookState {
  const [positions, setPositions] = useState<Position[]>(() => {
    const stored = read<Position[] | null>(POSITIONS_KEY, null);
    if (stored !== null) return stored;
    if (read<boolean>(SEEDED_KEY, false)) return [];
    return sampleBook();
  });

  useEffect(() => {
    write(POSITIONS_KEY, positions);
    write(SEEDED_KEY, true);
  }, [positions]);

  const isSample = positions.length > 0 && positions.every(isDemo);

  // Adding to the demo book replaces it — mixing real positions into sample
  // data would silently corrupt every number on screen.
  const add = useCallback((position: Position) => {
    setPositions((current) => [...current.filter((p) => !isDemo(p)), position]);
  }, []);

  const addMany = useCallback((incoming: Position[]) => {
    setPositions((current) => [
      ...current.filter((p) => !isDemo(p)),
      ...incoming,
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setPositions((current) => current.filter((p) => p.id !== id));
  }, []);

  const clear = useCallback(() => setPositions([]), []);
  const reload = useCallback(() => {}, []);

  return {
    positions,
    loading: false,
    isSample,
    error: null,
    add,
    addMany,
    remove,
    clear,
    reload,
  };
}

function toApiPosition(p: Position) {
  return p.type === "option"
    ? {
        type: "option" as const,
        ticker: p.ticker,
        quantity: p.quantity,
        costBasis: p.costBasis,
        strike: p.strike,
        expiry: p.expiry,
        right: p.right,
        contractMultiplier: p.contractMultiplier,
        iv: p.iv,
      }
    : {
        type: "stock" as const,
        ticker: p.ticker,
        quantity: p.quantity,
        costBasis: p.costBasis,
      };
}

/** Signed-in book, backed by the API. */
function useRemoteBook(portfolioId: string | null): BookState {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!portfolioId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const portfolio = await fetchPortfolio(portfolioId);
      setPositions(portfolio.positions as unknown as Position[]);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load positions.",
      );
    } finally {
      setLoading(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That change failed.");
      }
    },
    [load],
  );

  const add = useCallback(
    (position: Position) => {
      if (!portfolioId) return;
      void mutate(() => addPositions(portfolioId, [toApiPosition(position)]));
    },
    [portfolioId, mutate],
  );

  const addMany = useCallback(
    (incoming: Position[]) => {
      if (!portfolioId) return;
      void mutate(() => addPositions(portfolioId, incoming.map(toApiPosition)));
    },
    [portfolioId, mutate],
  );

  const remove = useCallback(
    (id: string) => {
      if (!portfolioId) return;
      void mutate(() => deletePosition(portfolioId, id));
    },
    [portfolioId, mutate],
  );

  const clear = useCallback(() => {
    if (!portfolioId) return;
    void mutate(async () => {
      for (const p of positions) await deletePosition(portfolioId, p.id);
    });
  }, [portfolioId, positions, mutate]);

  const reload = useCallback(() => void load(), [load]);

  return {
    positions,
    loading,
    isSample: false,
    error,
    add,
    addMany,
    remove,
    clear,
    reload,
  };
}

/** Picks the right book for the current auth state. */
export function useBook(auth: AuthState, portfolioId: string | null): BookState {
  const local = useLocalBook();
  const remote = useRemoteBook(
    auth.status === "authenticated" ? portfolioId : null,
  );
  return auth.status === "authenticated" ? remote : local;
}

/**
 * The signed-in user's default portfolio, created on first sign-in so there
 * is always somewhere to put positions.
 */
export function useDefaultPortfolio(auth: AuthState): string | null {
  const [portfolioId, setPortfolioId] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setPortfolioId(null);
      return;
    }

    void (async () => {
      try {
        const existing = await fetchPortfolios();
        if (existing.length > 0) {
          setPortfolioId(existing[0].id);
          return;
        }
        const created = await createPortfolio("My book");
        setPortfolioId(created.id);
      } catch {
        setPortfolioId(null);
      }
    })();
  }, [auth.status]);

  return portfolioId;
}

// ------------------------------------------------------------------ prices

/**
 * Spot prices.
 *
 * Signed in, these come from the API's cached quotes. Signed out they are
 * user-editable and seeded from the sample book, since there is no market
 * data source without a backend.
 */
export function useSpotPrices(
  tickers: string[],
  auth: AuthState,
  portfolioId: string | null,
) {
  const [spot, setSpot] = useState<Record<string, number>>(() => ({
    ...SAMPLE_SPOT,
    ...read<Record<string, number>>(SPOT_KEY, {}),
  }));
  const [live, setLive] = useState(false);

  const tickerKey = tickers.join(",");

  useEffect(() => {
    if (auth.status !== "authenticated" || !portfolioId) {
      setLive(false);
      return;
    }
    void (async () => {
      try {
        const prices = await fetchSpot(portfolioId);
        if (Object.keys(prices).length > 0) {
          setSpot((current) => ({ ...current, ...prices }));
          setLive(true);
        }
      } catch {
        setLive(false);
      }
    })();
  }, [auth.status, portfolioId, tickerKey]);

  // Only persist hand-entered prices; live quotes are the API's to own.
  useEffect(() => {
    if (!live) write(SPOT_KEY, spot);
  }, [spot, live]);

  // Seed anything still unpriced so the dashboard is never blank.
  useEffect(() => {
    setSpot((current) => {
      const missing = tickers.filter((t) => current[t] === undefined);
      if (missing.length === 0) return current;
      const next = { ...current };
      for (const ticker of missing) next[ticker] = 100;
      return next;
    });
  }, [tickerKey]);

  const setPrice = useCallback((ticker: string, price: number) => {
    setSpot((current) => ({ ...current, [ticker]: price }));
  }, []);

  return { spot, setPrice, live };
}

// ------------------------------------------------------------------- theme

/**
 * Theme, persisted and applied to the document root. The initial value is
 * also set inline in index.html so the page never flashes the wrong theme.
 */
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === '"light"' ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage unavailable; the theme still applies for this session.
    }
  }, [theme]);

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggleTheme };
}

// ----------------------------------------------------------------- history

/**
 * Price history for correlation and VaR.
 *
 * Signed in, these are real cached closes fetched once from the API — every
 * scenario recompute then happens locally, so dragging a slider never waits
 * on a round trip. Signed out, they are deterministic synthetic walks, which
 * the UI labels as demo data.
 */
export function usePriceHistory(
  tickers: string[],
  spot: Record<string, number>,
  auth: AuthState,
  portfolioId: string | null,
): { history: PriceSeries[]; isReal: boolean } {
  const [remote, setRemote] = useState<PriceSeries[] | null>(null);
  const tickerKey = tickers.join(",");

  useEffect(() => {
    if (auth.status !== "authenticated" || !portfolioId) {
      setRemote(null);
      return;
    }
    void (async () => {
      try {
        const result = await fetchHistory(portfolioId);
        setRemote(result.series.length > 0 ? result.series : null);
      } catch {
        setRemote(null);
      }
    })();
  }, [auth.status, portfolioId, tickerKey]);

  const history = useMemo(() => {
    if (remote) return remote;
    return tickers.map((t) => demoHistory(t, spot[t] ?? 100));
  }, [remote, tickerKey, tickers.map((t) => spot[t]).join(",")]);

  return { history, isReal: remote !== null };
}
