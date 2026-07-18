# OneBook

Unified risk for a mixed book of stocks and options.

Every option position is translated into **delta-equivalent shares** of its
underlying, so the correlation matrix, portfolio volatility, and VaR treat
stocks and options as one exposure vector. A covered call correctly nets down
against its stock instead of being analyzed as a separate instrument.

MIT licensed. Not investment advice.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Local-first core: manual + CSV entry, both risk layers, linked scenario sliders | **Built** |
| 2 | Workers API, D1, magic-link auth, Alpaca + Tradier + Schwab adapters | **Built, needs your Cloudflare resources** |
| 3 | Remaining adapters (E*TRADE, TradeStation, IBKR, Tastytrade), sector analytics | Not started |

The frontend currently runs Phase 1 standalone — the whole risk engine executes
client-side against `localStorage`, with no backend required. The API is built
and tested but is not yet wired into the UI; see [Wiring the frontend to the
API](#wiring-the-frontend-to-the-api).

---

## Repo layout

```
packages/finance/   Pure-TS risk engine. No I/O, no framework. 130 unit tests.
api/                Cloudflare Worker (Hono) — auth, D1, broker adapters.
web/                React + Vite dashboard.
```

`packages/finance` is the load-bearing piece and is deliberately dependency-free
so its correctness can be verified in isolation.

---

## Quick start

```bash
npm install
npm test              # finance math, 130 tests
npm run dev:web       # dashboard at http://localhost:5173
```

That's enough to use the app: add a stock, write a call against it, and drag
the price slider.

### Running everything

```bash
npm run typecheck               # all workspaces
npx vitest run --root api       # API tests
npx vitest run --root web       # dashboard end-to-end tests
npm run build --workspace=web   # production build
```

---

## The math

All of it lives in `packages/finance` as pure functions with unit tests and
known-value fixtures.

| Module | What it does |
|---|---|
| `blackScholes.ts` | European pricing, all five Greeks, implied-vol solver |
| `exposure.ts` | Delta-equivalent translation — the core insight |
| `stats.ts` | Log returns, covariance, correlation, date alignment |
| `risk.ts` | Portfolio volatility, parametric + historical VaR, Sharpe, concentration |
| `scenario.ts` | Full reprice under price/vol/time shocks, payoff curves, breakevens |
| `csv.ts` | Tolerant broker-CSV parser with column-mapping inference |

Three correctness notes worth knowing, each of which the tests pin down:

- **Options are priced as European.** US single-name equity options are
  contractually American. This is exact for calls on non-dividend payers, where
  early exercise is never optimal, but understates deep-ITM American puts. The
  UI discloses it. Binomial pricing is a Phase 3 item.
- **The implied-vol solver reflects ITM options onto their OTM twin** via
  put-call parity before solving. Deep-ITM vega is near zero, so solving
  directly returns an arbitrary root that looks perfectly confident.
- **The no-arbitrage floor for a put is `K·e^(-rT) − S`, not discounted
  intrinsic.** A European put legitimately trades below intrinsic value —
  precisely why early exercise has value — and the naive floor rejects valid
  ITM put quotes.

Where an option carries no meaningful time value the volatility genuinely
cannot be recovered from the price, and the solver raises rather than guessing.

---

## Scenario engine

Three sliders drive the entire dashboard, recomputing continuously on drag:

- **Price shock** −30% to +30% across every underlying
- **Vol shock** ±30 implied-volatility points
- **Days forward** 0–90 days of theta decay

Each shock is a **full reprice**, not a delta/gamma approximation, so a −30%
move on a short-gamma book shows real convexity rather than a tangent-line
estimate.

---

## Deploying

Everything below stays inside Cloudflare's free tiers.

### 1. Create the resources

```bash
npm i -g wrangler
wrangler login

wrangler d1 create onebook          # copy database_id into api/wrangler.toml
wrangler kv namespace create onebook-kv   # copy id into api/wrangler.toml
```

Then apply the schema:

```bash
npm run db:local --workspace=api    # local dev
npm run db:remote --workspace=api   # deployed
```

### 2. Set secrets

Never commit these. `api/.dev.vars` (gitignored) holds them for local dev; use
`wrangler secret put` for deployment.

| Secret | How to get it |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` — must be exactly 32 bytes |
| `STATE_SIGNING_SECRET` | `openssl rand -base64 32` |
| `ALPACA_API_KEY_ID` | From alpaca.markets — paper keys work fine |
| `ALPACA_API_SECRET_KEY` | Same place |
| `SCHWAB_CLIENT_ID` / `SCHWAB_CLIENT_SECRET` | Schwab developer portal, after approval |
| `TRADIER_CLIENT_ID` / `TRADIER_CLIENT_SECRET` | Tradier developer account (OAuth only) |

`TOKEN_ENCRYPTION_KEY` encrypts broker tokens at rest with AES-GCM. It lives
only in Worker env — a D1 leak alone exposes no brokerage credentials.

### 3. Deploy

#### From the Cloudflare dashboard (Workers Builds)

This is a **monorepo**, so the defaults do not work — Cloudflare runs
`npx wrangler deploy` at the repo root, where there is no Wrangler config.
Set these in the Worker's *Settings → Build* panel:

| Setting | Value |
|---|---|
| Root directory | `/` (leave at repo root — npm workspaces need it) |
| Build command | `npm ci` |
| Deploy command | `npx wrangler deploy --config api/wrangler.toml` |

Pointing the root directory at `/api` instead will break the install, because
`@onebook/finance` is a workspace dependency resolved from the repo root.

The deploy also fails until `api/wrangler.toml` has real D1 and KV IDs in
place of the `REPLACE_WITH_...` placeholders. Those IDs are not secrets and
are meant to be committed.

#### From your machine

Every Wrangler command must be told where the config lives, since it sits in
`api/` rather than the repo root. Root-level scripts wrap that for you:

```bash
npm run deploy:api                 # deploy the Worker
npm run secret -- TOKEN_ENCRYPTION_KEY   # set a secret
npm run secret:list                # what's already set
npm run db:remote                  # apply the schema
npm run tail                       # live logs
```

Generate secrets straight into Wrangler so the value never lands in your
shell history or scrollback:

```bash
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY --config api/wrangler.toml
openssl rand -base64 32 | npx wrangler secret put STATE_SIGNING_SECRET --config api/wrangler.toml
```



```bash
npm run deploy --workspace=api      # Worker
npm run build --workspace=web       # then point Cloudflare Pages at web/dist
```

Set `APP_ORIGIN` and `API_ORIGIN` in `api/wrangler.toml` to your real origins
before deploying — they drive CORS and every OAuth redirect URI.

---

## Market data

Alpaca is the default provider. It batches every symbol into a single request,
so a ten-name book costs one call rather than ten — the difference between
fitting inside a free rate limit and not. It is also the same vendor as the
first brokerage adapter, so one set of keys covers both concerns.

`ALPACA_DATA_FEED` picks the source:

| Feed | Cost | What you get |
|---|---|---|
| `delayed_sip` | Free | **Default.** Full consolidated tape, 15-minute delay |
| `iex` | Free | Real-time, but IEX volume only — closes can differ slightly |
| `sip` | Paid | Full tape, real time |

`delayed_sip` is the default because risk analytics care more about complete
data than about the last fifteen minutes.

Everything sits behind a `MarketDataProvider` interface, with Alpha Vantage
and Finnhub implementations kept as fallbacks — free tiers change terms
without notice, and swapping providers should not touch the risk engine.

Prices are cached in D1 regardless of provider: history for 12 hours, quotes
for 60 seconds. On a provider failure with usable cached data, the cache wins
and the UI labels the result stale rather than showing a blank dashboard.

## Brokers

Section 4.1 of the design brief is the thing to internalize: there is no single
"connect all brokers" endpoint. Each broker has its own auth model and approval
process, and several have no retail API at all. Everything hides behind one
adapter interface (`api/src/brokers/types.ts`) so the risk engine never
special-cases a broker.

| Broker | Auth | Status | Notes |
|---|---|---|---|
| **Alpaca** | API key | Built | **Start here.** Free paper account, no approval, no waiting |
| **Tradier** | Token / OAuth 2.0 | Built | Personal access token works without an approved OAuth app |
| **Charles Schwab** | OAuth 2.0 | Built | Needs an approved developer application — **apply early** |
| E*TRADE | OAuth 1.0a | Not built | Heavier approval, lower priority |
| TradeStation | OAuth 2.0 | Not built | REST + streaming |
| Interactive Brokers | Local gateway | Not built | Requires a running gateway; not a pure hosted flow |
| Tastytrade | Semi-official | Not built | Best-effort |
| Robinhood / Webull / Fidelity / Vanguard | — | **CSV only** | No official retail read API |

**No unofficial APIs.** Scraping Robinhood and friends violates their terms of
service and puts your actual brokerage account at risk. Those brokers route to
CSV import, which works for everyone.

**Read-only.** OneBook requests read scopes and never places trades.

### Redirect URIs

Register these with each OAuth broker, substituting your API origin:

```
https://<your-api-origin>/callback/schwab
https://<your-api-origin>/callback/tradier
```

### Getting an Alpaca connection working

1. Sign up at alpaca.markets and open the **paper trading** dashboard
2. Generate an API key ID and secret key
3. `POST /connect/alpaca/keys` with `{ "keyId": "...", "secretKey": "..." }`
4. `POST /portfolios/:id/sync` with `{ "broker": "alpaca" }`

Credentials are validated at connect time, so a typo surfaces immediately
rather than on the first sync.

---

## Security

- Secrets live only in Worker env — never in the frontend bundle, never in D1
- Broker tokens are AES-GCM encrypted at rest
- OAuth `state` is both HMAC-signed and KV-backed: the signature proves we
  issued it, the KV entry makes it single-use
- Login tokens are stored hashed and consumed with a conditional update, so two
  concurrent redemptions cannot both succeed
- Portfolio routes return **404, not 403**, for another user's ID — the API
  never confirms an ID exists to someone who cannot see it
- Sessions are HTTP-only, `Secure`, `SameSite=Lax` cookies with a KV TTL

---

## Wiring the frontend to the API

The dashboard currently reads from `localStorage` and generates deterministic
synthetic price history (`web/src/syntheticHistory.ts`) so correlation and VaR
are exercisable with no backend. Those are **not real prices** and the module
exists to be deleted.

To connect it:

1. Replace `usePositions` / `useSpotPrices` in `web/src/store.ts` with fetches
   against `/portfolios/:id` and `/portfolios/:id/analysis`
2. Delete `syntheticHistory.ts` — the API returns real cached closes
3. Add the login screen against `POST /auth/request`

The API's `analyzePortfolio` already returns the exact shape the dashboard
renders, so this is a data-source swap rather than a rewrite.

### Magic-link email

Not wired to a provider, because every transactional email service that stays
free has terms worth reading first. In dev, set `DEV_LOG_MAGIC_LINKS=1` and the
link is logged to the console (and returned in the response) instead of emailed.
For production, Cloudflare Email Routing is the free path.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Charts | Hand-rolled SVG | Two chart types don't justify a dependency |
| Auth | Magic link | No password storage, no reset flow, less to get wrong |
| Phase 1 storage | `localStorage` | Keeps Phase 1 genuinely backendless |
| Market data | Provider interface | Free tiers change terms without notice |
| Risk-free rate | Configurable constant | A live treasury feed isn't worth the integration |
| Options | European only in v1 | Binomial American pricing is Phase 3 |

Colors carry one rule worth preserving: **green and red mean P&L and nothing
else.** The correlation heatmap uses a purple/amber diverging scale so it never
reads as a profit map, and no value is encoded by hue alone.

---

## Disclaimer

OneBook is an informational risk tool. It is not investment advice, the models
are approximations, and market data may be stale or wrong. Verify every figure
independently before acting on it.
