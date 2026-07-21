/**
 * Tolerant CSV import for broker position exports.
 *
 * Broker CSVs disagree on almost everything: column names, whether shorts are
 * negative or a separate side column, and how option symbols are encoded. This
 * parser guesses a column mapping, reports its confidence, and lets the UI
 * present the mapping for confirmation before anything is imported. It never
 * silently guesses on ambiguity.
 */

import type { LedgerTransaction } from "./ledger.js";
import type { OptionRight, Position } from "./types.js";
import { DEFAULT_CONTRACT_MULTIPLIER, isBond, isOption } from "./types.js";

export type CsvField =
  | "ticker"
  | "quantity"
  | "costBasis"
  | "side"
  | "assetType"
  | "strike"
  | "expiry"
  | "right"
  | "optionSymbol";

/** Header aliases seen across common broker exports, lowercased. */
const FIELD_ALIASES: Record<CsvField, string[]> = {
  ticker: ["symbol", "ticker", "underlying", "underlying symbol", "instrument", "security"],
  quantity: ["quantity", "qty", "shares", "position", "amount", "units"],
  costBasis: ["cost basis", "costbasis", "average cost", "avg cost", "avg price", "price paid", "entry price", "trade price"],
  side: ["side", "long/short", "direction", "position type"],
  assetType: ["asset type", "type", "security type", "instrument type", "asset class"],
  strike: ["strike", "strike price"],
  expiry: ["expiry", "expiration", "expiration date", "exp date", "maturity"],
  right: ["right", "call/put", "put/call", "option type", "c/p"],
  optionSymbol: ["option symbol", "osi symbol", "occ symbol", "contract symbol"],
};

export interface ColumnMapping {
  /** Field -> zero-based column index. Absent fields are unmapped. */
  columns: Partial<Record<CsvField, number>>;
  /** 0-1. Below `CONFIRM_THRESHOLD` the UI should force manual review. */
  confidence: number;
  headers: string[];
}

export const CONFIRM_THRESHOLD = 0.7;

/** RFC 4180-ish parser: handles quoted fields, embedded commas, and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      // Skip blank lines rather than emitting phantom rows.
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }

  return rows;
}

/** Guess which column holds which field, from the header row. */
export function inferMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const columns: Partial<Record<CsvField, number>> = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [
    CsvField,
    string[],
  ][]) {
    // Exact match first, so "price paid" doesn't lose to a substring hit.
    let index = normalized.findIndex((h) => aliases.includes(h));
    if (index === -1) {
      index = normalized.findIndex((h) =>
        aliases.some((a) => h.includes(a)),
      );
    }
    if (index !== -1) columns[field] = index;
  }

  // Ticker and quantity are the only fields we truly cannot proceed without.
  const essential: CsvField[] = ["ticker", "quantity"];
  const essentialFound = essential.filter((f) => columns[f] !== undefined).length;
  const optionalFound = (["costBasis", "strike", "expiry", "right", "optionSymbol"] as CsvField[])
    .filter((f) => columns[f] !== undefined).length;

  const confidence =
    (essentialFound / essential.length) * 0.7 + Math.min(1, optionalFound / 3) * 0.3;

  return { columns, confidence, headers };
}

/**
 * Parse an OSI-standard option symbol, e.g. `AAPL  240119C00150000`:
 * root (6, space-padded) + YYMMDD + C/P + strike in thousandths (8 digits).
 */
export function parseOsiSymbol(symbol: string): {
  ticker: string;
  expiry: string;
  right: OptionRight;
  strike: number;
} | null {
  const compact = symbol.replace(/\s+/g, "");
  const match = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(compact.toUpperCase());
  if (!match) return null;

  const [, ticker, date, rightChar, strikeRaw] = match;
  const yy = Number(date.slice(0, 2));
  // OSI has no century; contracts are near-dated so 20xx is unambiguous.
  const year = 2000 + yy;
  const expiry = `${year}-${date.slice(2, 4)}-${date.slice(4, 6)}`;

  return {
    ticker,
    expiry,
    right: rightChar === "C" ? "call" : "put",
    strike: Number(strikeRaw) / 1000,
  };
}

export interface ImportRowIssue {
  row: number;
  message: string;
  raw: string[];
}

