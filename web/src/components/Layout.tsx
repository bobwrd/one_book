/**
 * The app shell: sidebar, a slim top strip, and whatever route is active.
 *
 * Sign-in lives here rather than on any one page, since it must be reachable
 * from everywhere. The theme toggle deliberately does not — it has exactly one
 * home, in Settings, so there is no second control to drift out of sync.
 */

import { useState } from "react";
import { Outlet } from "react-router-dom";
import { LoginModal } from "./LoginModal.js";
import { ManageGroupsModal } from "./ManageGroupsModal.js";
import { Sidebar } from "./Sidebar.js";
import type { SharedBookState } from "../context.js";
import { useGroups, usePreferences } from "../store.js";

export function Layout({ state }: { state: SharedBookState }) {
  const [showLogin, setShowLogin] = useState(false);
  const [showGroups, setShowGroups] = useState(false);

  const groups = useGroups(state.auth, state.portfolioId);
  const { preferences } = usePreferences(state.auth);

  return (
    <div className="app">
      <Sidebar
        auth={state.auth}
        positions={state.positions}
        spot={state.spot}
        groups={groups.groups}
        compactNumbers={preferences.compactNumbers}
        onManageGroups={() => setShowGroups(true)}
        onSignIn={() => setShowLogin(true)}
        onSignOut={() => void state.signOut()}
      />

      <div className="shell">
        <header className="topbar">
          <span className="topbar-meta">
            {state.positions.length} pos · {state.tickers.length} sym
          </span>
          <div className="topbar-spacer" />
          {state.auth.status === "authenticated" ? (
            <span className="topbar-meta">{state.auth.user.email}</span>
          ) : (
            <button className="primary" onClick={() => setShowLogin(true)}>
              Sign in
            </button>
          )}
          {state.positions.length > 0 && (
            <button
              onClick={() => {
                if (confirm("Remove all positions from this book?")) {
                  state.clear();
                }
              }}
            >
              Clear
            </button>
          )}
        </header>

        <Outlet context={state} />

        <footer className="disclaimer">
          OneBook is an informational risk tool, not investment advice. Options
          are priced with a European Black-Scholes model; American early
          exercise is not modeled. Verify all figures independently before
          acting on them.
        </footer>
      </div>

      {showLogin && (
        <LoginModal
          apiUp={state.apiUp}
          onClose={() => {
            setShowLogin(false);
            void state.refreshAuth();
          }}
        />
      )}
      {showGroups && (
        <ManageGroupsModal
          groups={groups.groups}
          positions={state.positions}
          actions={groups}
          onClose={() => setShowGroups(false)}
        />
      )}
    </div>
  );
}
