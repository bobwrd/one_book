/**
 * Settings: profile, appearance, connected accounts, security, and data.
 *
 * Everything here works signed out except Connected Accounts (which needs the
 * Worker to hold credentials) and Security (sessions do not exist without an
 * account). There is no Notifications section: OneBook has no email delivery
 * wired up, and a preferences UI with nothing behind it is worse than none.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectPanel, type Connection } from "../components/ConnectModal.js";
import { ImportModal } from "../components/ImportModal.js";
import { useShared } from "../context.js";
import {
  ApiUnavailableError,
  connectWithKeys,
  deleteAccount,
  disconnect,
  downloadExportCsv,
  downloadTaxReportPdf,
  fetchConnections,
  isApiConfigured,
  revokeSession,
} from "../api.js";
import { formatCompact, formatRelativeTime, formatUsd } from "../format.js";
import { usePreferences, useSessions, useFxRate } from "../store.js";
import { bookExposure, DEFAULT_RISK_FREE_RATE } from "@onebook/finance";
import { todayIso } from "../format.js";

const CURRENCIES = ["USD", "GBP", "EUR", "JPY"];

export function Settings() {
  const {
    auth,
    portfolioId,
    positions,
    spot,
    addMany,
    theme,
    toggleTheme,
    signOut,
  } = useShared();
  const navigate = useNavigate();

  const { preferences, update } = usePreferences(auth);
  const { sessions, reload: reloadSessions } = useSessions(auth);
  const fx = useFxRate(preferences.currency);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (!isApiConfigured()) return;
    fetchConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, [auth.status]);

  const handleConnect = useCallback(
    async (broker: string, credentials: Record<string, string>) => {
      setConnectError(null);
      try {
        await connectWithKeys(broker, credentials);
        setConnections(await fetchConnections());
      } catch (err) {
        setConnectError(
          err instanceof ApiUnavailableError || err instanceof Error
            ? err.message
            : "Could not connect that account.",
        );
      }
    },
    [],
  );

  const handleDisconnect = useCallback(async (broker: string) => {
    try {
      await disconnect(broker);
      setConnections(await fetchConnections());
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Disconnect failed.");
    }
  }, []);

  const total =
    positions.length === 0
      ? 0
      : bookExposure(positions, {
          spot,
          riskFreeRate: DEFAULT_RISK_FREE_RATE,
          asOf: todayIso(),
        }).marketValue;

  const money = preferences.compactNumbers
    ? formatCompact
    : (n: number) => formatUsd(n, 0);

  const signedIn = auth.status === "authenticated";

  return (
    <div className="page">
      <div className="page-head">
        <h2>Settings</h2>
      </div>

      <div className="section">
        <h3 className="section-title">Profile</h3>
        <div className="field">
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            defaultValue={preferences.displayName ?? ""}
            placeholder="Your name"
            onBlur={(e) => void update({ displayName: e.target.value || null })}
          />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            readOnly
            value={signedIn ? auth.user.email : "Not signed in"}
          />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Appearance</h3>

        <div className="field">
          <label htmlFor="theme-toggle">Theme</label>
          <button
            id="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "◐ Dark" : "◑ Light"}
          </button>
        </div>

        <div className="field">
          <label htmlFor="currency">Display currency</label>
          <select
            id="currency"
            value={preferences.currency}
            onChange={(e) => void update({ currency: e.target.value })}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="field field-check">
          <label htmlFor="compact-numbers">
            <input
              id="compact-numbers"
              type="checkbox"
              checked={preferences.compactNumbers}
              onChange={(e) => void update({ compactNumbers: e.target.checked })}
            />{" "}
            Compact numbers ($1.2M instead of $1,200,000)
          </label>
        </div>

        <div className="field field-check">
          <label htmlFor="show-unrealized">
            <input
              id="show-unrealized"
              type="checkbox"
              checked={preferences.showUnrealizedPnl}
              onChange={(e) =>
                void update({ showUnrealizedPnl: e.target.checked })
              }
            />{" "}
            Show unrealized P&amp;L on the Instruments table
          </label>
        </div>

        <p className="table-note">
          Total portfolio: {money(total)}
          {preferences.currency !== "USD" &&
            (fx.available
              ? ` · ${(total * fx.rate).toLocaleString("en-US", {
                  maximumFractionDigits: 0,
                })} ${preferences.currency}${fx.stale ? " (stale rate)" : ""}`
              : ` · ${preferences.currency} conversion unavailable`)}
        </p>
      </div>

      <div className="section">
        <h3 className="section-title">Connected accounts</h3>
        <ConnectPanel
          connections={connections}
          error={connectError}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onImportCsv={() => setShowImport(true)}
        />
      </div>

      <div className="section">
        <h3 className="section-title">Security</h3>
        <p className="table-note">
          OneBook uses passwordless sign-in — there's no password to change.
        </p>

        {!signedIn ? (
          <div className="empty">Sign in to manage sessions.</div>
        ) : sessions.length === 0 ? (
          <div className="empty">No active sessions listed.</div>
        ) : (
          <>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Signed in</th>
                    <th>Last seen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {(s.userAgent ?? "Unknown device").slice(0, 48)}
                        {s.isCurrent && <span className="tag"> this device</span>}
                      </td>
                      <td>{formatRelativeTime(s.createdAt)}</td>
                      <td>{formatRelativeTime(s.lastSeenAt)}</td>
                      <td>
                        <button
                          onClick={() => {
                            void (async () => {
                              const result = await revokeSession(s.id);
                              if (result.signedOut) {
                                await signOut();
                                navigate("/");
                              } else {
                                reloadSessions();
                              }
                            })();
                          }}
                        >
                          Sign out
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              onClick={() => {
                void (async () => {
                  for (const s of sessions.filter((s) => !s.isCurrent)) {
                    await revokeSession(s.id);
                  }
                  reloadSessions();
                })();
              }}
            >
              Sign out all other sessions
            </button>
          </>
        )}
      </div>

      <div className="section">
        <h3 className="section-title">Data &amp; privacy</h3>
        {exportError && <div className="notice error">{exportError}</div>}

        <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
          <button
            disabled={!portfolioId}
            onClick={() => {
              setExportError(null);
              void downloadExportCsv(portfolioId!).catch((err) =>
                setExportError(
                  err instanceof Error ? err.message : "Export failed.",
                ),
              );
            }}
          >
            Export CSV
          </button>
          <button
            disabled={!portfolioId}
            onClick={() => {
              setExportError(null);
              void downloadTaxReportPdf(portfolioId!).catch((err) =>
                setExportError(
                  err instanceof Error ? err.message : "Export failed.",
                ),
              );
            }}
          >
            Export tax report (PDF)
          </button>
          <button
            disabled={!signedIn}
            onClick={() => {
              if (
                !confirm(
                  "Delete your account and everything in it? This cannot be undone.",
                )
              ) {
                return;
              }
              void (async () => {
                await deleteAccount();
                await signOut();
                navigate("/");
              })();
            }}
          >
            Delete account
          </button>
        </div>
        {!portfolioId && (
          <p className="table-note">Sign in to export your book.</p>
        )}
      </div>

      {showImport && (
        <ImportModal onImport={addMany} onClose={() => setShowImport(false)} />
      )}
    </div>
  );
}
