# OneBook — Engineering Brief for Claude Code

**Repo:** https://github.com/bobwrd/one_book (MIT, public, `main`)

## 0. TL;DR

Build a hosted web app that unifies risk across a portfolio of **stocks and options**, and connects to the user's **real brokerage accounts** via official APIs. The core insight tying the app together: options are translated into **delta-equivalent share exposure** so stocks and options are analyzed as one book.

- **Stack:** Cloudflare Pages (frontend) + Cloudflare Workers (API) + D1 (SQLite) + KV — all free tiers.
- **In scope:** auth + multi-user accounts, saved portfolios, live broker connections, CSV/manual import.
- **Connections:** per-broker OAuth 2.0 (Schwab, E*TRADE, TradeStation) and API-key flows (Alpaca, Tradier, IBKR gateway), with CSV/manual import as the always-works fallback.
- **Constraints:** everything free, read-only (no trade execution in v1), no unofficial APIs, not investment advice, US-focused.

---

## 1. Product Definition

**What it is:** A single-page risk dashboard for a mixed book of equities and options. The user enters or connects positions, and the app renders unified analytics: correlation, volatility, Value-at-Risk, aggregate option Greeks, combined payoff curves, and a linked scenario engine that moves every metric together when the market shifts.

- Portfolios can be built three ways: manual entry, CSV import, or a live brokerage connection.
- The whole book is analyzed as one — a covered call correctly reduces net long exposure via delta translation.
- Multi-user: each account owner has their own saved portfolios and broker links, cloud-synced.

**Who it's for:** Retail investors who hold options against a stock portfolio, plus the developer's own portfolio as a showcase. Doubles as a strong quant-flavored portfolio piece: demonstrates covariance/VaR math, Black-Scholes Greeks, OAuth integrations, and a serverless full-stack architecture.

**The unifying insight (CORE):** Every option position is converted to delta-equivalent shares of its underlying. A long call on 1 contract (100 shares) with delta 0.60 = +60 share-equivalents. This lets the correlation matrix, portfolio volatility, and VaR treat stocks and options as one exposure vector — the differentiator most retail tools miss.

---

## 2. Feature Scope

### 2.1 Position entry
- **Stocks:** ticker, shares, cost basis.
- **Options:** underlying, call/put, strike, expiry, quantity, long/short, entry price.
- **CSV import:** tolerant parser that maps common broker export columns; user confirms column mapping.
- **Live connect:** pull positions from a linked brokerage (see Section 4).

### 2.2 Layer 1 — Portfolio risk
- Correlation heatmap across underlyings (from historical daily returns).
- Annualized portfolio volatility from the covariance matrix.
- Value-at-Risk (95% / 99%) — parametric and historical methods.
- Sharpe ratio, sector/concentration breakdown, diversification score.

### 2.3 Layer 2 — Options & Greeks
- Black-Scholes pricing + Greeks (delta, gamma, theta, vega, rho) per leg.
- Per-strategy payoff diagram (spreads, straddles, iron condors) with breakevens and max profit/loss.
- Net Greeks rolled up across the entire book.
- Implied volatility solved from live option prices when connected; user-input IV otherwise.

### 2.4 Linked scenario engine (CENTERPIECE — build in v1)
A slider drives the underlying market ±X% and shifts implied vol; both layers recompute live. Combined P&L curve, VaR, and payoff diagram all move together. This is the flagship interaction and the strongest demo moment.
- Price shock slider (−30% to +30%), volatility shock slider, days-forward slider (theta decay).
- Risk callouts: "net short gamma," "theta bleed $X/day," "72% concentrated in tech."

---

## 3. Architecture & Stack

### 3.1 Hosting shape
Cloudflare Pages (frontend) + Cloudflare Workers (API) + D1 (SQLite) + KV (sessions/token cache). All within free tiers. **Workers hold all secrets — no API keys or OAuth secrets ever reach the browser.**

