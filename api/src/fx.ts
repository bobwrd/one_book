/**
 * FX reference rates, cache-first.
 *
 * Same shape as the market-data providers: cached in D1, stale cache beats an
 * error, and nothing configured returns null rather than throwing. Rates come
 * from frankfurter.app, which publishes ECB reference rates and needs no key —
 * so unlike price data there is no "provider not configured" state.
 *
 * Convention, used everywhere: `rate` is quote-currency units per 1 USD, e.g.
 * EUR 0.92. Divide a foreign-currency amount by the rate to reach USD;
 * multiply to go the other way.
 */

import type { Env } from "./env.js";

/** Reference rates move once a day, so there is nothing to gain from a short TTL. */
const FX_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedRate {
  rate: number;
  fetched_at: number;
}

async function readCachedRate(
  env: Env,
  currency: string,
): Promise<CachedRate | null> {
  const row = await env.DB.prepare(
    "SELECT rate, fetched_at FROM fx_rate_cache WHERE base = 'USD' AND quote = ?",
  )
    .bind(currency)
    .first<CachedRate>();
  return row ?? null;
}

/**
 * USD -> `currency` reference rate.
 *
 * Returns null only when the rate is unavailable and nothing was ever cached;
 * callers treat that as "leave the amount unconverted" rather than an error.
 */
export async function getFxRate(
  env: Env,
  currency: string,
): Promise<{ rate: number; stale: boolean } | null> {
  const quote = currency.toUpperCase();

  // Converting USD to USD is the common case and must never hit the network.
  if (quote === "USD") return { rate: 1, stale: false };

  const cached = await readCachedRate(env, quote);
  if (cached && Date.now() - cached.fetched_at < FX_TTL_MS) {
    return { rate: cached.rate, stale: false };
  }

  try {
    const url = new URL("https://api.frankfurter.app/latest");
    url.searchParams.set("from", "USD");
    url.searchParams.set("to", quote);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Frankfurter returned ${response.status}.`);

    const data = (await response.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.[quote];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`No rate returned for ${quote}.`);
    }

    await env.DB.prepare(
      "INSERT INTO fx_rate_cache (base, quote, rate, fetched_at) VALUES ('USD', ?, ?, ?) ON CONFLICT(base, quote) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at",
    )
      .bind(quote, rate, Date.now())
      .run();

    return { rate, stale: false };
  } catch {
    // A stale reference rate is far better than an unconverted total that
    // silently reads as USD.
    if (cached) return { rate: cached.rate, stale: true };
    return null;
  }
}
