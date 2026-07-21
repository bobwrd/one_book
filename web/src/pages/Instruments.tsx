/**
 * The holdings table — every position, searchable, flat or grouped by source.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  bookExposure,
  DEFAULT_RISK_FREE_RATE,
  getBroker,
  isBond,
  isOption,
  type MarketSnapshot,
  type Position,
} from "@onebook/finance";
import { useShared } from "../context.js";
import { formatUsd, todayIso } from "../format.js";
import { useGroups, usePreferences } from "../store.js";

function sourceLabel(source: string | undefined): string {
  if (!source || source === "manual") return "Manual";
  if (source.startsWith("broker:")) {
    const id = source.slice("broker:".length);
    return getBroker(id)?.displayName ?? id;
  }
  return source;
}

/** Size reads differently per type: shares, contracts, or face amount. */
function sizeOf(p: Position): string {
  if (isBond(p)) return `${p.faceValue.toLocaleString("en-US")} par`;
  if (isOption(p)) return `${p.quantity} ct`;
  return `${p.quantity} sh`;
}

function priceOf(p: Position, spot: Record<string, number>): number | null {
  if (isBond(p)) return p.price;
  return spot[p.ticker] ?? null;
}

export function Instruments() {
  const { auth, portfolioId, positions, spot } = useShared();
  const navigate = useNavigate();
  const { groups } = useGroups(auth, portfolioId);
  const { preferences } = usePreferences(auth);

  const [query, setQuery] = useState("");
  const [bySource, setBySource] = useState(false);

  const market: MarketSnapshot = useMemo(
    () => ({ spot, riskFreeRate: DEFAULT_RISK_FREE_RATE, asOf: todayIso() }),
    [spot],
  );

  const valueById = useMemo(() => {
    const map = new Map<string, number>();
    if (positions.length === 0) return map;
    for (const e of bookExposure(positions, market).positions) {
      map.set(e.positionId, e.marketValue);
    }
    return map;
  }, [positions, market]);

  const groupByPosition = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const id of g.positionIds) map.set(id, g.name);
    }
    return map;
  }, [groups]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return q ? positions.filter((p) => p.ticker.toUpperCase().includes(q)) : positions;
  }, [positions, query]);

  const sections = useMemo(() => {
    if (!bySource) return [{ label: null as string | null, items: filtered }];
    const map = new Map<string, Position[]>();
    for (const p of filtered) {
      const key = (p as Position & { source?: string }).source ?? "manual";
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return [...map.entries()].map(([source, items]) => ({
      label: sourceLabel(source),
      items,
    }));
  }, [filtered, bySource]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Instruments</h2>
        <input
          type="search"
          aria-label="Search instruments"
          placeholder="Search by symbol…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="toggle-group" role="group" aria-label="Grouping">
          <button
            className={bySource ? "" : "active"}
            onClick={() => setBySource(false)}
          >
            Flat
          </button>
          <button
            className={bySource ? "active" : ""}
            onClick={() => setBySource(true)}
          >
            By source
          </button>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="empty">
          <b>No positions</b>
          Add one from the Overview page to see it here.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <b>No matches</b>
          Nothing in this book matches “{query}”.
        </div>
      ) : (
        sections.map((section) => (
          <div className="section" key={section.label ?? "all"}>
            {section.label && (
              <h3 className="section-title">{section.label}</h3>
            )}
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Type</th>
                    <th>Group</th>
                    <th style={{ textAlign: "right" }}>Qty / Face</th>
                    <th style={{ textAlign: "right" }}>Price</th>
                    <th
                      style={{ textAlign: "right" }}
                      title="OneBook does not track a prior close separately from the current spot, so a true day-over-day move is not available."
                    >
                      Day Δ
                    </th>
                    <th style={{ textAlign: "right" }}>Value</th>
                    {preferences.showUnrealizedPnl && (
                      <th style={{ textAlign: "right" }}>Unrealized</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((p) => {
                    const price = priceOf(p, spot);
                    const value = valueById.get(p.id);
                    // Cost basis is per share, per contract-unit, or per 100
                    // par — so the comparable cost has to be built per type.
                    const cost = isBond(p)
                      ? p.faceValue * (p.costBasis / 100)
                      : isOption(p)
                        ? p.costBasis * p.quantity * p.contractMultiplier
                        : p.costBasis * p.quantity;
                    const unrealized =
                      value === undefined ? null : value - cost;

                    return (
                      <tr
                        key={p.id}
                        className="row-link"
                        onClick={() => navigate(`/instruments/${p.ticker}`)}
                      >
                        <td>{p.ticker}</td>
                        <td>
                          <span className="tag">{p.type}</span>
                        </td>
                        <td>{groupByPosition.get(p.id) ?? "—"}</td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {sizeOf(p)}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {price === null ? "—" : formatUsd(price)}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          —
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {value === undefined ? "—" : formatUsd(value, 0)}
                        </td>
                        {preferences.showUnrealizedPnl && (
                          <td className="num" style={{ textAlign: "right" }}>
                            {unrealized === null ? (
                              "—"
                            ) : (
                              <span className={unrealized >= 0 ? "gain" : "loss"}>
                                {formatUsd(unrealized, 0)}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