### 3.2 Recommended technologies
- **Frontend:** React + Vite + TypeScript, deployed to Cloudflare Pages. Charting via a lightweight lib for heatmap + payoff curves.
- **API:** Cloudflare Workers with Hono (router) + TypeScript. One Worker, route-based.
- **DB:** Cloudflare D1 (SQLite) via Drizzle ORM for typed schema/migrations.
- **Secrets/cache:** Wrangler secrets for API keys; KV for OAuth state + short-lived token cache.
- **Math:** pure-TS modules for Black-Scholes, covariance/VaR, delta-equivalent translation (unit-tested).

### 3.3 Data model (D1)
| Table | Key columns |
|---|---|
| users | id, email, created_at |
| sessions | id, user_id, expires_at (or KV-backed) |
| portfolios | id, user_id, name, created_at |
| positions | id, portfolio_id, type (stock/option), ticker, qty, strike, expiry, right, cost_basis |
| broker_connections | id, user_id, broker, access_token_enc, refresh_token_enc, expires_at, scope |
| price_cache | ticker, date, close (populated from market-data API) |

Broker tokens are encrypted at rest; store the encryption key as a Worker secret, never in D1.

### 3.4 Market data
Historical prices (for correlation/vol) and quotes come from a free market-data API. Start with Alpha Vantage (free key) or Finnhub free tier; cache aggressively in D1 to stay under rate limits. Live option chains/IV come from the connected broker when available, else user-input IV.

---

## 4. Brokerage Connections

### 4.1 Reality check (READ FIRST)
Each broker has its own API, auth model, and approval process — there is no single "connect all brokers" endpoint. Some are self-serve OAuth; some need application approval; some (Fidelity, Vanguard) have no retail API at all. Build the connection layer as **pluggable adapters behind one internal interface**, and always ship CSV/manual import so every broker is at least reachable.

### 4.2 Connection adapter interface
Every broker adapter implements the same shape so the frontend and risk engine never special-case a broker:
- `authUrl(state)` / `exchangeCode(code)` — for OAuth brokers.
- `connectWithKeys(creds)` — for API-key brokers.
- `fetchPositions(token)` → normalized positions (stock + option legs).
- `refresh(token)` — token refresh where supported.

### 4.3 Broker-by-broker guidance

**Tier 1 — build first.** Self-serve, no approval queue, usable today.

| Broker | Auth | Notes |
|---|---|---|
| Alpaca | API key/secret | **Start here.** Developer-first, free paper sandbox, no approval friction. The only broker that can be built and demoed end-to-end without waiting on anyone. |
| Tradier | Token / OAuth 2.0 | Simple REST, strong options coverage, sandbox available. Personal access tokens work without an approved OAuth app. |
| Tradovate / Ironbeam | REST + WebSocket | Futures-focused, fast and simple, low or no cost. Only relevant once futures are in scope — out of scope for v1. |

**Tier 2 — approval required.** Real APIs, but gated behind an application. Start the paperwork early even though they ship later.

| Broker | Auth | Notes |
|---|---|---|
| Charles Schwab | OAuth 2.0 | Free API inherited from TD Ameritrade, no account minimums. Quotes, positions, orders, option chains. Approval has a real lead time. |
| TradeStation | OAuth 2.0 | Long-standing REST + streaming aimed at active traders. Good order and market-data coverage. |
| E*TRADE | OAuth 1.0a | Heavier approval. Notable for lot/position-ID selection at time of sale, which matters for tax-lot accuracy. |
| Lime Trading | API key | Low-latency direct-market-access for US equities and options. Aimed at serious automation; overkill for v1. |
| Rithmic | Proprietary | High-performance futures execution, latency-sensitive. Out of scope. |

**Tier 3 — awkward or semi-official.** Support on a best-effort basis and document the caveat prominently.

