/**
 * D1 access for the trade ledger.
 *
 * Deliberately thin: the FIFO matching that turns these rows into realized and
 * unrealized P&L lives in `@onebook/finance`, so the Worker and the browser
 * compute the same numbers from the same code.
 */

import { randomId } from "./crypto.js";
import type { Env } from "./env.js";

export interface NewTransaction {
  ticker: string;
  positionType: "stock" | "option" | "bond";
  side: "buy" | "sell";
  quantity: number;
  price: number;
  currency?: string;
  fee?: number;
  strike?: number | null;
  expiry?: string | null;
  right?: "call" | "put" | null;
  source?: string;
  executedAt?: number;
}

export interface TransactionRow {
  id: string;
  portfolio_id: string;
  ticker: string;
  position_type: "stock" | "option" | "bond";
  side: "buy" | "sell";
  quantity: number;
  price: number;
  currency: string;
  fee: number;
  strike: number | null;
  expiry: string | null;
  right: "call" | "put" | null;
  source: string;
  executed_at: number;
  created_at: number;
}

/** Insert one transaction, returning its id. */
export async function recordTransaction(
  env: Env,
  portfolioId: string,
  tx: NewTransaction,
): Promise<string> {
  const id = randomId("txn");
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO transactions
      (id, portfolio_id, ticker, position_type, side, quantity, price, currency, fee, strike, expiry, right, source, executed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      portfolioId,
      tx.ticker.toUpperCase(),
      tx.positionType,
      tx.side,
      // Quantity is stored unsigned; direction is carried by `side`, which is
      // what the FIFO matcher expects.
      Math.abs(tx.quantity),
      tx.price,
      tx.currency ?? "USD",
      tx.fee ?? 0,
      tx.strike ?? null,
      tx.expiry ?? null,
      tx.right ?? null,
      tx.source ?? "manual",
      tx.executedAt ?? now,
      now,
    )
    .run();

  return id;
}

/** Insert several transactions in one batch. Returns the ids, in input order. */
export async function recordTransactions(
  env: Env,
  portfolioId: string,
  txs: NewTransaction[],
): Promise<string[]> {
  if (txs.length === 0) return [];

  const now = Date.now();
  const ids: string[] = [];
  const statement = env.DB.prepare(
    `INSERT INTO transactions
      (id, portfolio_id, ticker, position_type, side, quantity, price, currency, fee, strike, expiry, right, source, executed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const statements = txs.map((tx) => {
    const id = randomId("txn");
    ids.push(id);
    return statement.bind(
      id,
      portfolioId,
      tx.ticker.toUpperCase(),
      tx.positionType,
      tx.side,
      Math.abs(tx.quantity),
      tx.price,
      tx.currency ?? "USD",
      tx.fee ?? 0,
      tx.strike ?? null,
      tx.expiry ?? null,
      tx.right ?? null,
      tx.source ?? "manual",
      tx.executedAt ?? now,
      now,
    );
  });

  await env.DB.batch(statements);
  return ids;
}

/** Transactions for a portfolio, newest first, optionally one ticker only. */
export async function listTransactions(
  env: Env,
  portfolioId: string,
  ticker?: string,
): Promise<TransactionRow[]> {
  const { results } = ticker
    ? await env.DB.prepare(
        "SELECT * FROM transactions WHERE portfolio_id = ? AND ticker = ? ORDER BY executed_at DESC",
      )
        .bind(portfolioId, ticker.toUpperCase())
        .all<TransactionRow>()
    : await env.DB.prepare(
        "SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at DESC",
      )
        .bind(portfolioId)
        .all<TransactionRow>();

  return results ?? [];
}

/** Shape a stored row for `computeFifo`, which works in ISO dates. */
export function toLedgerTransaction(row: TransactionRow) {
  return {
    id: row.id,
    ticker: row.ticker,
    side: row.side,
    quantity: row.quantity,
    price: row.price,
    fee: row.fee,
    executedAt: new Date(row.executed_at).toISOString().slice(0, 10),
  };
}
