/**
 * The demo book shown before you connect anything.
 *
 * Chosen to make the app's whole argument visible on first load rather than
 * to look busy. Every position earns its place:
 *
 *   AAPL  long stock + short calls   a covered call, so delta-equivalent
 *                                    exposure nets down below the share count
 *   NVDA  long stock + long put      a protective put: the payoff curve bends
 *                                    flat on the downside
 *   SPY   short strangle             net short gamma, so the risk callout
 *                                    fires and the curve bends against you
 *   MSFT  plain stock                a second uncorrelated-ish name so the
 *                                    correlation matrix has something to say
 *
 * Drag the price slider on this book and every panel moves at once, which is
 * the thing worth seeing.
 */

import {
  DEFAULT_CONTRACT_MULTIPLIER,
  type Position,
} from "@onebook/finance";

export const SAMPLE_SPOT: Record<string, number> = {
  AAPL: 232,
  NVDA: 178,
  SPY: 611,
  MSFT: 498,
};

/** Nearest monthly-ish expiry N days out, as an ISO date. */
function expiryIn(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sampleBook(): Position[] {
  return [
    {
      id: "demo-aapl-stock",
      type: "stock",
      ticker: "AAPL",
      quantity: 200,
      costBasis: 198.4,
    },
    {
      // Covered call: this is what nets the AAPL exposure down.
      id: "demo-aapl-call",
      type: "option",
      ticker: "AAPL",
      right: "call",
      strike: 250,
      expiry: expiryIn(38),
      quantity: -2,
      contractMultiplier: DEFAULT_CONTRACT_MULTIPLIER,
      costBasis: 4.15,
      iv: 0.27,
      ivIsEstimate: true,
    },
    {
      id: "demo-nvda-stock",
      type: "stock",
      ticker: "NVDA",
      quantity: 150,
      costBasis: 141.2,
    },
    {
      // Protective put: flattens the downside of the NVDA stock.
      id: "demo-nvda-put",
      type: "option",
      ticker: "NVDA",
      right: "put",
      strike: 165,
      expiry: expiryIn(66),
      quantity: 1,
      contractMultiplier: DEFAULT_CONTRACT_MULTIPLIER,
      costBasis: 7.8,
      iv: 0.42,
      ivIsEstimate: true,
    },
    {
      // Short strangle on the index: the short-gamma position in the book.
      id: "demo-spy-call",
      type: "option",
      ticker: "SPY",
      right: "call",
      strike: 640,
      expiry: expiryIn(24),
      quantity: -3,
      contractMultiplier: DEFAULT_CONTRACT_MULTIPLIER,
      costBasis: 3.4,
      iv: 0.16,
      ivIsEstimate: true,
    },
    {
      id: "demo-spy-put",
      type: "option",
      ticker: "SPY",
      right: "put",
      strike: 575,
      expiry: expiryIn(24),
      quantity: -3,
      contractMultiplier: DEFAULT_CONTRACT_MULTIPLIER,
      costBasis: 4.05,
      iv: 0.19,
      ivIsEstimate: true,
    },
    {
      id: "demo-msft-stock",
      type: "stock",
      ticker: "MSFT",
      quantity: 60,
      costBasis: 452.1,
    },
  ];
}

/** Every id the sample book uses, so it can be recognized and cleared. */
export function isSampleBook(positions: { id: string }[]): boolean {
  return positions.length > 0 && positions.every((p) => p.id.startsWith("demo-"));
}
