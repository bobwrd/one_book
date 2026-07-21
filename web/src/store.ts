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
  assignPositionToGroup,
  createGroup,
  createPortfolio,
  deleteGroup,
  deletePosition,
  fetchFxRate,
  fetchGroups,
  fetchNews,
  fetchPortfolio,
  fetchPortfolios,
  fetchPreferences,
  fetchHistory,
  fetchSession,
  fetchSessions,
  fetchSpot,
  fetchTransactions,
  isApiConfigured,
  probeApi,
  renameGroup,
  unassignPositionFromGroup,
  updatePreferences,
  logout as apiLogout,
  type ApiGroup,
  type ApiSession,
  type ApiTransaction,
  type NewsItem,
  type Preferences,
  type SessionUser,
} from "./api.js";
import { SAMPLE_SPOT, sampleBook } from "./sampleBook.js";
import { demoHistory } from "./demoHistory.js";

const POSITIONS_KEY = "onebook.positions.v1";
const SPOT_KEY = "onebook.spot.v1";
const THEME_KEY = "onebook.theme.v1";
const SEEDED_KEY = "onebook.seeded.v1";
const GROUPS_KEY = "onebook.groups.v1";
const TRANSACTIONS_KEY = "onebook.transactions.v1";
const PREFS_KEY = "onebook.prefs.v1";

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
  const [state, setState] = useState<AuthState>({ status: "checking" });
  const [apiUp, setApiUp] = useState(false);

  const refresh = useCallback(async () => {
    // Probe before asking about a session: same-origin deploys have no
    // origin to inspect, so reachability has to be observed, not configured.
    const available = await probeApi();
    setApiUp(available);

    if (!available) {
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

  return { auth: state, apiUp, refreshAuth: refresh, signOut };
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
 * A ledger row, in the shape both modes produce.
 *
 * Signed in these come from the API; signed out they are written locally when
 * a position is added, so the History page is meaningful in demo mode too
 * rather than being a signed-in-only feature.
 */
export interface LocalTransaction {
  id: string;
  ticker: string;
  positionType: "stock" | "option" | "bond";
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  source: string;
  executedAt: number;
}

/**
 * localStorage has no change events for the same document, so local-mode
 * writers notify readers directly. Keeps `useTransactions` in sync with an
 * `add()` that happened in `useLocalBook`.
 */
const localTxListeners = new Set<() => void>();

function notifyLocalTransactions(): void {
  for (const listener of localTxListeners) listener();
}

function readLocalTransactions(): LocalTransaction[] {
  return read<LocalTransaction[]>(TRANSACTIONS_KEY, []);
}

/** The ledger row a newly added position implies. Mirrors the API's rule. */
function positionToLocalTransaction(p: Position): LocalTransaction {
  const size = p.type === "bond" ? p.faceValue : p.quantity;
  return {
    id: `txn-${p.id}`,
    ticker: p.ticker,
    positionType: p.type,
    side: size >= 0 ? "buy" : "sell",
    quantity: Math.abs(size),
    price: p.type === "bond" ? p.price : p.costBasis,
    fee: 0,
    source: "manual",
    executedAt: Date.now(),
  };
}

function appendLocalTransactions(positions: Position[]): void {
  if (positions.length === 0) return;
  write(TRANSACTIONS_KEY, [
    ...readLocalTransactions(),
    ...positions.map(positionToLocalTransaction),
  ]);
  notifyLocalTransactions();
}

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
    appendLocalTransactions([position]);
  }, []);

  const addMany = useCallback((incoming: Position[]) => {
    setPositions((current) => [
      ...current.filter((p) => !isDemo(p)),
      ...incoming,
    ]);
    appendLocalTransactions(incoming);
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
  if (p.type === "option") {
    return {
      type: "option" as const,
      ticker: p.ticker,
      quantity: p.quantity,
      costBasis: p.costBasis,
      currency: p.currency,
      strike: p.strike,
      expiry: p.expiry,
      right: p.right,
      contractMultiplier: p.contractMultiplier,
      iv: p.iv,
    };
  }
  if (p.type === "bond") {
    return {
      type: "bond" as const,
      ticker: p.ticker,
      costBasis: p.costBasis,
      currency: p.currency,
      couponRate: p.couponRate,
      maturity: p.maturity,
      faceValue: p.faceValue,
      price: p.price,
    };
  }
  return {
    type: "stock" as const,
    ticker: p.ticker,
    quantity: p.quantity,
    costBasis: p.costBasis,
    currency: p.currency,
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
): {
  history: PriceSeries[];
  isReal: boolean;
  error: string | null;
  feed: string | null;
} {
  const [remote, setRemote] = useState<PriceSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<string | null>(null);
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
        setFeed(result.feed ?? null);
        // Report the provider's own reason rather than leaving the user to
        // guess why their real data did not arrive.
        setError(
          result.series.length === 0 && result.failures?.length
            ? result.failures[0].reason
            : null,
        );
      } catch (err) {
        setRemote(null);
        setError(err instanceof Error ? err.message : null);
      }
    })();
  }, [auth.status, portfolioId, tickerKey]);

  const history = useMemo(() => {
    if (remote) return remote;
    return tickers.map((t) => demoHistory(t, spot[t] ?? 100));
  }, [remote, tickerKey, tickers.map((t) => spot[t]).join(",")]);

  return { history, isReal: remote !== null, error, feed };
}

