/**
 * Magic-link sign-in.
 *
 * No password, so there is nothing to store, reset, or leak. Signing in is
 * optional — the dashboard works fully signed out on local data. You sign in
 * to save portfolios across devices and to connect a brokerage, which needs a
 * server-side session because credentials must never live in the browser.
 */

import { useState } from "react";
import { ApiUnavailableError, requestMagicLink } from "../api.js";

interface Props {
  /** Whether the API answered a health probe. */
  apiUp: boolean;
  onClose: () => void;
}

type Stage = "form" | "sent";

export function LoginModal({ apiUp, onClose }: Props) {
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return setError("Enter a valid email address.");
    }

    setBusy(true);
    setError(null);
    try {
      const result = await requestMagicLink(trimmed);
      setDevLink(result.devLink ?? null);
      setStage("sent");
    } catch (err) {
      setError(
        err instanceof ApiUnavailableError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not send a sign-in link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{stage === "sent" ? "Check your email" : "Sign in"}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {!apiUp && (
            <div className="notice warn">
              The API isn't reachable, so sign-in is unavailable. The
              dashboard still works fully on local data.
            </div>
          )}

          {error && <div className="notice error">{error}</div>}

          {stage === "form" ? (
            <>
              <div className="field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                />
              </div>
              <p
                className="faint"
                style={{ fontSize: "0.625rem", lineHeight: 1.5, margin: 0 }}
              >
                We'll email you a sign-in link. No password to remember, and
                nothing to leak. Signing in saves your book across devices and
                lets you connect a brokerage.
              </p>
            </>
          ) : (
            <>
              <p style={{ fontSize: "0.75rem", marginTop: 0 }}>
                If an account exists for <strong>{email.trim()}</strong>, a
                sign-in link is on its way. The link works once and expires in
                15 minutes.
              </p>

              {devLink && (
                <>
                  <div className="notice warn">
                    Development mode: email delivery isn't wired up, so the
                    link is shown here instead.
                  </div>
                  <a
                    href={devLink}
                    style={{
                      color: "var(--primary)",
                      fontSize: "0.6875rem",
                      wordBreak: "break-all",
                    }}
                  >
                    {devLink}
                  </a>
                </>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          {stage === "form" ? (
            <>
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                onClick={() => void submit()}
                disabled={busy || !apiUp}
              >
                {busy ? "Sending…" : "Send link"}
              </button>
            </>
          ) : (
            <button className="primary" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
