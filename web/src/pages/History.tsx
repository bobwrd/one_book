/**
 * The trade ledger.
 *
 * The interesting part is not echoing transaction rows back — it is attaching
 * the right P&L to each one. A sell carries realized P&L from FIFO matching; a
 * buy carries whatever of that lot is still open, marked against current spot.
 */

import { useEffect, useMemo, useState } from "react";
import { computeFifo, getBroker } from "@onebook/finance";
import { useShared } from "../context.js";
import { fetchRealized, isApiConfigured, type RealizedSummary } from "../api.js";
import { formatUsd } from "../format.js";
import { useTransactions, type LocalTransaction } from "../store.js";

function sourceLabel(source: string): string {
  if (source === "manual") return "Manual";
  if (source.startsWith("broker:")) {
    const id = source.slice("broker:".length);
    return getBroker(id)?.displayName ?? id;
  }
  return source;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function History() {
  const { auth, portfolioId, spot } = useShared();
  const { transactions, loading } = useTransactions(auth, portfolioId);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"timeline" | "table">("timeline");
  const [realized, setRealized] = useState<RealizedSummary | null>(null);

  // Realized P&L for the tax year only makes sense signed in, where the server
  // owns the full ledger — so there is no local fallback to build here.
  useEffect(() => {
    if (auth.status !== "authenticated" || !portfolioId || !isApiConfigured()) {
      setRealized(null);
      return;
    }
    void (async () => {
      try {
        setRealized(await fetchRealized(portfolioId));
      } catch {
        setRealized(null);
      }
    })();
  }, [auth.status, portfolioId]);

  const fifo = useMemo(
    () =>
      computeFifo(
        transactions.map((t) => ({
          id: t.id,
          ticker: t.ticker,
          side: t.side,
          quantity: t.quantity,
          price: t.price,
          fee: t.fee,
          executedAt: isoDay(t.executedAt),
        })),
      ),
    [transactions],
  );

  /**
   * FIFO results are keyed by (ticker, date) rather than transaction id — a
   * single sell can produce several realized lots, and a buy can be split
   * across several sells — so roll them up per ticker-and-day to attach to a
   * row.
   */
  const realizedByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const lot of fifo.realized) {
      const key = `${lot.ticker}|${lot.closedAt}`;
      map.set(key, (map.get(key) ?? 0) + lot.realizedPnl);
    }
    return map;
  }, [fifo]);

  const openByKey = useMemo(() => {
    const map = new Map<string, { quantity: number; costBasis: number }>();
    for (const lot of fifo.openLots) {
      const key = `${lot.ticker}|${lot.openedAt}`;
      const current = map.get(key) ?? { quantity: 0, costBasis: 0 };
      map.set(key, {
        quantity: current.quantity + lot.quantity,
        costBasis: current.costBasis + lot.costBasis,
      });
    }
    return map;
  }, [fifo]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = q
      ? transactions.filter((t) => t.ticker.toUpperCase().includes(q))
      : transactions;
    return [...rows].sort((a, b) => b.executedAt - a.executedAt);
  }, [transactions, query]);

  // Brokers do not expose fills that predate the first sync, so any
  // broker-sourced ticker has a ledger that starts mid-story. Say so.
  const brokerTickers = useMemo(
    () =>
      [
        ...new Set(
          transactions
            .filter((t) => t.source.startsWith("broker:"))
            .map((t) => t.ticker),
        ),
      ].sort(),
    [transactions],
  );

  const rowPnl = (t: LocalTransaction) => {
    const day = isoDay(t.executedAt);
    if (t.side === "sell") {
      const value = realizedByKey.get(`${t.ticker}|${day}`);
      return value === undefined
        ? null
        : { label: "REALIZED", value };
    }
    const open = openByKey.get(`${t.ticker}|${day}`);
    if (!open || open.quantity === 0) return null;
    const price = spot[t.ticker];
    if (price === undefined) return null;
    return {
      label: "UNREALIZED",
      value: open.quantity * price - open.costBasis,
    };
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>History</h2>
        <input
          type="search"
          aria-label="Search transactions"
          placeholder="Search by symbol…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="toggle-group" role="group" aria-label="View mode">
          <button
            className={mode === "timeline" ? "active" : ""}
            onClick={() => setMode("timeline")}
          >
            Timeline
          </button>
          <button
            className={mode === "table" ? "active" : ""}
            onClick={() => setMode("table")}
          >
            Table
          </button>
        </div>
      </div>

      {realized && (
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Realized P&L ({realized.year})</span>
            <span className="tile-value">
              <span className={realized.totalRealizedPnl >= 0 ? "gain" : "loss"}>
                {formatUsd(realized.totalRealizedPnl, 0)}
              </span>
            </span>
          </div>
        </div>
      )}

      {brokerTickers.length > 0 && (
        <p className="table-note">
          Trade history for {brokerTickers.join(", ")} begins at first sync —
          brokers don't expose fills before that.
        </p>
      )}

      {loading ? (
        <div className="empty">
          <b>Loading history…</b>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <b>No transactions</b>
          {transactions.length === 0
            ? "Adding a position records a trade here."
            : `Nothing matches “${query}”.`}
        </div>
      ) : mode === "timeline" ? (
        <div className="section">
          {filtered.map((t) => {
            const pnl = rowPnl(t);
            const gross = t.quantity * t.price;
            return (
              <div className="trade-card" key={t.id}>
                <div className="trade-card-head">
                  <span className="tag">{t.positionType}</span>
                  <span className="trade-side">
                    {t.side === "buy" ? "▲ BUY" : "▼ SELL"}
                  </span>
                  <span className="trade-ticker">{t.ticker}</span>
                </div>
                <div className="trade-card-body">
                  <div>
                    <small>{t.side === "buy" ? "INVESTED" : "PROCEEDS"}</small>
                    <span>
                      {formatUsd(
                        t.side === "buy" ? gross + t.fee : gross - t.fee,
                        0,
                      )}
                    </span>
                  </div>
                  {pnl && (
                    <div>
                      <small>{pnl.label}</small>
                      <span className={pnl.value >= 0 ? "gain" : "loss"}>
                        {formatUsd(pnl.value, 0)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="trade-card-foot">
                  {sourceLabel(t.source)} · {isoDay(t.executedAt)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="section">
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Side</th>
                  <th>Symbol</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Price</th>
                  <th style={{ textAlign: "right" }}>Total value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id}>
                    <td>{isoDay(t.executedAt)}</td>
                    <td>
                      <span className="tag">{t.positionType}</span>
                    </td>
                    <td>{t.side}</td>
                    <td>{t.ticker}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {t.quantity}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatUsd(t.price)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatUsd(t.quantity * t.price, 0)}
                    </td>
                    <td>{sourceLabel(t.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