| Broker | Auth | Notes |
|---|---|---|
| Interactive Brokers | Local gateway / OAuth | The most comprehensive retail API — REST Client Portal, socket TWS, read-only Flex — across nearly all global markets and asset classes. But Client Portal requires a **running local gateway**, so it is not a pure hosted flow. Support read-only positions and document the gateway requirement plainly. |
| Tastytrade | Semi-official | Options-heavy and increasingly popular for derivatives strategies. No formal public API contract, so treat it as best-effort and expect breakage. |

**Tier 4 — CSV only.** No official retail read API exists.

| Broker | Why |
|---|---|
| Robinhood | No official public API. Unofficial community libraries exist and carry **account-closure risk** — do not build against them. |
| Webull | Provides market data but no official order/position API for retail. |
| Fidelity | Limited, mostly institutional access with a complex approval process. No retail self-serve option. |
| Vanguard | No retail API. |

These route to CSV import, which works for every broker on earth and is why it ships in Phase 1 rather than as a fallback bolted on later.

### 4.3.1 Broker-as-a-service (explicitly out of scope)

Alpaca Broker API, DriveWealth, and Apex Fintech let you *open and manage accounts for other users*. That makes OneBook a regulated broker-dealer intermediary rather than a read-only analytics tool, which is a fundamentally different legal product. Noted here so the option is visibly rejected rather than accidentally reconsidered.

### 4.3.2 Market-data providers (no trading)

Separate concern from brokerage connections, behind its own `MarketDataProvider` interface (section 3.4): Polygon.io (real-time + historical across stocks, options, forex, crypto), Alpha Vantage (free tier, quotes/fundamentals/indicators), and Finnhub / IEX Cloud / Twelve Data. Start with a free tier, but assume terms will change without notice.

### 4.4 OAuth flow on Workers
- Frontend hits `GET /connect/:broker` → Worker generates `state`, stores in KV, redirects to broker authUrl.
- Broker redirects to `GET /callback/:broker` → Worker validates state, exchanges code, encrypts + stores tokens in D1.
- `POST /portfolios/:id/sync` → Worker refreshes token if needed, calls `fetchPositions`, upserts normalized positions.
- Redirect URIs must be registered per broker; document each in the README.

### 4.5 Security requirements (NON-NEGOTIABLE)
- Secrets only in Worker env; never in frontend bundle or D1 plaintext.
- Encrypt broker tokens at rest (AES-GCM via Web Crypto, key from Worker secret).
- Prefer **read-only** scopes; the app never places trades in v1.
- CSRF-protect OAuth via signed `state`; validate on callback.
- Rate-limit sync endpoints; scope every query to the authenticated `user_id`.

---

## 5. Auth & Multi-User

Email + password or magic-link auth, sessions in KV, all data scoped per user. Keep it self-hosted on the free stack — no paid auth provider required.
- Password hashing with a Workers-compatible algorithm (e.g., PBKDF2/scrypt via Web Crypto).
- HTTP-only, secure session cookies; session records in KV with TTL.
- Every API route guards on session → `user_id`; no cross-user data access.

---

## 6. The Math (build + unit-test)

- **Black-Scholes:** price + all Greeks for European calls/puts; Newton-Raphson IV solver.
- **Delta-equivalent translation:** option → signed share-equivalent exposure per underlying.
- **Covariance/correlation:** from historical daily log returns; annualized.
- **VaR:** parametric (variance-covariance) + historical simulation.
- **Scenario:** reprice book under (price shock, vol shock, days forward); return per-position and aggregate P&L.

Each module is pure TypeScript with unit tests and known-value fixtures (e.g., a textbook Black-Scholes example) so correctness is verifiable.

---

## 7. Build Plan & Repo

### Phase 1 — MVP
Local-first core with manual + CSV entry, both risk layers, and the linked scenario slider. No auth, no brokers yet — validate the math and UX. All computation client-side.

### Phase 2 — Backend
Add Workers API + D1 + auth + saved portfolios, then the first two broker adapters (Alpaca, Tradier). Wire the market-data API with D1 caching. Ship OAuth for Schwab next.

