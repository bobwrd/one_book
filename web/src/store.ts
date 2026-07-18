/**
 * Phase 1 persistence: localStorage, no backend.
 *
 * Keeping Phase 1 genuinely backendless means the math and the interaction can
 * be validated before any auth or API exists, and it makes the Phase 2
 * migration a real, testable import path rather than a rewrite.
 */

import { useCallback, useEffect, useState } from "react";
import type { Position } from "@onebook/finance";

const POSITIONS_KEY = "onebook.positions.v1";
const SPOT_KEY = "onebook.spot.v1";

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

export function usePositions() {
  const [positions, setPositions] = useState<Position[]>(() =>
    read<Position[]>(POSITIONS_KEY, []),
  );

  useEffect(() => {
    write(POSITIONS_KEY, positions);
  }, [positions]);

  const add = useCallback((position: Position) => {
    setPositions((current) => [...current, position]);
  }, []);

  const addMany = useCallback((incoming: Position[]) => {
    setPositions((current) => [...current, ...incoming]);
  }, []);

  const remove = useCallback((id: string) => {
    setPositions((current) => current.filter((p) => p.id !== id));
  }, []);

  const update = useCallback((id: string, patch: Partial<Position>) => {
    setPositions((current) =>
      current.map((p) => (p.id === id ? ({ ...p, ...patch } as Position) : p)),
    );
  }, []);

  const clear = useCallback(() => setPositions([]), []);

  return { positions, add, addMany, remove, update, clear, setPositions };
}

/**
 * Spot prices.
 *
 * Phase 1 has no market-data connection, so prices are user-supplied and
 * default to something sane per ticker. Phase 2 replaces this hook's source
 * with the API without changing its shape.
 */
export function useSpotPrices(tickers: string[]) {
  const [spot, setSpot] = useState<Record<string, number>>(() =>
    read<Record<string, number>>(SPOT_KEY, {}),
  );

  useEffect(() => {
    write(SPOT_KEY, spot);
  }, [spot]);

  // Seed any ticker that has no price yet, so the dashboard is never blank
  // just because a price is missing.
  useEffect(() => {
    setSpot((current) => {
      const missing = tickers.filter((t) => current[t] === undefined);
      if (missing.length === 0) return current;
      const next = { ...current };
      for (const ticker of missing) next[ticker] = 100;
      return next;
    });
  }, [tickers.join(",")]);

  const setPrice = useCallback((ticker: string, price: number) => {
    setSpot((current) => ({ ...current, [ticker]: price }));
  }, []);

  return { spot, setPrice, setSpot };
}
