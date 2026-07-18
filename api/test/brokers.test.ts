/**
 * Adapter tests run against recorded fixture payloads, never live brokers.
 * The shapes here are the ones that actually break naive parsers: a single
 * position returned as an object instead of an array, direction split across
 * two fields, and total-vs-per-unit cost basis.
 */

import { describe, expect, it } from "vitest";
import { toNormalized as alpacaNormalize } from "../src/brokers/alpaca.js";
import { toNormalized as tradierNormalize } from "../src/brokers/tradier.js";
import { toNormalized as schwabNormalize } from "../src/brokers/schwab.js";

describe("Alpaca normalization", () => {
  it("normalizes a long stock position", () => {
    const p = alpacaNormalize({
      symbol: "AAPL",
      qty: "100",
      side: "long",
      avg_entry_price: "150.25",
      asset_class: "us_equity",
    });
    expect(p).toEqual({
      type: "stock",
      ticker: "AAPL",
      quantity: 100,
      costBasis: 150.25,
    });
  });

  it("signs a short position negatively", () => {
    const p = alpacaNormalize({
      symbol: "TSLA",
      qty: "-50",
      side: "short",
      avg_entry_price: "200",
      asset_class: "us_equity",
    });
    expect(p.quantity).toBe(-50);
  });

  it("normalizes an option position from its OSI symbol", () => {
    const p = alpacaNormalize({
      symbol: "AAPL  260619C00150000",
      qty: "2",
      side: "long",
      avg_entry_price: "5.50",
      asset_class: "us_option",
    });
    expect(p).toEqual({
      type: "option",
      ticker: "AAPL",
      quantity: 2,
      costBasis: 5.5,
      strike: 150,
      expiry: "2026-06-19",
      right: "call",
      contractMultiplier: 100,
      ivIsEstimate: true,
    });
  });

  it("trusts the side field over the sign on quantity", () => {
    // Alpaca signs qty, but if the two ever disagree, side is authoritative.
    const p = alpacaNormalize({
      symbol: "AAPL",
      qty: "100",
      side: "short",
      avg_entry_price: "150",
      asset_class: "us_equity",
    });
    expect(p.quantity).toBe(-100);
  });
});

describe("Tradier normalization", () => {
  it("converts total cost basis to per-share", () => {
    const p = tradierNormalize({
      symbol: "AAPL",
      quantity: 100,
      cost_basis: 15_025,
    });
    expect(p.costBasis).toBe(150.25);
  });

  it("converts option cost basis to per-contract-unit", () => {
    // 2 contracts at $5.50/share = $1,100 total across 200 share-units.
    const p = tradierNormalize({
      symbol: "AAPL  260619C00150000",
      quantity: 2,
      cost_basis: 1_100,
    });
    expect(p.type).toBe("option");
    expect(p.costBasis).toBe(5.5);
  });

  it("preserves a short quantity", () => {
    const p = tradierNormalize({
      symbol: "AAPL",
      quantity: -100,
      cost_basis: -15_000,
    });
    expect(p.quantity).toBe(-100);
  });

  it("does not divide by zero on a zero-quantity row", () => {
    const p = tradierNormalize({ symbol: "AAPL", quantity: 0, cost_basis: 0 });
    expect(Number.isFinite(p.costBasis)).toBe(true);
  });
});

describe("Schwab normalization", () => {
  it("combines the split long/short quantity fields", () => {
    const p = schwabNormalize({
      instrument: { symbol: "AAPL", assetType: "EQUITY" },
      longQuantity: 100,
      shortQuantity: 0,
      averagePrice: 150.25,
    });
    expect(p).toEqual({
      type: "stock",
      ticker: "AAPL",
      quantity: 100,
      costBasis: 150.25,
    });
  });

  it("reads a short position from the shortQuantity field", () => {
    const p = schwabNormalize({
      instrument: { symbol: "AAPL", assetType: "EQUITY" },
      longQuantity: 0,
      shortQuantity: 50,
      averagePrice: 150,
    });
    expect(p?.quantity).toBe(-50);
  });

  it("drops a fully closed position", () => {
    const p = schwabNormalize({
      instrument: { symbol: "AAPL", assetType: "EQUITY" },
      longQuantity: 0,
      shortQuantity: 0,
      averagePrice: 150,
    });
    expect(p).toBeNull();
  });

  it("normalizes an option and trims the expiry timestamp to a date", () => {
    const p = schwabNormalize({
      instrument: {
        symbol: "AAPL  260619C00150000",
        assetType: "OPTION",
        underlyingSymbol: "AAPL",
        putCall: "CALL",
        strikePrice: 150,
        expirationDate: "2026-06-19T00:00:00.000+00:00",
      },
      longQuantity: 2,
      shortQuantity: 0,
      averagePrice: 5.5,
    });
    expect(p?.expiry).toBe("2026-06-19");
    expect(p?.ticker).toBe("AAPL");
    expect(p?.right).toBe("call");
  });

  it("drops an option row missing its contract definition", () => {
    const p = schwabNormalize({
      instrument: {
        symbol: "AAPL_061926C150",
        assetType: "OPTION",
        underlyingSymbol: "AAPL",
        putCall: "CALL",
        // No strike or expiry: unusable for pricing.
      },
      longQuantity: 2,
      shortQuantity: 0,
      averagePrice: 5.5,
    });
    expect(p).toBeNull();
  });
});
