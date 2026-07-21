/**
 * OneBook API — one Worker, route-based.
 *
 * Every authenticated route derives `user_id` from the session and scopes its
 * queries to it. No route accepts a user identifier from the client.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, SessionData } from "./env.js";
import {
  AuthError,
  consumeLoginToken,
  createLoginToken,
  currentSessionId,
  destroySession,
  magicLinkUrl,
  normalizeEmail,
  requireAuth,
  setSessionCookie,
  type AuthedVariables,
} from "./auth.js";
import { decryptToken, encryptToken, hmacSign, hmacVerify, randomId } from "./crypto.js";
import {
  brokerEnv,
  getAdapter,
  isConfigured,
  listAdapters,
  BrokerError,
  CSV_ONLY_BROKERS,
  type BrokerId,
  type BrokerTokens,
  type NormalizedPosition,
} from "./brokers/index.js";
import {
  getPriceHistory,
  getProvider,
  getQuotes,
  MarketDataError,
} from "./marketData.js";
import { analyzePortfolio } from "./analysis.js";
import { getFxRate } from "./fx.js";
import { getNews } from "./news.js";
import {
  listTransactions,
  recordTransaction,
  recordTransactions,
  toLedgerTransaction,
  type NewTransaction,
} from "./ledger.js";
import { computeFifo, positionsToCsv, transactionsToCsv } from "@onebook/finance";
import type { Position } from "@onebook/finance";

type App = { Bindings: Env; Variables: AuthedVariables };

const app = new Hono<App>();

app.use("*", async (c, next) => {
  const middleware = cors({
    origin: c.env.APP_ORIGIN,
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  return middleware(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

// ------------------------------------------- public reference data

/**
 * Headlines and FX rates are public reference data about instruments, not
 * anything derived from a user's book, so they sit outside `authed` — the
 * signed-out demo book needs them just as much as a real one.
 *
 * These must stay above `app.route("/", authed)`. That mounts `authed`'s
 * `use("*")` guard across every path, and Hono runs middleware in registration
 * order, so anything declared after it is authenticated no matter which router
 * it hangs off.
 */
app.get("/instruments/:ticker/news", async (c) => {
  const result = await getNews(c.env, c.req.param("ticker"));
  if (!result) {
    // Not an error: this deployment has no news source configured.
    return c.json({ items: [], available: false, stale: false });
  }
  return c.json({ ...result, available: true });
});

app.get("/fx/:currency", async (c) => {
  const currency = c.req.param("currency").toUpperCase();
  const result = await getFxRate(c.env, currency);
  if (!result) {
    return c.json({ error: `No rate available for ${currency}.` }, 503);
  }
  return c.json({ currency, ...result });
});

// ---------------------------------------------------------------- auth

app.post("/auth/request", async (c) => {
  const body = await c.req
    .json<{ email?: string }>()
    .catch(() => ({}) as { email?: string });
  const email = normalizeEmail(body.email ?? "");
  if (!email) return c.json({ error: "A valid email address is required." }, 400);

  const token = await createLoginToken(c.env, email);
  const link = magicLinkUrl(c.env, token);

  if (c.env.DEV_LOG_MAGIC_LINKS === "1") {
    console.log(`[dev] magic link for ${email}: ${link}`);
    return c.json({ ok: true, devLink: link });
  }

  // Email delivery is intentionally not wired to a paid provider. See the
  // README for the Cloudflare Email Routing / MailChannels options.
  console.log(`[onebook] magic link issued for ${email}`);

  // Always the same response, so this cannot enumerate registered accounts.
  return c.json({ ok: true });
});

app.get("/auth/callback", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect(`${c.env.APP_ORIGIN}/login?error=missing_token`);

  try {
    const { sessionId } = await consumeLoginToken(
      c.env,
      token,
      c.req.header("User-Agent"),
    );
    setSessionCookie(c as never, sessionId);
    return c.redirect(c.env.APP_ORIGIN);
  } catch (err) {
    const reason = err instanceof AuthError ? "invalid_token" : "server_error";
    return c.redirect(`${c.env.APP_ORIGIN}/login?error=${reason}`);
  }
});

app.post("/auth/logout", async (c) => {
  await destroySession(c as never);
  return c.json({ ok: true });
});

app.get("/auth/me", requireAuth, (c) => {
  const session = c.get("session");
  return c.json({ userId: session.userId, email: session.email });
});

// ---------------------------------------------------------- portfolios

const authed = new Hono<App>();
authed.use("*", requireAuth);

authed.get("/portfolios", async (c) => {
  const session = c.get("session");
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, created_at, updated_at FROM portfolios WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(session.userId)
    .all();
  return c.json({ portfolios: results ?? [] });
});

authed.post("/portfolios", async (c) => {
  const session = c.get("session");
  const body = await c.req
    .json<{ name?: string }>()
    .catch(() => ({}) as { name?: string });
  const name = (body.name ?? "").trim() || "Untitled portfolio";

  const id = randomId("pf");
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO portfolios (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, session.userId, name, now, now)
    .run();

  return c.json({ id, name, created_at: now, updated_at: now }, 201);
});

/**
 * Ownership check used by every portfolio-scoped route. Returns 404 rather
 * than 403 for someone else's portfolio, so the API never confirms that an
 * ID exists to a user who cannot see it.
 */
async function ownedPortfolio(
  env: Env,
  session: SessionData,
  portfolioId: string,
): Promise<{ id: string; name: string } | null> {
  return env.DB.prepare(
    "SELECT id, name FROM portfolios WHERE id = ? AND user_id = ?",
  )
    .bind(portfolioId, session.userId)
    .first<{ id: string; name: string }>();
}