// ------------------------------------------------------------------ groups

export interface GroupsState {
  groups: ApiGroup[];
  loading: boolean;
  create: (name: string, color: string) => Promise<void>;
  update: (id: string, changes: { name?: string; color?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  assign: (groupId: string, positionId: string) => Promise<void>;
  unassign: (groupId: string, positionId: string) => Promise<void>;
}

/** Groups, in the same two interchangeable modes as the book itself. */
export function useGroups(
  auth: AuthState,
  portfolioId: string | null,
): GroupsState {
  const isRemote = auth.status === "authenticated" && portfolioId !== null;
  const [groups, setGroups] = useState<ApiGroup[]>(() =>
    read<ApiGroup[]>(GROUPS_KEY, []),
  );
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isRemote) {
      setGroups(read<ApiGroup[]>(GROUPS_KEY, []));
      return;
    }
    setLoading(true);
    try {
      setGroups(await fetchGroups(portfolioId!));
    } catch {
      // A groups failure must not take the sidebar down with it.
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [isRemote, portfolioId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Apply a change locally and persist it. Local mode's whole write path. */
  const writeLocal = useCallback((next: ApiGroup[]) => {
    setGroups(next);
    write(GROUPS_KEY, next);
  }, []);

  const create = useCallback(
    async (name: string, color: string) => {
      if (isRemote) {
        await createGroup(portfolioId!, name, color);
        await load();
        return;
      }
      writeLocal([
        ...read<ApiGroup[]>(GROUPS_KEY, []),
        {
          id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          color,
          created_at: Date.now(),
          positionIds: [],
        },
      ]);
    },
    [isRemote, portfolioId, load, writeLocal],
  );

  const update = useCallback(
    async (id: string, changes: { name?: string; color?: string }) => {
      if (isRemote) {
        await renameGroup(id, changes);
        await load();
        return;
      }
      writeLocal(
        read<ApiGroup[]>(GROUPS_KEY, []).map((g) =>
          g.id === id ? { ...g, ...changes } : g,
        ),
      );
    },
    [isRemote, load, writeLocal],
  );

  const remove = useCallback(
    async (id: string) => {
      if (isRemote) {
        await deleteGroup(id);
        await load();
        return;
      }
      writeLocal(read<ApiGroup[]>(GROUPS_KEY, []).filter((g) => g.id !== id));
    },
    [isRemote, load, writeLocal],
  );

  const assign = useCallback(
    async (groupId: string, positionId: string) => {
      if (isRemote) {
        await assignPositionToGroup(groupId, positionId);
        await load();
        return;
      }
      // A position belongs to at most one group, matching the server's PK.
      writeLocal(
        read<ApiGroup[]>(GROUPS_KEY, []).map((g) => ({
          ...g,
          positionIds:
            g.id === groupId
              ? [...new Set([...g.positionIds, positionId])]
              : g.positionIds.filter((id) => id !== positionId),
        })),
      );
    },
    [isRemote, load, writeLocal],
  );

  const unassign = useCallback(
    async (groupId: string, positionId: string) => {
      if (isRemote) {
        await unassignPositionFromGroup(groupId, positionId);
        await load();
        return;
      }
      writeLocal(
        read<ApiGroup[]>(GROUPS_KEY, []).map((g) =>
          g.id === groupId
            ? { ...g, positionIds: g.positionIds.filter((id) => id !== positionId) }
            : g,
        ),
      );
    },
    [isRemote, load, writeLocal],
  );

  return { groups, loading, create, update, remove, assign, unassign };
}

// ------------------------------------------------------------ transactions

export interface TransactionsState {
  transactions: LocalTransaction[];
  loading: boolean;
  reload: () => void;
}

function toLocalTransaction(t: ApiTransaction): LocalTransaction {
  return {
    id: t.id,
    ticker: t.ticker,
    positionType: t.position_type,
    side: t.side,
    quantity: t.quantity,
    price: t.price,
    fee: t.fee,
    source: t.source,
    executedAt: t.executed_at,
  };
}

/** The trade ledger, in both modes. */
export function useTransactions(
  auth: AuthState,
  portfolioId: string | null,
): TransactionsState {
  const isRemote = auth.status === "authenticated" && portfolioId !== null;
  const [transactions, setTransactions] = useState<LocalTransaction[]>(() =>
    readLocalTransactions(),
  );
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isRemote) {
      setTransactions(readLocalTransactions());
      return;
    }
    setLoading(true);
    try {
      const rows = await fetchTransactions(portfolioId!);
      setTransactions(rows.map(toLocalTransaction));
    } catch {
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }, [isRemote, portfolioId]);

  useEffect(() => {
    void load();
  }, [load]);

  // In local mode, adding a position writes a ledger row from a different
  // hook instance; subscribe so this one sees it without a reload.
  useEffect(() => {
    if (isRemote) return;
    const listener = () => setTransactions(readLocalTransactions());
    localTxListeners.add(listener);
    return () => {
      localTxListeners.delete(listener);
    };
  }, [isRemote]);

  return { transactions, loading, reload: () => void load() };
}

// ------------------------------------------------------------- preferences

const DEFAULT_PREFERENCES: Preferences = {
  displayName: null,
  theme: "dark",
  currency: "USD",
  compactNumbers: false,
  showUnrealizedPnl: true,
};

export interface PreferencesState {
  preferences: Preferences;
  loading: boolean;
  update: (changes: Partial<Preferences>) => Promise<void>;
}

/**
 * User preferences.
 *
 * Theme stays owned by `useTheme` in both modes — it is applied to the
 * document root and must survive a signed-out reload — so this hook carries
 * the rest and mirrors theme rather than driving it.
 */
export function usePreferences(auth: AuthState): PreferencesState {
  const isRemote = auth.status === "authenticated";
  const [preferences, setPreferences] = useState<Preferences>(() => ({
    ...DEFAULT_PREFERENCES,
    ...read<Partial<Preferences>>(PREFS_KEY, {}),
  }));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isRemote) {
      setPreferences({
        ...DEFAULT_PREFERENCES,
        ...read<Partial<Preferences>>(PREFS_KEY, {}),
      });
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        setPreferences(await fetchPreferences());
      } catch {
        setPreferences(DEFAULT_PREFERENCES);
      } finally {
        setLoading(false);
      }
    })();
  }, [isRemote]);

  const update = useCallback(
    async (changes: Partial<Preferences>) => {
      // Optimistic: a preference toggle that lags a round trip feels broken.
      setPreferences((current) => ({ ...current, ...changes }));

      if (!isRemote) {
        write(PREFS_KEY, {
          ...read<Partial<Preferences>>(PREFS_KEY, {}),
          ...changes,
        });
        return;
      }
      try {
        setPreferences(await updatePreferences(changes));
      } catch {
        // Keep the optimistic value; the next load reconciles it.
      }
    },
    [isRemote],
  );

  return { preferences, loading, update };
}

