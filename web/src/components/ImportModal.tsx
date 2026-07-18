/**
 * CSV import with a confirmation step.
 *
 * The parser guesses a column mapping, but never imports on a guess alone:
 * the user sees the mapping and the parsed preview first. Low-confidence
 * guesses are called out explicitly rather than silently applied.
 */

import { useState } from "react";
import {
  CONFIRM_THRESHOLD,
  inferMapping,
  parseCsv,
  rowsToPositions,
  type ColumnMapping,
  type CsvField,
  type ImportResult,
} from "@onebook/finance";
import { isOption, type Position } from "@onebook/finance";

interface Props {
  onImport: (positions: Position[]) => void;
  onClose: () => void;
}

const FIELD_LABELS: Record<CsvField, string> = {
  ticker: "Ticker / underlying",
  quantity: "Quantity",
  costBasis: "Cost basis",
  side: "Side (long/short)",
  assetType: "Asset type",
  strike: "Strike",
  expiry: "Expiry",
  right: "Call / put",
  optionSymbol: "Option symbol",
};

export function ImportModal({ onImport, onClose }: Props) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.length < 2) {
        return setError("That file has no data rows.");
      }
      const inferred = inferMapping(parsed[0]);
      setRows(parsed);
      setMapping(inferred);
      setPreview(rowsToPositions(parsed, inferred));
    } catch {
      setError("Could not read that file.");
    }
  }

  function remap(field: CsvField, columnIndex: number | null) {
    if (!rows || !mapping) return;
    const columns = { ...mapping.columns };
    if (columnIndex === null) delete columns[field];
    else columns[field] = columnIndex;

    const next = { ...mapping, columns };
    setMapping(next);
    setPreview(rowsToPositions(rows, next));
  }

  const lowConfidence =
    mapping !== null && mapping.confidence < CONFIRM_THRESHOLD;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 620 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Import positions from CSV</h2>

        {error && <div className="error-banner">{error}</div>}

        {!rows && (
          <>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 0 }}>
              Export your positions from any broker and drop the file here.
              Column names vary between brokers, so the mapping is shown for
              confirmation before anything is imported.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </>
        )}

        {rows && mapping && preview && (
          <>
            {lowConfidence && (
              <div className="error-banner">
                The column mapping could not be determined confidently. Please
                check each field below before importing.
              </div>
            )}

            <h3 style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Column mapping
            </h3>
            <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
              {(Object.keys(FIELD_LABELS) as CsvField[]).map((field) => (
                <div
                  key={field}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {FIELD_LABELS[field]}
                  </span>
                  <select
                    value={mapping.columns[field] ?? ""}
                    onChange={(e) =>
                      remap(
                        field,
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                  >
                    <option value="">— not present —</option>
                    {mapping.headers.map((header, index) => (
                      <option key={index} value={index}>
                        {header || `Column ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <h3 style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Preview — {preview.positions.length} position
              {preview.positions.length === 1 ? "" : "s"}
              {preview.issues.length > 0 && (
                <span style={{ color: "var(--warn)" }}>
                  {" "}
                  · {preview.issues.length} row
                  {preview.issues.length === 1 ? "" : "s"} skipped
                </span>
              )}
            </h3>

            <div className="scroll-x" style={{ maxHeight: 180 }}>
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Type</th>
                    <th>Qty</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.positions.slice(0, 25).map((p) => (
                    <tr key={p.id}>
                      <td>{p.ticker}</td>
                      <td>{p.type}</td>
                      <td className="num">{p.quantity}</td>
                      <td className="num">
                        {isOption(p)
                          ? `${p.right === "call" ? "C" : "P"}${p.strike} ${p.expiry}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.issues.length > 0 && (
              <details style={{ marginTop: 10, fontSize: 11 }}>
                <summary style={{ cursor: "pointer", color: "var(--warn)" }}>
                  Skipped rows
                </summary>
                <ul style={{ paddingLeft: 18, color: "var(--text-dim)" }}>
                  {preview.issues.slice(0, 20).map((issue) => (
                    <li key={issue.row}>
                      Row {issue.row}: {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                disabled={preview.positions.length === 0}
                onClick={() => {
                  onImport(preview.positions);
                  onClose();
                }}
              >
                Import {preview.positions.length}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