export interface ImportResult {
  positions: Position[];
  issues: ImportRowIssue[];
  mapping: ColumnMapping;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  // Strip currency symbols, thousands separators, and wrap parens-as-negative.
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const negated = /^\((.*)\)$/.exec(cleaned);
  const n = Number(negated ? `-${negated[1]}` : cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // MM/DD/YYYY and MM/DD/YY, the two forms US brokers actually emit.
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Convert parsed CSV rows into positions using a confirmed mapping.
 * Rows that cannot be interpreted are collected as issues rather than
 * aborting the import, so a single malformed line doesn't cost the user
 * the other 200.
 */
export function rowsToPositions(
  rows: string[][],
  mapping: ColumnMapping,
  opts: { defaultIv?: number; idPrefix?: string } = {},
): ImportResult {
  const defaultIv = opts.defaultIv ?? 0.3;
  const idPrefix = opts.idPrefix ?? "csv";
  const positions: Position[] = [];
  const issues: ImportRowIssue[] = [];

  const col = (row: string[], field: CsvField): string | undefined => {
    const index = mapping.columns[field];
    return index === undefined ? undefined : row[index];
  };

  // Row 0 is the header.
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id = `${idPrefix}-${r}`;

    try {
      const rawSymbol = (col(row, "ticker") ?? "").trim();
      const optionSymbol = (col(row, "optionSymbol") ?? "").trim();
      let quantity = toNumber(col(row, "quantity"));

      if (quantity === null) {
        issues.push({ row: r, message: "Missing or unparseable quantity.", raw: row });
        continue;
      }

      // A separate side column overrides sign; brokers that use one almost
      // always report quantity as an unsigned magnitude.
      const side = (col(row, "side") ?? "").trim().toLowerCase();
      if (side.startsWith("s") || side.includes("short")) {
        quantity = -Math.abs(quantity);
      } else if (side.startsWith("l") || side.includes("long")) {
        quantity = Math.abs(quantity);
      }

      const costBasis = toNumber(col(row, "costBasis")) ?? 0;

      // Option, if either an OSI symbol parses or the option columns are present.
      const osi = parseOsiSymbol(optionSymbol || rawSymbol);
      const strike = toNumber(col(row, "strike"));
      const expiryRaw = col(row, "expiry");
      const rightRaw = (col(row, "right") ?? "").trim().toLowerCase();

      const hasOptionColumns =
        strike !== null && expiryRaw !== undefined && rightRaw !== "";

      if (osi || hasOptionColumns) {
        let ticker: string;
        let expiry: string;
        let right: OptionRight;
        let strikeValue: number;

        if (osi) {
          ({ ticker, expiry, right, strike: strikeValue } = osi);
        } else {
          const normalized = normalizeDate(expiryRaw!);
          if (normalized === null) {
            issues.push({ row: r, message: `Unrecognized expiry date "${expiryRaw}".`, raw: row });
            continue;
          }
          const isCall = rightRaw.startsWith("c");
          const isPut = rightRaw.startsWith("p");
          if (!isCall && !isPut) {
            issues.push({ row: r, message: `Unrecognized option right "${rightRaw}".`, raw: row });
            continue;
          }
          ticker = rawSymbol.toUpperCase();
          expiry = normalized;
          right = isCall ? "call" : "put";
          strikeValue = strike!;
        }

        if (!ticker) {
          issues.push({ row: r, message: "Missing underlying ticker.", raw: row });
          continue;
        }

        positions.push({
          id,
          type: "option",
          ticker,
          right,
          strike: strikeValue,
          expiry,
          quantity,
          contractMultiplier: DEFAULT_CONTRACT_MULTIPLIER,
          costBasis,
          iv: defaultIv,
          // Nothing in a CSV carries implied vol, so this is always an estimate.
          ivIsEstimate: true,
        });
        continue;
      }

      if (!rawSymbol) {
        issues.push({ row: r, message: "Missing ticker.", raw: row });
        continue;
      }

      positions.push({
        id,
        type: "stock",
        ticker: rawSymbol.toUpperCase(),
        quantity,
        costBasis,
      });
    } catch (err) {
      issues.push({
        row: r,
        message: err instanceof Error ? err.message : String(err),
        raw: row,
      });
    }
  }

  return { positions, issues, mapping };
}

/** One-shot import: parse, infer, convert. The UI uses the pieces separately
 * so the user can confirm the mapping first. */
export function importCsv(
  text: string,
  opts: { defaultIv?: number; idPrefix?: string } = {},
): ImportResult {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return {
      positions: [],
      issues: [{ row: 0, message: "File is empty.", raw: [] }],
      mapping: { columns: {}, confidence: 0, headers: [] },
    };
  }
  const mapping = inferMapping(rows[0]);
  return rowsToPositions(rows, mapping, opts);
}

/**
 * Quote a single cell. Only the characters that would otherwise break the
 * parse get quoted, which keeps the common case readable in a text editor.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRows(header: string[], rows: (string | number | null)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/**
 * Export positions. Header names match the aliases `inferMapping` recognizes,
 * so a file exported here re-imports through `importCsv` without a manual
 * column mapping.
 */
export function positionsToCsv(positions: Position[]): string {
  const header = [
    "symbol",
    "asset type",
    "quantity",
    "cost basis",
    "currency",
    "strike",
    "expiry",
    "right",
    "contract multiplier",
    "coupon rate",
    "maturity",
    "face value",
    "price",
  ];

  const rows = positions.map((p) => {
    if (isOption(p)) {
      return [
        p.ticker,
        "option",
        p.quantity,
        p.costBasis,
        p.currency ?? "USD",
        p.strike,
        p.expiry,
        p.right,
        p.contractMultiplier,
        null,
        null,
        null,
        null,
      ];
    }
    if (isBond(p)) {
      // Bonds are sized by face amount, so the quantity column stays empty
      // rather than carrying a share count that does not exist.
      return [
        p.ticker,
        "bond",
        null,
        p.costBasis,
        p.currency,
        null,
        null,
        null,
        null,
        p.couponRate,
        p.maturity,
        p.faceValue,
        p.price,
      ];
    }
    return [
      p.ticker,
      "stock",
      p.quantity,
      p.costBasis,
      p.currency ?? "USD",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
  });

  return csvRows(header, rows);
}

/** Export the trade ledger, one row per transaction. */
export function transactionsToCsv(transactions: LedgerTransaction[]): string {
  const header = [
    "date",
    "symbol",
    "side",
    "quantity",
    "price",
    "fee",
    "total value",
  ];

  const rows = transactions.map((t) => [
    t.executedAt,
    t.ticker,
    t.side,
    t.quantity,
    t.price,
    t.fee,
    t.quantity * t.price + (t.side === "buy" ? t.fee : -t.fee),
  ]);

  return csvRows(header, rows);
}
