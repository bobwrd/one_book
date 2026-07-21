/**
 * Persistent left navigation.
 *
 * Beyond the route links, this is where the book's own organization lives:
 * user-defined groups, and the sources positions actually came from. Both are
 * derived from data the app already has — Sources needs no fetch at all, since
 * every position already carries its `source`.
 */

import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  bookExposure,
  DEFAULT_RISK_FREE_RATE,
  getBroker,
  type MarketSnapshot,
  type Position,
} from "@onebook/finance";
import type { ApiGroup } from "../api.js";
import { formatCompact, formatUsd, todayIso } from "../format.js";
import type { AuthState } from "../store.js";

interface Props {
  auth: AuthState;
  positions: Position[];
  spot: Record<string, number>;
  groups: ApiGroup[];
  compactNumbers: boolean;
  onManageGroups: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}

/** A position's source label, from the vocabulary already in the data. */
function sourceLabel(source: string | undefined): string {
  if (!source || source === "manual") return "Manual";
  if (source.startsWith("broker:")) {
    const id = source.slice("broker:".length);
    return getBroker(id)?.displayName ?? id;
  }
  return source;
}

export function Sidebar({
  auth,
  positions,
  spot,
  groups,
  compactNumbers,
  onManageGroups,
  onSignIn,
  onSignOut,
}: Props) {
  const [openSource, setOpenSource] = useState<string | null>(null);

  const market: MarketSnapshot = useMemo(
    () => ({ spot, riskFreeRate: DEFAULT_RISK_FREE_RATE, asOf: todayIso() }),
    [spot],
  );

  // One exposure pass serves both the total and the per-group subtotals.
  const valueByPosition = useMemo(() => {
    const map = new Map<string, number>();
    if (positions.length === 0) return map;
    for (const e of bookExposure(positions, market).positions) {
      map.set(e.positionId, e.marketValue);
    }
    return map;
  }, [positions, market]);

  const total = useMemo(
    () => [...valueByPosition.values()].reduce((a, v) => a + v, 0),
    [valueByPosition],
  );

  const bySource = useMemo(() => {
    const map = new Map<string, Position[]>();
    for (const p of positions) {
      const key = (p as Position & { source?: string }).source ?? "manual";
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return [...map.entries()];
  }, [positions]);

  const money = compactNumbers ? formatCompact : (n: number) => formatUsd(n, 0);

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="sidebar-head">
        <span className="brand">
          one<em>book</em>
        </span>
        <div className="sidebar-total">
          <span className="sidebar-total-value">{money(total)}</span>
          <small>{positions.length} positions</small>
        </div>
      </div>

      <div className="sidebar-nav">
        <NavLink to="/" end className="sidebar-link">
          Overview
        </NavLink>
        <NavLink to="/history" className="sidebar-link">
          History
        </NavLink>
        <NavLink to="/instruments" className="sidebar-link">
          Instruments
        </NavLink>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Groups</div>
        {groups.length === 0 ? (
          <p className="sidebar-empty">No groups yet.</p>
        ) : (
          groups.map((group) => {
            const value = group.positionIds.reduce(
              (a, id) => a + (valueByPosition.get(id) ?? 0),
              0,
            );
            return (
              <div className="sidebar-row" key={group.id}>
                <span
                  className={`swatch swatch-${group.color}`}
                  aria-hidden="true"
                />
                <span className="sidebar-row-name">{group.name}</span>
                <span className="sidebar-row-value">{money(value)}</span>
              </div>
            );
          })
        )}
        <button className="sidebar-action" onClick={onManageGroups}>
          Manage groups
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Sources</div>
        {bySource.length === 0 ? (
          <p className="sidebar-empty">No positions yet.</p>
        ) : (
          bySource.map(([source, items]) => {
            const open = openSource === source;
            const tickers = [...new Set(items.map((p) => p.ticker))].sort();
            return (
              <div key={source}>
                <button
                  className="sidebar-row sidebar-row-button"
                  aria-expanded={open}
                  onClick={() => setOpenSource(open ? null : source)}
                >
                  <span className="sidebar-row-name">
                    {sourceLabel(source)}
                  </span>
                  <span className="sidebar-row-value">{tickers.length}</span>
                </button>
                {open && (
                  <div className="sidebar-sublist">
                    {tickers.map((ticker) => (
                      <NavLink
                        key={ticker}
                        to={`/instruments/${ticker}`}
                        className="sidebar-sublink"
                      >
                        {ticker}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="sidebar-foot">
        <NavLink to="/settings" className="sidebar-link">
          Settings
        </NavLink>
        {auth.status === "authenticated" ? (
          <button className="sidebar-action" onClick={onSignOut}>
            Sign out
          </button>
        ) : (
          <button className="sidebar-action" onClick={onSignIn}>
            Sign in
          </button>
        )}
      </div>
    </nav>
  );
}
