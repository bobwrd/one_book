/**
 * Deterministic synthetic price history for Phase 1.
 *
 * Correlation and VaR need a return series, and Phase 1 deliberately has no
 * market-data connection. This generates a stable per-ticker random walk so
 * those panels are exercisable offline.
 *
 * These are NOT real prices. The UI labels anything derived from them, and
 * Phase 2 replaces this module wholesale with cached closes from the API.
 */

import type { PriceSeries } from "@onebook/finance";

const DAYS = 252;

/** FNV-1a, so a ticker always maps to the same series. */
function seedFrom(ticker: string): number {
  let hash = 2166136261;
  for (let i = 0; i < ticker.length; i++) {
    hash ^= ticker.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function demoHistory(
  ticker: string,
  currentPrice: number,
): PriceSeries {
  let state = seedFrom(ticker);
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // Per-ticker volatility, so a heatmap of several names is not uniform.
  const dailyVol = 0.008 + (seedFrom(ticker) % 100) / 5000;

  // Walk backwards from today's price so the series ends at the real spot.
  const closes: number[] = [currentPrice];
  for (let i = 1; i < DAYS; i++) {
    const u1 = random() || 1e-12;
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    closes.push(closes[i - 1] * Math.exp(-dailyVol * z));
  }
  closes.reverse();

  const dates: string[] = [];
  const today = Date.now();
  for (let i = DAYS - 1; i >= 0; i--) {
    dates.push(
      new Date(today - i * 86_400_000).toISOString().slice(0, 10),
    );
  }

  return { ticker, dates, closes };
}