// ---------------------------------------------------------------- sessions

/** Active sessions. Remote-only — sessions are meaningless signed out. */
export function useSessions(auth: AuthState): {
  sessions: ApiSession[];
  loading: boolean;
  reload: () => void;
} {
  const isRemote = auth.status === "authenticated";
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isRemote) {
      setSessions([]);
      return;
    }
    setLoading(true);
    try {
      setSessions(await fetchSessions());
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [isRemote]);

  useEffect(() => {
    void load();
  }, [load]);

  return { sessions, loading, reload: () => void load() };
}

// -------------------------------------------------------------------- news

/**
 * Headlines for one ticker. Always remote: there is nothing useful to fake
 * here that would beat an honest empty state.
 */
export function useNews(ticker: string | undefined): {
  items: NewsItem[];
  available: boolean;
  loading: boolean;
} {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ticker || !isApiConfigured()) {
      setItems([]);
      setAvailable(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const result = await fetchNews(ticker);
        setItems(result.items);
        setAvailable(result.available);
      } catch {
        setItems([]);
        setAvailable(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [ticker]);

  return { items, available, loading };
}

// ---------------------------------------------------------------------- fx

/** USD -> `currency`. Divide a foreign amount by `rate` to reach USD. */
export function useFxRate(currency: string): {
  rate: number;
  stale: boolean;
  available: boolean;
} {
  const [state, setState] = useState({
    rate: 1,
    stale: false,
    available: true,
  });

  useEffect(() => {
    if (currency === "USD" || !isApiConfigured()) {
      setState({ rate: 1, stale: false, available: currency === "USD" });
      return;
    }
    void (async () => {
      try {
        const result = await fetchFxRate(currency);
        setState({ rate: result.rate, stale: result.stale, available: true });
      } catch {
        // Unconverted beats a wrong conversion, and `available` says so.
        setState({ rate: 1, stale: false, available: false });
      }
    })();
  }, [currency]);

  return state;
}