### Phase 3 — Polish
Remaining broker adapters, risk callouts, sector/concentration analytics, and design polish. Add TradeStation, E*TRADE, IBKR (documented gateway), Tastytrade as capacity allows.

### Repo & deploy
- Monorepo on GitHub: `/web` (Pages), `/api` (Worker), `/packages/finance` (shared math).
- Wrangler config for Worker + D1 bindings + KV; `wrangler.toml` committed, secrets set via `wrangler secret put`.
- GitHub Actions: build + test on PR; deploy Pages + Worker on merge to `main`.
- README documents every broker's registration steps, redirect URIs, and required env vars.
- `.dev.vars` for local secrets (gitignored); `wrangler d1 migrations` for schema.

---

## 8. Constraints & Non-Goals

- **Everything free:** stay within Cloudflare + free market-data + free broker sandbox tiers. Flag anything that would require payment.
- **Read-only:** no trade execution in v1.
- **No unofficial APIs:** skip Robinhood scraping and any ToS-violating access; those brokers use CSV import.
- **Not investment advice:** include a clear disclaimer; risk metrics are informational.
- **US-focused:** broker APIs and market data assume US markets in v1.

---

## 9. UI & Interaction Design

### 9.1 Layout
Single page, three zones, no routing beyond `/`, `/login`, `/settings`:

```
┌──────────────────────────────────────────────────────────┐
│  OneBook          [portfolio ▾]   [sync ⟳]   [account ▾] │
├───────────────┬──────────────────────────────────────────┤
│  POSITIONS    │  SCENARIO BAR                            │
│  (left rail)  │  price −30 ▬▬●▬▬ +30   vol ▬●▬   days ▬● │
│               ├──────────────────────────────────────────┤
│  stock rows   │  RISK TILES                              │
│  option rows  │  [σ ann.] [VaR 95] [VaR 99] [Sharpe]     │
│               │  [Δ] [Γ] [Θ] [V]  ← net book Greeks      │
│  + add        ├───────────────────┬──────────────────────┤
│  ⇪ import CSV │  PAYOFF / P&L     │  CORRELATION HEATMAP │
│  ⚯ connect    │  curve            │                      │
│               ├───────────────────┴──────────────────────┤
│               │  RISK CALLOUTS  •  EXPOSURE BREAKDOWN    │
└───────────────┴──────────────────────────────────────────┘
```

- **Left rail** is the book: every position, stock and option, with its delta-equivalent share count shown inline — this is where the core insight becomes visible.
- **Scenario bar is pinned** at the top of the analysis pane and never scrolls away. Everything below it is a function of its three sliders.
- Mobile: rail collapses to a sheet; tiles stack; scenario bar stays sticky.

### 9.2 The scenario interaction (flagship)
- Sliders are **continuous and recompute on drag** — target <16 ms per frame for a 50-position book. If the math can't hold that, debounce to 30 Hz rather than dropping to on-release.
- Every metric that changes **animates from its old value**, and shows a delta chip (`VaR 95 · $12,400 ▲ $3,100`) against the unshocked baseline.
- A **"reset to spot"** control returns all three sliders to zero.
- The payoff curve draws the shocked point as a marker riding along the curve as the price slider moves.

### 9.3 Visual system
- **Dark-first**, single accent, financial-terminal restraint. Data ink over chrome.
- **Semantic color is reserved for P&L only** — green/red never used for anything but gain/loss, so the eye never has to disambiguate. Correlation heatmap uses a *diverging* scale distinct from the P&L pair (e.g. purple↔amber), because correlation is not profit.
- Colorblind-safe: never encode P&L by hue alone — pair with sign, position, or arrow.
- Numbers in tabular figures (`font-variant-numeric: tabular-nums`) so digits don't jitter during scenario drags.
- Every risk tile carries a one-line plain-English gloss on hover ("95% VaR: on 95 of 100 days, one-day loss stays under this").

