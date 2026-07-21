import { describe, expect, it } from "vitest";
import {
  CONFIRM_THRESHOLD,
  importCsv,
  inferMapping,
  parseCsv,
  parseOsiSymbol,
  rowsToPositions,
} from "../src/csv.js";
import type { Position } from "../src/types.js";
import { isBond, isOption } from "../src/types.js";

/**
 * CSV import never yields a bond — bonds are the one position type sized by
 * face amount rather than a quantity, so narrowing here keeps these assertions
 * honest instead of widening them to `number | undefined`.
 */
function quantityOf(p: Position): number {
  if (isBond(p)) throw new Error("expected a stock or option");
  return p.quantity;
}

describe("parseCsv", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    expect(parseCsv('a,b\n"Apple, Inc.",100')).toEqual([
      ["a", "b"],
      ["Apple, Inc.", "100"],
    ]);
  });

  it("handles escaped quotes", () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([["a"], ['He said "hi"']]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("inferMapping", () => {
  it("maps a Schwab-style header", () => {
    const m = inferMapping(["Symbol", "Quantity", "Average Cost", "Type"]);
    expect(m.columns.ticker).toBe(0);
    expect(m.columns.quantity).toBe(1);
    expect(m.columns.costBasis).toBe(2);
    expect(m.confidence).toBeGreaterThan(CONFIRM_THRESHOLD);
  });

  it("maps a Fidelity-style header", () => {
    const m = inferMapping(["Ticker", "Shares", "Cost Basis"]);
    expect(m.columns.ticker).toBe(0);
    expect(m.columns.quantity).toBe(1);
    expect(m.columns.costBasis).toBe(2);
  });

  it("maps explicit option columns", () => {
    const m = inferMapping([
      "Underlying",
      "Qty",
      "Strike",
      "Expiration",
      "Call/Put",
    ]);
    expect(m.columns.strike).toBe(2);
    expect(m.columns.expiry).toBe(3);
    expect(m.columns.right).toBe(4);
  });

  it("reports low confidence on an unrecognizable header", () => {
    const m = inferMapping(["col1", "col2", "col3"]);
    expect(m.confidence).toBeLessThan(CONFIRM_THRESHOLD);
  });

  it("prefers an exact alias match over a substring match", () => {
    // "Quantity" should win over "Quantity Available" for the quantity field.
    const m = inferMapping(["Quantity Available", "Quantity", "Symbol"]);
    expect(m.columns.quantity).toBe(1);
  });
});

describe("parseOsiSymbol", () => {
  it("parses a standard OSI symbol", () => {
    expect(parseOsiSymbol("AAPL  240119C00150000")).toEqual({
      ticker: "AAPL",
      expiry: "2024-01-19",
      right: "call",
      strike: 150,
    });
  });

  it("parses a put with a fractional strike", () => {
    expect(parseOsiSymbol("SPY   261231P00450500")).toEqual({
      ticker: "SPY",
      expiry: "2026-12-31",
      right: "put",
      strike: 450.5,
    });
  });

  it("returns null for a plain equity ticker", () => {
    expect(parseOsiSymbol("AAPL")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseOsiSymbol("AAPL 24011C0015")).toBeNull();
  });
});

describe("rowsToPositions", () => {
  it("imports plain stock rows", () => {
    const result = importCsv("Symbol,Quantity,Cost Basis\nAAPL,100,150.25");
    expect(result.issues).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
    const p = result.positions[0];
    expect(p.type).toBe("stock");
    expect(p.ticker).toBe("AAPL");
    expect(quantityOf(p)).toBe(100);
    expect(p.costBasis).toBe(150.25);
  });

  it("imports option rows from explicit columns", () => {
    const result = importCsv(
      "Symbol,Quantity,Strike,Expiration,Call/Put,Cost Basis\nAAPL,2,150,2026-06-19,Call,5.50",
    );
    expect(result.issues).toHaveLength(0);
    const p = result.positions[0];
    expect(isOption(p)).toBe(true);
    if (!isOption(p)) throw new Error("expected an option");
    expect(p.strike).toBe(150);
    expect(p.expiry).toBe("2026-06-19");
    expect(p.right).toBe("call");
    expect(p.contractMultiplier).toBe(100);
    // A CSV never carries implied vol, so it must be flagged as an estimate.
    expect(p.ivIsEstimate).toBe(true);
  });

  it("imports option rows from an OSI symbol", () => {
    const result = importCsv(
      "Option Symbol,Symbol,Quantity\nAAPL  260619C00150000,AAPL,2",
    );
    const p = result.positions[0];
    if (!isOption(p)) throw new Error("expected an option");
    expect(p.strike).toBe(150);
    expect(p.right).toBe("call");
    expect(p.expiry).toBe("2026-06-19");
  });

  it("applies a separate side column to unsigned quantities", () => {
    const result = importCsv("Symbol,Quantity,Side\nAAPL,100,Short");
    expect(quantityOf(result.positions[0])).toBe(-100);
  });

  it("preserves an already-negative quantity", () => {
    const result = importCsv("Symbol,Quantity\nAAPL,-100");
    expect(quantityOf(result.positions[0])).toBe(-100);
  });

  it("normalizes US date formats", () => {
    const result = importCsv(
      "Symbol,Quantity,Strike,Expiration,Call/Put\nAAPL,1,150,06/19/2026,C",
    );
    const p = result.positions[0];
    if (!isOption(p)) throw new Error("expected an option");
    expect(p.expiry).toBe("2026-06-19");
  });

  it("strips currency formatting from numbers", () => {
    const result = importCsv('Symbol,Quantity,Cost Basis\nAAPL,"1,500","$150.25"');
    expect(quantityOf(result.positions[0])).toBe(1500);
    expect(result.positions[0].costBasis).toBe(150.25);
  });

  it("reads parenthesized numbers as negative", () => {
    const result = importCsv("Symbol,Quantity\nAAPL,(100)");
    expect(quantityOf(result.positions[0])).toBe(-100);
  });

  it("collects bad rows as issues without losing the good ones", () => {
    const result = importCsv(
      "Symbol,Quantity\nAAPL,100\nMSFT,notanumber\nGOOG,50",
    );
    expect(result.positions).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].row).toBe(2);
  });

  it("flags a row with an unparseable expiry", () => {
    const result = importCsv(
      "Symbol,Quantity,Strike,Expiration,Call/Put\nAAPL,1,150,someday,C",
    );
    expect(result.positions).toHaveLength(0);
    expect(result.issues[0].message).toContain("expiry");
  });

  it("flags a row with an unrecognized option right", () => {
    const result = importCsv(
      "Symbol,Quantity,Strike,Expiration,Call/Put\nAAPL,1,150,2026-06-19,X",
    );
    expect(result.issues[0].message).toContain("right");
  });

  it("reports an empty file as an issue rather than throwing", () => {
    const result = importCsv("");
    expect(result.positions).toHaveLength(0);
    expect(result.issues[0].message).toBe("File is empty.");
  });

  it("honors a manually corrected mapping", () => {
    const rows = parseCsv("colA,colB\nAAPL,100");
    const corrected = {
      columns: { ticker: 0, quantity: 1 },
      confidence: 1,
      headers: ["colA", "colB"],
    };
    const result = rowsToPositions(rows, corrected);
    expect(result.positions[0].ticker).toBe("AAPL");
    expect(quantityOf(result.positions[0])).toBe(100);
  });

  it("uppercases tickers for consistent matching", () => {
    const result = importCsv("Symbol,Quantity\naapl,100");
    expect(result.positions[0].ticker).toBe("AAPL");
  });
});
