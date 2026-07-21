/**
 * Connect a brokerage account.
 *
 * Brokers are grouped by what the user actually has to do, not by vendor
 * preference: connect now, apply first, run something locally, or export a
 * CSV. Every broker someone might hold an account with is listed, including
 * the ones with no API — telling someone plainly that Fidelity has no retail
 * API is far better than omitting it and leaving them hunting.
 */

import { useState } from "react";
import {
  BROKERS,
  TIER_DESCRIPTIONS,
  TIER_LABELS,
  type BrokerInfo,
  type BrokerTier,
} from "@onebook/finance";
import { formatRelativeTime } from "../format.js";

export interface Connection {
  broker: string;
  accountLabel?: string;
  connectedAt: number;
  lastSyncedAt?: number;
  /** Set when the last sync failed. Presence is the "broken" signal. */
  lastError?: string;
  lastErrorAt?: number;
}

interface Props {
  connections: Connection[];
  /** Surfaced from the API layer — usually "the Worker isn't running". */
  error: string | null;
  onConnect: (broker: string, credentials: Record<string, string>) => void;
  onDisconnect: (broker: string) => void;
  onImportCsv: () => void;
}

const TIER_ORDER: BrokerTier[] = [
  "available",
  "approval",
  "gateway",
  "csv-only",
];

/**
 * Rendered inline as a Settings section rather than as an overlay: connecting
 * an account is a settings task, not an interruption. The `.modal-body` /
 * `.modal-foot` class names are kept because they carry the layout, not
 * because there is still a modal.
 */
export function ConnectPanel({
  connections,
  error,
  onConnect,
  onDisconnect,
  onImportCsv,
}: Props) {
  const [selected, setSelected] = useState<BrokerInfo | null>(null);

  if (selected) {
    return (
      <CredentialForm
        broker={selected}
        error={error}
        onBack={() => setSelected(null)}
        onSubmit={(credentials) => {
          onConnect(selected.id, credentials);
          setSelected(null);
        }}
      />
    );
  }

  return (
    <div>
      <div className="modal-body">
        {error && <div className="notice error">{error}</div>}

        {connections.length > 0 && (
          <div className="broker-tier">
            <div className="broker-tier-head">
              <h3>Connected</h3>
            </div>
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.broker}
                connection={connection}
                onDisconnect={() => onDisconnect(connection.broker)}
              />
            ))}
          </div>
        )}

        {TIER_ORDER.map((tier) => {
          const brokers = BROKERS.filter(
            (b) =>
              b.tier === tier && !connections.some((c) => c.broker === b.id),
          );
          if (brokers.length === 0) return null;

          return (
            <div className="broker-tier" key={tier}>
              <div className="broker-tier-head">
                <h3>{TIER_LABELS[tier]}</h3>
              </div>
              <p className="broker-tier-note">{TIER_DESCRIPTIONS[tier]}</p>

              {brokers.map((broker) => (
                <BrokerRow
                  key={broker.id}
                  broker={broker}
                  onSelect={() => setSelected(broker)}
                  onImportCsv={onImportCsv}
                />
              ))}
            </div>
          );
        })}
      </div>

      <div className="modal-foot">
        <span
          className="faint"
          style={{ marginRight: "auto", fontSize: "0.625rem" }}
        >
          Read-only access. OneBook never places trades.
        </span>
      </div>
    </div>
  );
}

/**
 * A connected account and its health.
 *
 * The status colors are the two already in the design system: `.dot`'s olive
 * for connected and `.notice.error`'s red for a failure. Green is reserved for
 * P&L, so it is deliberately absent here.
 */
function ConnectionRow({
  connection,
  onDisconnect,
}: {
  connection: Connection;
  onDisconnect: () => void;
}) {
  const broker = BROKERS.find((b) => b.id === connection.broker);
  const failed = Boolean(connection.lastError);

  return (
    <div className="connection">
      <div>
        <div className="broker-name">
          <span className={failed ? "dot error" : "dot"} />
          {broker?.displayName ?? connection.broker}
        </div>
        {connection.accountLabel && (
          <div className="broker-summary">{connection.accountLabel}</div>
        )}
        <div className={failed ? "broker-caveat connection-error" : "broker-summary"}>
          {failed
            ? "Auth error"
            : connection.lastSyncedAt
              ? `Connected ${formatRelativeTime(connection.lastSyncedAt)}`
              : "Connected — not synced yet"}
        </div>
      </div>
      <button onClick={onDisconnect}>Disconnect</button>
    </div>
  );
}

function BrokerRow({
  broker,
  onSelect,
  onImportCsv,
}: {
  broker: BrokerInfo;
  onSelect: () => void;
  onImportCsv: () => void;
}) {
  const connectable = broker.implemented && broker.tier === "available";
  const csvOnly = broker.tier === "csv-only";

  return (
    <button
      className="broker"
      disabled={!connectable && !csvOnly}
      onClick={csvOnly ? onImportCsv : connectable ? onSelect : undefined}
    >
      <span>
        <span className="broker-name">
          {broker.displayName}
          {broker.assetClasses.includes("futures") &&
            !broker.assetClasses.includes("stocks") && (
              <span className="tag">futures</span>
            )}
        </span>
        <span className="broker-summary">{broker.summary}</span>
        {broker.caveat && (
          <span className="broker-caveat">{broker.caveat}</span>
        )}
      </span>

      <span className="faint" style={{ fontSize: "0.625rem" }}>
        {csvOnly
          ? "Import CSV →"
          : connectable
            ? "Connect →"
            : broker.implemented
              ? "Configure on server"
              : "Not built yet"}
      </span>
    </button>
  );
}

function CredentialForm({
  broker,
  error: submitError,
  onBack,
  onSubmit,
}: {
  broker: BrokerInfo;
  error: string | null;
  onBack: () => void;
  onSubmit: (credentials: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? submitError;

  const fields = broker.credentialFields ?? [];

  function submit() {
    const missing = fields.filter((f) => !(values[f.key] ?? "").trim());
    if (missing.length > 0) {
      return setLocalError(`${missing.map((f) => f.label).join(" and ")} required.`);
    }
    onSubmit(values);
  }

  return (
    <div>
      <div className="modal-head">
        <h2>Connect {broker.displayName}</h2>
      </div>

      <div className="modal-body">
        {error && <div className="notice error">{error}</div>}

        {broker.caveat && <div className="notice warn">{broker.caveat}</div>}

        {fields.map((field) => (
          <div className="field" key={field.key}>
            <label htmlFor={`cred-${field.key}`}>{field.label}</label>
            <input
              id={`cred-${field.key}`}
              type={field.secret ? "password" : "text"}
              placeholder={field.placeholder}
              autoComplete="off"
              value={values[field.key] ?? ""}
              onChange={(e) =>
                setValues((current) => ({
                  ...current,
                  [field.key]: e.target.value,
                }))
              }
            />
          </div>
        ))}

        <p
          className="faint"
          style={{ fontSize: "0.625rem", lineHeight: 1.5, margin: 0 }}
        >
          Credentials are sent to the OneBook server, encrypted at rest, and
          never stored in your browser. Read-only scopes are requested where the
          broker supports them.
        </p>

        {broker.docsUrl && (
          <p style={{ fontSize: "0.625rem", marginBottom: 0 }}>
            <a
              href={broker.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--primary)" }}
            >
              Where do I find these? →
            </a>
          </p>
        )}
      </div>

      <div className="modal-foot">
        <button onClick={onBack}>Back</button>
        <button className="primary" onClick={submit}>
          Connect
        </button>
      </div>
    </div>
  );
}