### 9.4 States that must be designed, not improvised
Empty book · single position (no correlation possible) · positions with no price history · option past expiry · broker sync in-flight · broker token expired · market closed / stale quotes · math failure on a single leg (isolate it, don't blank the dashboard).

### 9.5 Trust & disclosure
Persistent, non-dismissible footer disclaimer. Every metric shows its **as-of timestamp** and data source. When IV is user-supplied rather than broker-derived, the affected Greeks are visually marked as estimates.

---

## 10. Testing & Correctness

- **Math packages are the test priority.** `/packages/finance` targets high coverage with known-value fixtures: textbook Black-Scholes cases, put-call parity, Greeks converging to finite-difference approximations, IV round-trip (price → IV → price).
- **Property tests** on invariants: delta-equivalent exposure of a fully-hedged covered call ≈ 0; VaR is monotone in volatility; portfolio σ ≤ sum of position σ.
- **Adapter tests** run against recorded fixtures, not live brokers. Alpaca paper sandbox is the only live-touching test, and it's opt-in via env var.
- **Auth tests** must include the negative cases: cross-user portfolio access returns 404, expired session rejected, OAuth callback with bad `state` rejected.
- CI (GitHub Actions) runs typecheck + unit tests on every PR; deploy only on green merge to `main`.

---

## 11. Definition of Done (v1)

1. A user signs up, creates a portfolio, and enters a mixed stock + option book by hand.
2. The same book imports cleanly from a broker CSV.
3. An Alpaca paper account connects and syncs positions in one click.
4. All Layer 1 and Layer 2 metrics render correctly against a hand-verified reference portfolio.
5. Dragging the price slider visibly moves VaR, net Greeks, and the payoff curve together in real time.
6. A second user account cannot see the first user's data, verified by test.
7. Deployed and publicly reachable on Cloudflare, running entirely within free tiers.

---

## 12. Open Decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Charting library | Start with hand-rolled SVG for the payoff curve and heatmap — both are simple, and it avoids a bundle for two charts. Reach for a library only if the third chart type appears. |
| 2 | Auth method | Magic link. No password storage, no reset flow, no hashing decisions — meaningfully less to get wrong on a solo project. |
| 3 | Phase 1 persistence | localStorage. Keeps Phase 1 genuinely backendless and makes the Phase 2 migration a real, testable import path. |
| 4 | Market data provider | Alpha Vantage to start (generous-enough free key), but write it behind a `MarketDataProvider` interface from day one — free tiers change without notice. |
| 5 | Risk-free rate for Black-Scholes | Hardcode a configurable constant in v1; a live treasury feed is not worth an integration. |
| 6 | American vs. European options | Price everything as European in v1 and say so in the UI. Binomial pricing for American exercise is a Phase 3 item. |

---

## 13. Setup Checklist (owner actions)

Ordered by when they block work. Items 1–3 block the first commit; the rest block Phase 2.

**Now**
1. Initialize git *inside* `OneBook/`, add a `.gitignore` (`node_modules`, `.dev.vars`, `.DS_Store`, `dist`), and point the remote at `github.com/bobwrd/one_book`.
2. Add a Cloudflare account (free) — needed for Pages, Workers, D1, KV.
3. Decide the six items in Section 12, or accept the recommendations.

**Before Phase 2**
4. Create the D1 database and KV namespace; commit `wrangler.toml` with the bindings.
5. Get a free market-data API key (Alpha Vantage or Finnhub); set via `wrangler secret put`.
6. Create an **Alpaca paper trading** account and generate API key/secret — this is the first broker adapter and needs no approval.
7. Generate an AES-GCM encryption key for broker tokens at rest; store as a Worker secret. Never commit it.
8. Register a Tradier developer account (sandbox) for the second adapter.

**Before Phase 3**
9. Apply for Charles Schwab developer access — this one has an approval delay, so start it early even though it ships later.
10. Register redirect URIs per broker once the Pages domain is known; document each in the README.