authed.get("/portfolios/:id", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM positions WHERE portfolio_id = ? ORDER BY created_at",
  )
    .bind(portfolio.id)
    .all();

  return c.json({
    ...portfolio,
    positions: (results ?? []).map(rowToPosition),
  });
});

authed.patch("/portfolios/:id", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const body = await c.req
    .json<{ name?: string }>()
    .catch(() => ({}) as { name?: string });
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "A name is required." }, 400);

  await c.env.DB.prepare(
    "UPDATE portfolios SET name = ?, updated_at = ? WHERE id = ?",
  )
    .bind(name, Date.now(), portfolio.id)
    .run();

  return c.json({ id: portfolio.id, name });
});

authed.delete("/portfolios/:id", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  await c.env.DB.prepare("DELETE FROM portfolios WHERE id = ?")
    .bind(portfolio.id)
    .run();
  return c.json({ ok: true });
});

// ----------------------------------------------------------- positions

interface PositionInput {
  type: "stock" | "option" | "bond";
  ticker: string;
  quantity: number;
  costBasis?: number;
  currency?: string;
  strike?: number;
  expiry?: string;
  right?: "call" | "put";
  contractMultiplier?: number;
  iv?: number;
  // Bond-only. Bonds are sized by `faceValue`, not `quantity`.
  couponRate?: number;
  maturity?: string;
  faceValue?: number;
  price?: number;
  /** When the trade happened, for the ledger row. Defaults to now. */
  tradeDate?: number;
}

function validatePosition(input: PositionInput): string | null {
  if (!input.ticker || typeof input.ticker !== "string") {
    return "A ticker is required.";
  }

  if (input.type === "bond") {
    if (!Number.isFinite(input.faceValue) || input.faceValue === 0) {
      return "Face value must be a non-zero number.";
    }
    if (!Number.isFinite(input.couponRate) || (input.couponRate ?? -1) < 0) {
      return "A non-negative coupon rate is required for bonds.";
    }
    if (!input.maturity || !/^\d{4}-\d{2}-\d{2}$/.test(input.maturity)) {
      return "A maturity date (YYYY-MM-DD) is required for bonds.";
    }
    if (!Number.isFinite(input.price) || (input.price ?? 0) <= 0) {
      return "A positive price (per 100 par) is required for bonds.";
    }
    return null;
  }

  if (!Number.isFinite(input.quantity) || input.quantity === 0) {
    return "Quantity must be a non-zero number.";
  }
  if (input.type === "option") {
    if (!Number.isFinite(input.strike) || (input.strike ?? 0) <= 0) {
      return "A positive strike is required for options.";
    }
    if (!input.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) {
      return "An expiry date (YYYY-MM-DD) is required for options.";
    }
    if (input.right !== "call" && input.right !== "put") {
      return "Option right must be 'call' or 'put'.";
    }
    if (input.iv !== undefined && (input.iv <= 0 || input.iv > 10)) {
      return "Implied volatility must be between 0 and 10.";
    }
  }
  return null;
}

