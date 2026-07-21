/**
 * FIFO lot matching over a trade ledger.
 *
 * Sells consume the oldest open buy-lots first, which is the default cost-basis
 * method for US brokerage reporting and the only one OneBook implements. Fees
 * are folded into the lot they belong to — added to cost on a buy, deducted
 * from proceeds on a sell — so `realizedPnl` is net of costs rather than a
 * gross figure that has to be adjusted later.
 *
 * Short selling is deliberately not modeled here. A short position is a
 * negative-quantity StockPosition or BondPosition, not a ledger that oversells;
 * a sell with no remaining lots to consume simply stops.
 */

export interface LedgerTransaction {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  /** Always positive. Direction is carried by `side`. */
  quantity: number;
  price: number;
  fee: number;
  /** ISO date. */
  executedAt: string;
}

export interface RealizedLot {
  ticker: string;
  quantity: number;
  proceeds: number;
  costBasis: number;
  realizedPnl: number;
  openedAt: string;
  closedAt: string;
}

export interface OpenLot {
  ticker: string;
  quantity: number;
  /** Total cost for the remaining quantity, not per-unit. */
  costBasis: number;
  openedAt: string;
}

export interface FifoResult {
  realized: RealizedLot[];
  openLots: OpenLot[];
}

/** A buy-lot as it is consumed, tracking what remains of it. */
interface WorkingLot {
  /** The buy transaction that opened this lot. */
  transactionId: string;
  ticker: string;
  remaining: number;
  /** Per-unit cost, fee included. Kept per-unit so partial fills split cleanly. */
  costPerUnit: number;
  openedAt: string;
}

/**
 * Match a ledger into realized lots and whatever remains open.
 *
 * Transactions may arrive in any order and cover any number of tickers; each
 * ticker is matched independently, in `executedAt` order.
 */
export function computeFifo(transactions: LedgerTransaction[]): FifoResult {
  const byTicker = new Map<string, LedgerTransaction[]>();
  for (const tx of transactions) {
    const bucket = byTicker.get(tx.ticker);
    if (bucket) bucket.push(tx);
    else byTicker.set(tx.ticker, [tx]);
  }

  const realized: RealizedLot[] = [];
  const openLots: OpenLot[] = [];

  for (const [ticker, txs] of byTicker) {
    const ordered = [...txs].sort((a, b) =>
      a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : 0,
    );
    const queue: WorkingLot[] = [];

    for (const tx of ordered) {
      if (tx.quantity <= 0) continue;

      if (tx.side === "buy") {
        // The fee is part of what the shares cost, so it rides on the lot.
        queue.push({
          transactionId: tx.id,
          ticker,
          remaining: tx.quantity,
          costPerUnit: (tx.quantity * tx.price + tx.fee) / tx.quantity,
          openedAt: tx.executedAt,
        });
        continue;
      }

      // A sell's fee reduces proceeds, spread pro-rata across however many
      // lots the sell ends up touching.
      const feePerUnit = tx.fee / tx.quantity;
      let toMatch = tx.quantity;

      while (toMatch > 0 && queue.length > 0) {
        const lot = queue[0];
        const matched = Math.min(toMatch, lot.remaining);
        const proceeds = matched * tx.price - matched * feePerUnit;
        const costBasis = matched * lot.costPerUnit;

        realized.push({
          ticker,
          quantity: matched,
          proceeds,
          costBasis,
          realizedPnl: proceeds - costBasis,
          openedAt: lot.openedAt,
          closedAt: tx.executedAt,
        });

        lot.remaining -= matched;
        toMatch -= matched;
        if (lot.remaining <= 0) queue.shift();
      }
      // Any unmatched remainder is dropped: see the short-selling note above.
    }

    for (const lot of queue) {
      openLots.push({
        ticker: lot.ticker,
        quantity: lot.remaining,
        costBasis: lot.remaining * lot.costPerUnit,
        openedAt: lot.openedAt,
      });
    }
  }

  return { realized, openLots };
}
