import { describe, expect, it } from "vitest";
import { computeFifo } from "../src/ledger.js";
import type { LedgerTransaction } from "../src/ledger.js";

function tx(overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
  return {
    id: "t1",
    ticker: "AAPL",
    side: "buy",
    quantity: 100,
    price: 100,
    fee: 0,
    executedAt: "2026-01-01",
    ...overrides,
  };
}

describe("computeFifo", () => {
  it("leaves a lone buy fully open", () => {
    const { realized, openLots } = computeFifo([
      tx({ id: "b1", quantity: 100, price: 50 }),
    ]);

    expect(realized).toHaveLength(0);
    expect(openLots).toHaveLength(1);
    expect(openLots[0].quantity).toBe(100);
    expect(openLots[0].costBasis).toBeCloseTo(5000, 6);
  });

  it("consumes the oldest lot first", () => {
    const { realized, openLots } = computeFifo([
      tx({ id: "b1", quantity: 100, price: 50, executedAt: "2026-01-01" }),
      tx({ id: "b2", quantity: 100, price: 80, executedAt: "2026-02-01" }),
      tx({
        id: "s1",
        side: "sell",
        quantity: 100,
        price: 90,
        executedAt: "2026-03-01",
      }),
    ]);

    // The $50 lot is the one that closes, not the $80 lot.
    expect(realized).toHaveLength(1);
    expect(realized[0].costBasis).toBeCloseTo(5000, 6);
    expect(realized[0].proceeds).toBeCloseTo(9000, 6);
    expect(realized[0].realizedPnl).toBeCloseTo(4000, 6);
    expect(realized[0].openedAt).toBe("2026-01-01");
    expect(realized[0].closedAt).toBe("2026-03-01");

    expect(openLots).toHaveLength(1);
    expect(openLots[0].costBasis).toBeCloseTo(8000, 6);
  });

  it("splits a lot when the sell is smaller than it", () => {
    const { realized, openLots } = computeFifo([
      tx({ id: "b1", quantity: 100, price: 50 }),
      tx({
        id: "s1",
        side: "sell",
        quantity: 30,
        price: 70,
        executedAt: "2026-02-01",
      }),
    ]);

    expect(realized).toHaveLength(1);
    expect(realized[0].quantity).toBe(30);
    expect(realized[0].realizedPnl).toBeCloseTo(30 * 70 - 30 * 50, 6);

    // The remaining 70 keeps its original per-unit cost.
    expect(openLots[0].quantity).toBe(70);
    expect(openLots[0].costBasis).toBeCloseTo(3500, 6);
  });

  it("spans multiple lots when the sell is larger than the oldest", () => {
    const { realized, openLots } = computeFifo([
      tx({ id: "b1", quantity: 100, price: 50, executedAt: "2026-01-01" }),
      tx({ id: "b2", quantity: 100, price: 80, executedAt: "2026-02-01" }),
      tx({
        id: "s1",
        side: "sell",
        quantity: 150,
        price: 90,
        executedAt: "2026-03-01",
      }),
    ]);

    // One realized lot per (partial-)match, so a 150 sell against two lots
    // produces two rows rather than a single blended one.
    expect(realized).toHaveLength(2);
    expect(realized[0].quantity).toBe(100);
    expect(realized[0].realizedPnl).toBeCloseTo(4000, 6);
    expect(realized[1].quantity).toBe(50);
    expect(realized[1].realizedPnl).toBeCloseTo(50 * 90 - 50 * 80, 6);

    expect(openLots).toHaveLength(1);
    expect(openLots[0].quantity).toBe(50);
    expect(openLots[0].costBasis).toBeCloseTo(4000, 6);
  });

  it("folds fees into cost on a buy and out of proceeds on a sell", () => {
    const { realized } = computeFifo([
      tx({ id: "b1", quantity: 100, price: 50, fee: 10 }),
      tx({
        id: "s1",
        side: "sell",
        quantity: 100,
        price: 60,
        fee: 20,
        executedAt: "2026-02-01",
      }),
    ]);

    expect(realized[0].costBasis).toBeCloseTo(5010, 6);
    expect(realized[0].proceeds).toBeCloseTo(5980, 6);
    expect(realized[0].realizedPnl).toBeCloseTo(970, 6);
  });

  it("prorates a sell fee across every lot it touches", () => {
    const { realized } = computeFifo([
      tx({ id: "b1", quantity: 100, price: 50, executedAt: "2026-01-01" }),
      tx({ id: "b2", quantity: 100, price: 50, executedAt: "2026-02-01" }),
      tx({
        id: "s1",
        side: "sell",
        quantity: 200,
        price: 60,
        fee: 20,
        executedAt: "2026-03-01",
      }),
    ]);

    expect(realized).toHaveLength(2);
    // $20 over 200 units is $0.10/unit, so each 100-unit match absorbs $10.
    expect(realized[0].proceeds).toBeCloseTo(5990, 6);
    expect(realized[1].proceeds).toBeCloseTo(5990, 6);
  });

  it("matches each ticker independently", () => {
    const { realized, openLots } = computeFifo([
      tx({ id: "b1", ticker: "AAPL", quantity: 10, price: 100 }),
      tx({ id: "b2", ticker: "MSFT", quantity: 10, price: 200 }),
      tx({
        id: "s1",
        ticker: "MSFT",
        side: "sell",
        quantity: 10,
        price: 250,
        executedAt: "2026-02-01",
      }),
    ]);

    expect(realized).toHaveLength(1);
    expect(realized[0].ticker).toBe("MSFT");
    expect(realized[0].realizedPnl).toBeCloseTo(500, 6);

    expect(openLots).toHaveLength(1);
    expect(openLots[0].ticker).toBe("AAPL");
  });

  it("sorts by execution date regardless of input order", () => {
    const { realized } = computeFifo([
      tx({
        id: "s1",
        side: "sell",
        quantity: 100,
        price: 90,
        executedAt: "2026-03-01",
      }),
      tx({ id: "b2", quantity: 100, price: 80, executedAt: "2026-02-01" }),
      tx({ id: "b1", quantity: 100, price: 50, executedAt: "2026-01-01" }),
    ]);

    expect(realized[0].openedAt).toBe("2026-01-01");
    expect(realized[0].costBasis).toBeCloseTo(5000, 6);
  });

  it("consumes what is open and stops when a sell exceeds it", () => {
    // Ledger over-selling is not how OneBook represents a short: it consumes
    // the 50 available and drops the rest rather than opening a negative lot.
    const { realized, openLots } = computeFifo([
      tx({ id: "b1", quantity: 50, price: 40 }),
      tx({
        id: "s1",
        side: "sell",
        quantity: 200,
        price: 60,
        executedAt: "2026-02-01",
      }),
    ]);

    expect(realized).toHaveLength(1);
    expect(realized[0].quantity).toBe(50);
    expect(openLots).toHaveLength(0);
  });

  it("ignores a sell with no lots at all", () => {
    const { realized, openLots } = computeFifo([
      tx({ id: "s1", side: "sell", quantity: 100, price: 60 }),
    ]);

    expect(realized).toHaveLength(0);
    expect(openLots).toHaveLength(0);
  });

  it("returns empty results for an empty ledger", () => {
    expect(computeFifo([])).toEqual({ realized: [], openLots: [] });
  });
});