async function insertPositions(
  env: Env,
  portfolioId: string,
  inputs: PositionInput[],
  source: string,
): Promise<string[]> {
  const now = Date.now();
  const ids: string[] = [];
  const statement = env.DB.prepare(
    `INSERT INTO positions
      (id, portfolio_id, type, ticker, quantity, cost_basis, currency, strike, expiry, right, contract_multiplier, iv, iv_is_estimate, coupon_rate, maturity, face_value, price, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const statements = inputs.map((input) => {
    const id = randomId("pos");
    ids.push(id);
    const isOption = input.type === "option";
    const isBond = input.type === "bond";
    return statement.bind(
      id,
      portfolioId,
      input.type,
      input.ticker.toUpperCase(),
      // A bond carries no share count; the column keeps its NOT NULL default.
      isBond ? 0 : input.quantity,
      input.costBasis ?? 0,
      input.currency ?? "USD",
      isOption ? input.strike : null,
      isOption ? input.expiry : null,
      isOption ? input.right : null,
      isOption ? (input.contractMultiplier ?? 100) : null,
      isOption ? (input.iv ?? 0.3) : null,
      isOption ? (input.iv === undefined ? 1 : 0) : null,
      isBond ? input.couponRate : null,
      isBond ? input.maturity : null,
      isBond ? input.faceValue : null,
      isBond ? input.price : null,
      source,
      now,
    );
  });

  if (statements.length > 0) await env.DB.batch(statements);
  return ids;
}

/**
 * The ledger row that a newly added position implies.
 *
 * Adding a position is the only trade OneBook ever observes for a manual
 * entry, so recording it here is what makes the History page non-empty for
 * anything not synced from a broker.
 */
function positionToTransaction(
  input: PositionInput,
  source: string,
): NewTransaction {
  const size = input.type === "bond" ? (input.faceValue ?? 0) : input.quantity;
  return {
    ticker: input.ticker,
    positionType: input.type,
    side: size >= 0 ? "buy" : "sell",
    quantity: Math.abs(size),
    price: input.type === "bond" ? (input.price ?? 0) : (input.costBasis ?? 0),
    currency: input.currency ?? "USD",
    strike: input.type === "option" ? (input.strike ?? null) : null,
    expiry: input.type === "option" ? (input.expiry ?? null) : null,
    right: input.type === "option" ? (input.right ?? null) : null,
    source,
    executedAt: input.tradeDate ?? Date.now(),
  };
}

authed.post("/portfolios/:id/positions", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const body = await c.req
    .json<{ positions?: PositionInput[] } | PositionInput>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  const inputs =
    "positions" in body && Array.isArray(body.positions)
      ? body.positions
      : [body as PositionInput];

  for (const [index, input] of inputs.entries()) {
    const error = validatePosition(input);
    if (error) return c.json({ error, index }, 400);
  }

  const ids = await insertPositions(c.env, portfolio.id, inputs, "manual");
  await recordTransactions(
    c.env,
    portfolio.id,
    inputs.map((input) => positionToTransaction(input, "manual")),
  );
  await touchPortfolio(c.env, portfolio.id);
  return c.json({ ids }, 201);
});

authed.delete("/portfolios/:id/positions/:positionId", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const result = await c.env.DB.prepare(
    "DELETE FROM positions WHERE id = ? AND portfolio_id = ?",
  )
    .bind(c.req.param("positionId"), portfolio.id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Position not found." }, 404);
  }
  await touchPortfolio(c.env, portfolio.id);
  return c.json({ ok: true });
});

async function touchPortfolio(env: Env, portfolioId: string): Promise<void> {
  await env.DB.prepare("UPDATE portfolios SET updated_at = ? WHERE id = ?")
    .bind(Date.now(), portfolioId)
    .run();
}

// ------------------------------------------------------------ analysis

authed.get("/portfolios/:id/analysis", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM positions WHERE portfolio_id = ?",
  )
    .bind(portfolio.id)
    .all();

  const positions = (results ?? []).map(rowToPosition);
  if (positions.length === 0) {
    return c.json({ empty: true, positions: [] });
  }

  const tickers = [...new Set(positions.map((p) => p.ticker))];

  try {
    const quotes = await getQuotes(c.env, tickers);
    const history = [];
    const historyStale: string[] = [];

    for (const ticker of tickers) {
      if (quotes.spot[ticker] === undefined) continue;
      try {
        const result = await getPriceHistory(c.env, ticker);
        if (result.series.closes.length >= 2) history.push(result.series);
        if (result.stale) historyStale.push(ticker);
      } catch {
        // A ticker without history drops out of the correlation matrix but
        // still contributes exposure and Greeks.
        historyStale.push(ticker);
      }
    }

    const analysis = analyzePortfolio(positions, quotes.spot, history);

    return c.json({
      ...analysis,
      dataQuality: {
        staleQuotes: quotes.stale,
        staleHistory: historyStale,
        missingPrices: quotes.missing,
        asOf: new Date().toISOString(),
        provider: getProvider(c.env)?.name ?? null,
        // Which feed produced the history. Callers need this: single-venue
        // feeds bias correlation downward, which biases portfolio risk down
        // with it.
        feed:
          (getProvider(c.env)?.name === "alpaca"
            ? (c.env.ALPACA_DATA_FEED ?? "iex")
            : null),
      },
    });
  } catch (err) {
    if (err instanceof MarketDataError) {
      return c.json({ error: err.message, retryable: err.retryable }, 503);
    }
    throw err;
  }
});

/**
 * Raw price history for a portfolio's underlyings.
 *
 * The scenario sliders must recompute in under a frame, which rules out a
 * round trip per drag. The client fetches these series once and does every
 * shock locally, so the interaction stays instant while the data stays real.
 */
authed.get("/portfolios/:id/history", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT DISTINCT ticker FROM positions WHERE portfolio_id = ?",
  )
    .bind(portfolio.id)
    .all<{ ticker: string }>();

  const series = [];
  const stale: string[] = [];
  const failures: { ticker: string; reason: string }[] = [];

  for (const row of results ?? []) {
    try {
      const result = await getPriceHistory(c.env, row.ticker);
      if (result.series.closes.length >= 2) series.push(result.series);
      if (result.stale) stale.push(row.ticker);
    } catch (err) {
      // A ticker without history drops out of correlation but still carries
      // exposure and Greeks, so this is not fatal. It is reported rather than
      // swallowed: a silent empty series looks identical to "no data
      // configured", which sends you debugging the wrong thing entirely.
      stale.push(row.ticker);
      failures.push({
        ticker: row.ticker,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    series,
    stale,
    failures,
    feed:
      getProvider(c.env)?.name === "alpaca"
        ? (c.env.ALPACA_DATA_FEED ?? "iex")
        : null,
  });
});

// ------------------------------------------------------------- brokers

authed.get("/brokers", (c) => {
  return c.json({
    brokers: listAdapters().map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      authModel: adapter.authModel,
      notes: adapter.notes,
      credentialFields: adapter.credentialFields,
      configured: isConfigured(adapter, c.env),
    })),
    csvOnly: CSV_ONLY_BROKERS,
  });
});

authed.get("/connections", async (c) => {
  const session = c.get("session");
  // A row in broker_connection_errors means the last sync failed. Joining it in
  // here is what lets Settings show a connection as broken without a probe.
  const { results } = await c.env.DB.prepare(
    `SELECT bc.id, bc.broker, bc.account_label, bc.scope, bc.created_at, bc.last_synced_at,
            bce.message AS last_error, bce.occurred_at AS last_error_at
       FROM broker_connections bc
       LEFT JOIN broker_connection_errors bce ON bce.connection_id = bc.id
      WHERE bc.user_id = ?`,
  )
    .bind(session.userId)
    .all<{
      id: string;
      broker: string;
      account_label: string | null;
      scope: string | null;
      created_at: number;
      last_synced_at: number | null;
      last_error: string | null;
      last_error_at: number | null;
    }>();

  return c.json({
    connections: (results ?? []).map((r) => ({
      id: r.id,
      broker: r.broker,
      account_label: r.account_label,
      scope: r.scope,
      created_at: r.created_at,
      last_synced_at: r.last_synced_at,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at,
    })),
  });
});

authed.delete("/connections/:id", async (c) => {
  const session = c.get("session");
  const result = await c.env.DB.prepare(
    "DELETE FROM broker_connections WHERE id = ? AND user_id = ?",
  )
    .bind(c.req.param("id"), session.userId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Connection not found." }, 404);
  }
  return c.json({ ok: true });
});

/** API-key brokers connect in one step. */
authed.post("/connect/:broker/keys", async (c) => {
  const session = c.get("session");
  const brokerId = c.req.param("broker");
  const adapter = getAdapter(brokerId);

  if (!adapter?.connectWithKeys) {
    return c.json({ error: "Unknown or non-key-based broker." }, 404);
  }

  const credentials = await c.req
    .json<Record<string, string>>()
    .catch(() => null);
  if (!credentials) return c.json({ error: "Invalid JSON body." }, 400);

  try {
    const tokens = await adapter.connectWithKeys(
      credentials,
      brokerEnv(c.env, adapter.id),
    );
    await storeConnection(c.env, session.userId, adapter.id, tokens);
    return c.json({ ok: true, accountLabel: tokens.accountLabel }, 201);
  } catch (err) {
    if (err instanceof BrokerError) {
      return c.json({ error: err.message }, err.retryable ? 503 : 400);
    }
    throw err;
  }
});

/** OAuth brokers: step 1, redirect to the broker with a signed state. */
authed.get("/connect/:broker", async (c) => {
  const session = c.get("session");
  const brokerId = c.req.param("broker");
  const adapter = getAdapter(brokerId);

  if (!adapter?.authUrl) {
    return c.json({ error: "Unknown or non-OAuth broker." }, 404);
  }
  if (!isConfigured(adapter, c.env)) {
    return c.json(
      { error: `${adapter.displayName} is not configured on this deployment.` },
      503,
    );
  }

  // Signed and KV-backed: the signature proves we issued it, and the KV entry
  // makes it single-use. Either alone is weaker than both.
  const nonce = randomId("st");
  const payload = `${session.userId}:${adapter.id}:${nonce}`;
  const signature = await hmacSign(payload, c.env.STATE_SIGNING_SECRET);
  const state = `${payload}:${signature}`;

  await c.env.KV.put(`oauth_state:${nonce}`, session.userId, {
    expirationTtl: 600,
  });

  const redirectUri = `${c.env.API_ORIGIN}/callback/${adapter.id}`;
  return c.redirect(
    adapter.authUrl(state, redirectUri, brokerEnv(c.env, adapter.id)),
  );
});

/** OAuth brokers: step 2, validate state and exchange the code. */
app.get("/callback/:broker", async (c) => {
  const brokerId = c.req.param("broker");
  const adapter = getAdapter(brokerId);
  const code = c.req.query("code");
  const state = c.req.query("state");

  const fail = (reason: string) =>
    c.redirect(`${c.env.APP_ORIGIN}/settings?connect_error=${reason}`);

  if (!adapter?.exchangeCode) return fail("unknown_broker");
  if (!code || !state) return fail("missing_code");

  const parts = state.split(":");
  if (parts.length !== 4) return fail("bad_state");
  const [userId, stateBroker, nonce, signature] = parts;

  const valid = await hmacVerify(
    `${userId}:${stateBroker}:${nonce}`,
    signature,
    c.env.STATE_SIGNING_SECRET,
  );
  if (!valid || stateBroker !== adapter.id) return fail("bad_state");

  // Consume the nonce so a replayed callback cannot mint a second connection.
  const storedUserId = await c.env.KV.get(`oauth_state:${nonce}`);
  if (storedUserId !== userId) return fail("expired_state");
  await c.env.KV.delete(`oauth_state:${nonce}`);

  try {
    const redirectUri = `${c.env.API_ORIGIN}/callback/${adapter.id}`;
    const tokens = await adapter.exchangeCode(
      code,
      redirectUri,
      brokerEnv(c.env, adapter.id),
    );
    await storeConnection(c.env, userId, adapter.id, tokens);
    return c.redirect(`${c.env.APP_ORIGIN}/settings?connected=${adapter.id}`);
  } catch {
    return fail("exchange_failed");
  }
});

async function storeConnection(
  env: Env,
  userId: string,
  broker: BrokerId,
  tokens: BrokerTokens,
): Promise<void> {
  const accessEnc = await encryptToken(
    tokens.accessToken,
    env.TOKEN_ENCRYPTION_KEY,
  );
  const refreshEnc = tokens.refreshToken
    ? await encryptToken(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY)
    : null;

  await env.DB.prepare(
    `INSERT INTO broker_connections
      (id, user_id, broker, access_token_enc, refresh_token_enc, expires_at, scope, account_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, broker) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       account_label = excluded.account_label`,
  )
    .bind(
      randomId("conn"),
      userId,
      broker,
      accessEnc,
      refreshEnc,
      tokens.expiresAt ?? null,
      tokens.scope ?? null,
      tokens.accountLabel ?? null,
      Date.now(),
    )
    .run();
}

/** Sync positions from a connected broker into a portfolio. */
authed.post("/portfolios/:id/sync", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const body = await c.req
    .json<{ broker?: string }>()
    .catch(() => ({}) as { broker?: string });
  const brokerId = body.broker;
  if (!brokerId) return c.json({ error: "A broker is required." }, 400);

  const adapter = getAdapter(brokerId);
  if (!adapter) return c.json({ error: "Unknown broker." }, 404);

  const row = await c.env.DB.prepare(
    "SELECT id, access_token_enc, refresh_token_enc, expires_at, scope FROM broker_connections WHERE user_id = ? AND broker = ?",
  )
    .bind(session.userId, adapter.id)
    .first<{
      id: string;
      access_token_enc: string;
      refresh_token_enc: string | null;
      expires_at: number | null;
      scope: string | null;
    }>();

  if (!row) return c.json({ error: `No ${adapter.displayName} connection.` }, 404);

  let tokens: BrokerTokens = {
    accessToken: await decryptToken(
      row.access_token_enc,
      c.env.TOKEN_ENCRYPTION_KEY,
    ),
    refreshToken: row.refresh_token_enc
      ? await decryptToken(row.refresh_token_enc, c.env.TOKEN_ENCRYPTION_KEY)
      : undefined,
    expiresAt: row.expires_at ?? undefined,
    scope: row.scope ?? undefined,
  };

  // Refresh a little early rather than racing the expiry.
  const EXPIRY_BUFFER_MS = 60_000;
  if (
    adapter.refresh &&
    tokens.expiresAt &&
    tokens.expiresAt - EXPIRY_BUFFER_MS < Date.now()
  ) {
    try {
      tokens = await adapter.refresh(tokens, brokerEnv(c.env, adapter.id));
      await storeConnection(c.env, session.userId, adapter.id, tokens);
    } catch {
      return c.json(
        { error: "Connection expired. Please reconnect this broker." },
        401,
      );
    }
  }

  const brokerSource = `broker:${adapter.id}`;

  let fetched: NormalizedPosition[];
  try {
    fetched = await adapter.fetchPositions(tokens);
  } catch (err) {
    // Record the failure so Settings can show this connection as broken
    // without having to re-run a sync to find out.
    await recordConnectionError(
      c.env,
      row.id,
      err instanceof Error ? err.message : String(err),
    );
    if (err instanceof BrokerError) {
      return c.json({ error: err.message }, err.retryable ? 503 : 400);
    }
    throw err;
  }

  await clearConnectionError(c.env, row.id);

  // Snapshot what this broker supplied last time, so the replace below can
  // still tell which lots are genuinely new.
  const { results: previous } = await c.env.DB.prepare(
    "SELECT type, ticker, quantity, cost_basis, strike, expiry, right FROM positions WHERE portfolio_id = ? AND source = ?",
  )
    .bind(portfolio.id, brokerSource)
    .all<{
      type: string;
      ticker: string;
      quantity: number;
      cost_basis: number;
      strike: number | null;
      expiry: string | null;
      right: string | null;
    }>();

  const lotKey = (p: {
    type: string;
    ticker: string;
    quantity: number;
    strike?: number | null;
    expiry?: string | null;
    right?: string | null;
  }) =>
    [p.type, p.ticker.toUpperCase(), p.quantity, p.strike ?? "", p.expiry ?? "", p.right ?? ""].join(
      "|",
    );

  const seen = new Set((previous ?? []).map(lotKey));

  // Replace only what this broker previously supplied, so a sync never
  // destroys manually entered positions.
  await c.env.DB.prepare(
    "DELETE FROM positions WHERE portfolio_id = ? AND source = ?",
  )
    .bind(portfolio.id, brokerSource)
    .run();

  await insertPositions(
    c.env,
    portfolio.id,
    fetched.map((p) => ({
      type: p.type,
      ticker: p.ticker,
      quantity: p.quantity,
      costBasis: p.costBasis,
      strike: p.strike,
      expiry: p.expiry,
      right: p.right,
      contractMultiplier: p.contractMultiplier,
      // Broker position feeds carry no IV, so leave it unset and let the
      // insert mark the resulting Greeks as estimates.
      iv: p.iv,
    })),
    brokerSource,
  );

  // Best-effort ledger rows for lots this broker had not reported before.
  // Brokers do not expose historical fills through `fetchPositions`, so trade
  // history for a synced account only ever begins at the first sync — the UI
  // says so rather than implying the ledger is complete.
  const newLots = fetched.filter((p) => !seen.has(lotKey(p)));
  if (newLots.length > 0) {
    await recordTransactions(
      c.env,
      portfolio.id,
      newLots.map((p) =>
        positionToTransaction(
          {
            type: p.type,
            ticker: p.ticker,
            quantity: p.quantity,
            costBasis: p.costBasis,
            strike: p.strike,
            expiry: p.expiry,
            right: p.right,
          },
          brokerSource,
        ),
      ),
    );
  }

  await c.env.DB.prepare(
    "UPDATE broker_connections SET last_synced_at = ? WHERE id = ?",
  )
    .bind(Date.now(), row.id)
    .run();
  await touchPortfolio(c.env, portfolio.id);

  return c.json({ ok: true, imported: fetched.length });
});

async function recordConnectionError(
  env: Env,
  connectionId: string,
  message: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO broker_connection_errors (connection_id, message, occurred_at) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET message = excluded.message, occurred_at = excluded.occurred_at",
  )
    .bind(connectionId, message, Date.now())
    .run();
}

async function clearConnectionError(
  env: Env,
  connectionId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM broker_connection_errors WHERE connection_id = ?",
  )
    .bind(connectionId)
    .run();
}

// -------------------------------------------------------------- groups

authed.get("/portfolios/:id/groups", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const { results: groups } = await c.env.DB.prepare(
    "SELECT id, name, color, created_at FROM groups WHERE portfolio_id = ? ORDER BY created_at",
  )
    .bind(portfolio.id)
    .all<{ id: string; name: string; color: string; created_at: number }>();

  // Membership is joined through positions so a group can never report a
  // position belonging to a different book.
  const { results: members } = await c.env.DB.prepare(
    `SELECT pg.position_id, pg.group_id
       FROM position_groups pg
       JOIN positions p ON p.id = pg.position_id
      WHERE p.portfolio_id = ?`,
  )
    .bind(portfolio.id)
    .all<{ position_id: string; group_id: string }>();

  return c.json({
    groups: (groups ?? []).map((g) => ({
      ...g,
      positionIds: (members ?? [])
        .filter((m) => m.group_id === g.id)
        .map((m) => m.position_id),
    })),
  });
});

authed.post("/portfolios/:id/groups", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "A name is required." }, 400);

  const id = randomId("grp");
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO groups (id, portfolio_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, portfolio.id, name, body.color ?? "olive", now)
    .run();

  return c.json(
    { id, name, color: body.color ?? "olive", created_at: now, positionIds: [] },
    201,
  );
});

/**
 * Ownership for group-scoped routes, resolved through the group's portfolio.
 * Same 404-not-403 reasoning as `ownedPortfolio`.
 */
async function ownedGroup(
  env: Env,
  session: SessionData,
  groupId: string,
): Promise<{ id: string; portfolio_id: string } | null> {
  return env.DB.prepare(
    `SELECT g.id, g.portfolio_id
       FROM groups g
       JOIN portfolios p ON p.id = g.portfolio_id
      WHERE g.id = ? AND p.user_id = ?`,
  )
    .bind(groupId, session.userId)
    .first<{ id: string; portfolio_id: string }>();
}

authed.patch("/groups/:id", async (c) => {
  const session = c.get("session");
  const group = await ownedGroup(c.env, session, c.req.param("id"));
  if (!group) return c.json({ error: "Group not found." }, 404);

  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });

  const name = body.name?.trim();
  if (body.name !== undefined && !name) {
    return c.json({ error: "A name is required." }, 400);
  }

  if (name !== undefined) {
    await c.env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?")
      .bind(name, group.id)
      .run();
  }
  if (body.color !== undefined) {
    await c.env.DB.prepare("UPDATE groups SET color = ? WHERE id = ?")
      .bind(body.color, group.id)
      .run();
  }

  return c.json({ ok: true });
});

authed.delete("/groups/:id", async (c) => {
  const session = c.get("session");
  const group = await ownedGroup(c.env, session, c.req.param("id"));
  if (!group) return c.json({ error: "Group not found." }, 404);

  await c.env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(group.id).run();
  return c.json({ ok: true });
});

authed.put("/groups/:id/positions/:positionId", async (c) => {
  const session = c.get("session");
  const group = await ownedGroup(c.env, session, c.req.param("id"));
  if (!group) return c.json({ error: "Group not found." }, 404);

  // The position has to live in the same book as the group.
  const position = await c.env.DB.prepare(
    "SELECT id FROM positions WHERE id = ? AND portfolio_id = ?",
  )
    .bind(c.req.param("positionId"), group.portfolio_id)
    .first<{ id: string }>();
  if (!position) return c.json({ error: "Position not found." }, 404);

  // position_id is the primary key, so assigning replaces any prior group.
  await c.env.DB.prepare(
    "INSERT INTO position_groups (position_id, group_id, added_at) VALUES (?, ?, ?) ON CONFLICT(position_id) DO UPDATE SET group_id = excluded.group_id, added_at = excluded.added_at",
  )
    .bind(position.id, group.id, Date.now())
    .run();

  return c.json({ ok: true });
});

authed.delete("/groups/:id/positions/:positionId", async (c) => {
  const session = c.get("session");
  const group = await ownedGroup(c.env, session, c.req.param("id"));
  if (!group) return c.json({ error: "Group not found." }, 404);

  const result = await c.env.DB.prepare(
    "DELETE FROM position_groups WHERE position_id = ? AND group_id = ?",
  )
    .bind(c.req.param("positionId"), group.id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Position is not in this group." }, 404);
  }
  return c.json({ ok: true });
});

// -------------------------------------------------------- transactions

authed.get("/portfolios/:id/transactions", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const transactions = await listTransactions(
    c.env,
    portfolio.id,
    c.req.query("ticker"),
  );
  return c.json({ transactions });
});

authed.post("/portfolios/:id/transactions", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const body = await c.req.json<Partial<NewTransaction>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  if (!body.ticker || typeof body.ticker !== "string") {
    return c.json({ error: "A ticker is required." }, 400);
  }
  if (
    body.positionType !== "stock" &&
    body.positionType !== "option" &&
    body.positionType !== "bond"
  ) {
    return c.json({ error: "positionType must be stock, option, or bond." }, 400);
  }
  if (body.side !== "buy" && body.side !== "sell") {
    return c.json({ error: "side must be 'buy' or 'sell'." }, 400);
  }
  if (!Number.isFinite(body.quantity) || (body.quantity ?? 0) <= 0) {
    return c.json({ error: "Quantity must be a positive number." }, 400);
  }
  if (!Number.isFinite(body.price) || (body.price ?? -1) < 0) {
    return c.json({ error: "Price must be a non-negative number." }, 400);
  }

  const id = await recordTransaction(c.env, portfolio.id, {
    ticker: body.ticker,
    positionType: body.positionType,
    side: body.side,
    quantity: body.quantity!,
    price: body.price!,
    currency: body.currency,
    fee: body.fee,
    strike: body.strike,
    expiry: body.expiry,
    right: body.right,
    executedAt: body.executedAt,
  });

  return c.json({ id }, 201);
});

/** Start of the current calendar year, in epoch ms. */
function taxYearStart(): { start: number; year: number } {
  const year = new Date().getUTCFullYear();
  return { start: Date.UTC(year, 0, 1), year };
}

authed.get("/portfolios/:id/realized", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  // OneBook has no jurisdiction concept, so the calendar year is the only
  // defensible default tax year.
  const { start, year } = taxYearStart();
  const all = await listTransactions(c.env, portfolio.id);

  // FIFO needs the full history to know what a sale is closing, so match over
  // everything and filter the results to this year afterwards.
  const { realized, openLots } = computeFifo(all.map(toLedgerTransaction));
  const thisYear = realized.filter(
    (lot) => Date.parse(`${lot.closedAt}T00:00:00Z`) >= start,
  );

  return c.json({
    year,
    realized: thisYear,
    openLots,
    totalRealizedPnl: thisYear.reduce((a, lot) => a + lot.realizedPnl, 0),
  });
});

// -------------------------------------------------------------- exports

authed.get("/portfolios/:id/export.csv", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM positions WHERE portfolio_id = ? ORDER BY created_at",
  )
    .bind(portfolio.id)
    .all();

  const transactions = await listTransactions(c.env, portfolio.id);

  // Two tables in one file, separated by a blank line and a section marker —
  // spreadsheets import this cleanly and it beats making the user download
  // two files for one export action.
  const body = [
    "# positions",
    positionsToCsv((results ?? []).map(rowToPosition)),
    "# transactions",
    transactionsToCsv(transactions.map(toLedgerTransaction)),
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="onebook-${portfolio.id}.csv"`,
    },
  });
});

