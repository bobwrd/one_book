/**
 * State shared by every routed page.
 *
 * `App` computes this once and hands it to `<Outlet context={...} />`; each
 * page reads what it needs with `useShared()`. Using React Router's own
 * outlet-context is deliberate — it is the idiomatic tool for "share data with
 * all child routes" and needs no extra provider component.
 */

import { useOutletContext } from "react-router-dom";
import type { Position, PriceSeries } from "@onebook/finance";
import type { AuthState } from "./store.js";

export interface SharedBookState {
  auth: AuthState;
  apiUp: boolean;
  refreshAuth: () => Promise<void>;
  signOut: () => Promise<void>;
  portfolioId: string | null;

  positions: Position[];
  isSample: boolean;
  loading: boolean;
  bookError: string | null;
  add: (position: Position) => void;
  addMany: (positions: Position[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  reload: () => void;

  tickers: string[];
  spot: Record<string, number>;
  setPrice: (ticker: string, price: number) => void;
  live: boolean;

  history: PriceSeries[];
  isReal: boolean;
  historyError: string | null;
  feed: string | null;

  theme: "dark" | "light";
  toggleTheme: () => void;
}

export function useShared(): SharedBookState {
  return useOutletContext<SharedBookState>();
}
