/**
 * One instrument: holdings, price history, trades, and news.
 *
 * A ticker can appear in more than one position — a stock leg and an option
 * leg, or several lots — so everything here aggregates across all of them and
 * lists the individual positions underneath.
 */

import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  bookExposure,
  DEFAULT_RISK_FREE_RATE,
  isBond,
  isOption,
  type MarketSnapshot,
  type Position,
} from "@onebook/finance";
import { PriceHistoryChart } from "../charts/PriceHistoryChart.js";
import { useShared } from "../context.js";
import {
  formatExpiry,
  formatPercent,
  formatRelativeTime,
  formatUsd,
  todayIso,
} from "../format.js";
import { useNews, useTransactions } from "../store.js";

/** Comparable total cost for a position, in the units its basis is quoted in. */
function costOf(p: Position): number {
  if (isBond(p)) return p.faceValue * (p.costBasis / 100);
  if (isOption(p)) return p.costBasis * p.quantity * p.contractMultiplier;
  return p.costBasis * p.quantity;
}

export function InstrumentDetail() {
  const { ticker = "" } = useParams();
  const symbol = ticker.toUpperCase();
  const { auth, portfolioId, positions, spot, history } = useShared();
  const { transactions } = useTransactions(auth, portfolioId);
  const news = useNews(symbol);

  const held = useMemo(
    () => positions.filter((p) => p.ticker.toUpperCase() === symbol),
    [positions, symbol],
  );

  const market: MarketSnapshot = useMemo(
    () => ({ spot, riskFreeRate: DEFAULT_RISK_FREE_RATE, asOf: todayIso() }),
    [spot],
  );

  const summary = useMemo(() => {
    if (held.length === 0) return null;
    const exposure = bookExposure(held, market);
    const cost = held.reduce((a, p) => a + costOf(p), 0);
    const value = exposure.marketValue;
    return {
      value,
      cost,
      pnl: value - cost,
      returnPct: cost === 0 ? null : (value - cost) / Math.abs(cost),
    };
  }, [held, market]);

  const series = history.find((s) => s.ticker.toUpperCase() === symbol);
  const trades = transactions.filter((t) => t.ticker.toUpperCase() === symbol);
  const bond = held.find(isBond);

  return (
    <div className="page">
      <div className="page-head">
        <h2>{symbol}</h2>
        <Link to="/instruments" className="sidebar-link">
          ← All instruments
        </Link>
      </div>

      {held.length === 0 ? (
        <div className="empty">
          <b>Not held</b>
          There are no {symbol} positions in this book.
        </div>
      ) : (
        <div className="section">
          <h3 className="section-title">Holdings</h3>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Price</span>
              <span className="tile-value">
                {bond
                  ? `${bond.price.toFixed(2)} / 100`
                  : spot[symbol] === undefined
                    ? "—"
                    : formatUsd(spot[symbol])}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Market value</span>
              <span className="tile-value">
                {formatUsd(summary?.value ?? 0, 0)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Cost</span>
              <span className="tile-value">
                {formatUsd(summary?.cost ?? 0, 0)}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Total return</span>
              <span className="tile-value">
                <span className={(summary?.pnl ?? 0) >= 0 ? "gain" : "loss"}>
                  {formatUsd(summary?.pnl ?? 0, 0)}
                  {summary?.returnPct !== null &&
                    summary?.returnPct !== undefined &&
                    ` (${formatPercent(summary.returnPct, 1)})`}
                </span>
              </span>
            </div>
            {bond && (
              <>
                <div className="tile">
                  <span className="tile-label">Coupon</span>
                  <span className="tile-value">
                    {formatPercent(bond.couponRate, 2)}
                  </span>
                </div>
                <div className="tile">
                  <span className="tile-label">Maturity</span>
                  <span className="tile-value">
                    {formatExpiry(bond.maturity)}
                  </span>
                </div>
              </>
            )}
          </div>

          {held.length > 1 && (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th style={{ textAlign: "right" }}>Size</th>
                    <th style={{ textAlign: "right" }}>Cost basis</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {held.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className="tag">{p.type}</span>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {isBond(p)
                          ? `${p.faceValue.toLocaleString("en-US")} par`
                          : p.quantity}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {p.costBasis}
                      </td>
                      <td>
                        {isOption(p)
                          ? `${p.right === "call" ? "C" : "P"}${p.strike} ${formatExpiry(p.expiry)}`
                          : isBond(p)
                            ? `${formatPercent(p.couponRate, 2)} ${formatExpiry(p.maturity)}`
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="section">
        <h3 className="section-title">Price history</h3>
        {series ? (
          <PriceHistoryChart series={series} />
        ) : (
          <div className="empty">
            <b>No price history</b>
            {bond
              ? "No market-data provider quotes bonds, so this position is valued at its own mark."
              : `Nothing cached for ${symbol} yet.`}
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="section-title">Transactions</h3>
        {trades.length === 0 ? (
          <div className="empty">
            <b>No trades recorded</b>
            Positions added before this book had a ledger won't appear here.
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Side</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Price</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.executedAt).toISOString().slice(0, 10)}</td>
                    <td>{t.side === "buy" ? "▲ BUY" : "▼ SELL"}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {t.quantity}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatUsd(t.price)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {formatUsd(t.quantity * t.price, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="section-title">Newsroom</h3>
        {!news.available ? (
          <div className="empty">
            News isn't configured for this deployment.
          </div>
        ) : news.items.length === 0 ? (
          <div className="empty">No recent news for {symbol}.</div>
        ) : (
          news.items.map((item) => (
            <a
              className="news-item"
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <div className="news-meta">
                {item.source} · {formatRelativeTime(item.publishedAt)}
              </div>
              <div className="news-headline">{item.headline}</div>
              {item.summary && (
                <div className="news-summary">{item.summary}</div>
              )}
            </a>
          ))
        )}
      </div>
    </div>
  );
}