authed.get("/portfolios/:id/export/tax-report.pdf", async (c) => {
  const session = c.get("session");
  const portfolio = await ownedPortfolio(c.env, session, c.req.param("id"));
  if (!portfolio) return c.json({ error: "Portfolio not found." }, 404);

  const { start, year } = taxYearStart();
  const all = await listTransactions(c.env, portfolio.id);
  const { realized } = computeFifo(all.map(toLedgerTransaction));
  const lots = realized.filter(
    (lot) => Date.parse(`${lot.closedAt}T00:00:00Z`) >= start,
  );

  const pdf = await buildTaxReportPdf(portfolio.name, year, lots);
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="onebook-tax-${year}.pdf"`,
    },
  });
});

/**
 * A plain monospace table on one page. Deliberately unstyled: a PDF is the one
 * export that genuinely cannot be hand-rolled, but that is no reason to build
 * a layout system on top of it.
 */
async function buildTaxReportPdf(
  portfolioName: string,
  year: number,
  lots: {
    ticker: string;
    quantity: number;
    proceeds: number;
    costBasis: number;
    realizedPnl: number;
    openedAt: string;
    closedAt: string;
  }[],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const bold = await doc.embedFont(StandardFonts.CourierBold);

  let page = doc.addPage();
  const { height } = page.getSize();
  const left = 40;
  let y = height - 50;

  const line = (text: string, useBold = false) => {
    if (y < 40) {
      page = doc.addPage();
      y = page.getSize().height - 50;
    }
    page.drawText(text, {
      x: left,
      y,
      size: 9,
      font: useBold ? bold : font,
    });
    y -= 13;
  };

  const money = (n: number) =>
    (n < 0 ? "-" : "") +
    Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  line(`Realized gains and losses — ${year}`, true);
  line(portfolioName);
  line("");
  line(
    "Symbol".padEnd(10) +
      "Qty".padStart(10) +
      "Opened".padStart(13) +
      "Closed".padStart(13) +
      "Proceeds".padStart(14) +
      "Cost".padStart(14) +
      "Gain/Loss".padStart(14),
    true,
  );
  line("-".repeat(88));

  for (const lot of lots) {
    line(
      lot.ticker.slice(0, 9).padEnd(10) +
        String(lot.quantity).padStart(10) +
        lot.openedAt.padStart(13) +
        lot.closedAt.padStart(13) +
        money(lot.proceeds).padStart(14) +
        money(lot.costBasis).padStart(14) +
        money(lot.realizedPnl).padStart(14),
    );
  }

  if (lots.length === 0) line("No closing trades in this tax year.");

  line("-".repeat(88));
  line(
    "TOTAL".padEnd(74) +
      money(lots.reduce((a, l) => a + l.realizedPnl, 0)).padStart(14),
    true,
  );
  line("");
  line("FIFO cost basis. Calendar year. Not tax advice.");

  return doc.save();
}

// -------------------------------------------------------- account (/me)

authed.get("/me/preferences", async (c) => {
  const session = c.get("session");
  const row = await c.env.DB.prepare(
    "SELECT display_name, theme, currency, compact_numbers, show_unrealized_pnl FROM user_preferences WHERE user_id = ?",
  )
    .bind(session.userId)
    .first<{
      display_name: string | null;
      theme: string;
      currency: string;
      compact_numbers: number;
      show_unrealized_pnl: number;
    }>();

  // No row yet is the normal state for a new account, not an error.
  return c.json({
    displayName: row?.display_name ?? null,
    theme: row?.theme ?? "dark",
    currency: row?.currency ?? "USD",
    compactNumbers: row ? row.compact_numbers === 1 : false,
    showUnrealizedPnl: row ? row.show_unrealized_pnl === 1 : true,
  });
});

authed.patch("/me/preferences", async (c) => {
  const session = c.get("session");
  const body = await c.req
    .json<{
      displayName?: string | null;
      theme?: string;
      currency?: string;
      compactNumbers?: boolean;
      showUnrealizedPnl?: boolean;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  if (body.theme !== undefined && body.theme !== "dark" && body.theme !== "light") {
    return c.json({ error: "Theme must be 'dark' or 'light'." }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT display_name, theme, currency, compact_numbers, show_unrealized_pnl FROM user_preferences WHERE user_id = ?",
  )
    .bind(session.userId)
    .first<{
      display_name: string | null;
      theme: string;
      currency: string;
      compact_numbers: number;
      show_unrealized_pnl: number;
    }>();

  const merged = {
    displayName:
      body.displayName !== undefined
        ? body.displayName
        : (existing?.display_name ?? null),
    theme: body.theme ?? existing?.theme ?? "dark",
    currency: body.currency ?? existing?.currency ?? "USD",
    compactNumbers:
      body.compactNumbers !== undefined
        ? body.compactNumbers
        : existing?.compact_numbers === 1,
    showUnrealizedPnl:
      body.showUnrealizedPnl !== undefined
        ? body.showUnrealizedPnl
        : existing?.show_unrealized_pnl !== 0,
  };

  await c.env.DB.prepare(
    `INSERT INTO user_preferences
      (user_id, display_name, theme, currency, compact_numbers, show_unrealized_pnl, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = excluded.display_name,
       theme = excluded.theme,
       currency = excluded.currency,
       compact_numbers = excluded.compact_numbers,
       show_unrealized_pnl = excluded.show_unrealized_pnl,
       updated_at = excluded.updated_at`,
  )
    .bind(
      session.userId,
      merged.displayName,
      merged.theme,
      merged.currency,
      merged.compactNumbers ? 1 : 0,
      merged.showUnrealizedPnl ? 1 : 0,
      Date.now(),
    )
    .run();

  return c.json(merged);
});

authed.get("/me/sessions", async (c) => {
  const session = c.get("session");
  // The client cannot read an httpOnly cookie, so the "this is you" marker has
  // to be resolved here rather than guessed from timestamps.
  const current = currentSessionId(c as never);

  const { results } = await c.env.DB.prepare(
    "SELECT id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC",
  )
    .bind(session.userId)
    .all<{
      id: string;
      created_at: number;
      last_seen_at: number;
      user_agent: string | null;
    }>();

  return c.json({
    sessions: (results ?? []).map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      userAgent: s.user_agent,
      isCurrent: s.id === current,
    })),
  });
});

authed.delete("/me/sessions/:id", async (c) => {
  const session = c.get("session");
  const targetId = c.req.param("id");

  const result = await c.env.DB.prepare(
    "DELETE FROM sessions WHERE id = ? AND user_id = ?",
  )
    .bind(targetId, session.userId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Session not found." }, 404);
  }

  await c.env.KV.delete(`session:${targetId}`);

  // Revoking the session you are currently using should also log you out here,
  // rather than leaving a cookie pointing at a session that no longer exists.
  const isCurrent = targetId === currentSessionId(c as never);
  if (isCurrent) await destroySession(c as never);

  return c.json({ ok: true, signedOut: isCurrent });
});

authed.delete("/me", async (c) => {
  const session = c.get("session");

  // Every user-owned table cascades from `users`, so this one delete is the
  // whole account. Sessions in KV are not covered by a foreign key, so they
  // are cleared explicitly first.
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ?",
  )
    .bind(session.userId)
    .all<{ id: string }>();

  for (const row of results ?? []) {
    await c.env.KV.delete(`session:${row.id}`);
  }

  await c.env.DB.prepare("DELETE FROM users WHERE id = ?")
    .bind(session.userId)
    .run();
  await destroySession(c as never);

  return c.json({ ok: true });
});

app.route("/", authed);

// -------------------------------------------------------------- shared

interface PositionRow {
  id: string;
  type: string;
  ticker: string;
  quantity: number;
  cost_basis: number;
  currency: string | null;
  strike: number | null;
  expiry: string | null;
  right: string | null;
  contract_multiplier: number | null;
  iv: number | null;
  iv_is_estimate: number | null;
  coupon_rate: number | null;
  maturity: string | null;
  face_value: number | null;
  price: number | null;
  source: string;
}

function rowToPosition(row: unknown): Position & { source: string } {
  const r = row as PositionRow;
  if (r.type === "option") {
    return {
      id: r.id,
      type: "option",
      ticker: r.ticker,
      quantity: r.quantity,
      costBasis: r.cost_basis,
      currency: r.currency ?? "USD",
      strike: r.strike ?? 0,
      expiry: r.expiry ?? "",
      right: r.right === "put" ? "put" : "call",
      contractMultiplier: r.contract_multiplier ?? 100,
      iv: r.iv ?? 0.3,
      ivIsEstimate: r.iv_is_estimate === 1,
      source: r.source,
    };
  }
  if (r.type === "bond") {
    return {
      id: r.id,
      type: "bond",
      ticker: r.ticker,
      faceValue: r.face_value ?? 0,
      couponRate: r.coupon_rate ?? 0,
      maturity: r.maturity ?? "",
      price: r.price ?? 0,
      costBasis: r.cost_basis,
      currency: r.currency ?? "USD",
      source: r.source,
    };
  }
  return {
    id: r.id,
    type: "stock",
    ticker: r.ticker,
    quantity: r.quantity,
    costBasis: r.cost_basis,
    currency: r.currency ?? "USD",
    source: r.source,
  };
}

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error." }, 500);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

export default app;
