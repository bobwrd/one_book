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
import { getPriceHistory, getQuotes, MarketDataError } from "./marketData.js";
import { analyzePortfolio } from "./analysis.js";
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
    const { sessionId } = await consumeLoginToken(c.env, token);
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
  type: "stock" | "option";
  ticker: string;
  quantity: number;
  costBasis?: number;
  strike?: number;
  expiry?: string;
  right?: "call" | "put";
  contractMultiplier?: number;
  iv?: number;
}

function validatePosition(input: PositionInput): string | null {
  if (!input.ticker || typeof input.ticker !== "string") {
    return "A ticker is required.";
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
      (id, portfolio_id, type, ticker, quantity, cost_basis, strike, expiry, right, contract_multiplier, iv, iv_is_estimate, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const statements = inputs.map((input) => {
    const id = randomId("pos");
    ids.push(id);
    const isOption = input.type === "option";
    return statement.bind(
      id,
      portfolioId,
      input.type,
      input.ticker.toUpperCase(),
      input.quantity,
      input.costBasis ?? 0,
      isOption ? input.strike : null,
      isOption ? input.expiry : null,
      isOption ? input.right : null,
      isOption ? (input.contractMultiplier ?? 100) : null,
      isOption ? (input.iv ?? 0.3) : null,
      isOption ? (input.iv === undefined ? 1 : 0) : null,
      source,
      now,
    );
  });

  if (statements.length > 0) await env.DB.batch(statements);
  return ids;
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

  for (const row of results ?? []) {
    try {
      const result = await getPriceHistory(c.env, row.ticker);
      if (result.series.closes.length >= 2) series.push(result.series);
      if (result.stale) stale.push(row.ticker);
    } catch {
      // A ticker without history drops out of correlation but still carries
      // exposure and Greeks, so this is not fatal.
      stale.push(row.ticker);
    }
  }

  return c.json({ series, stale });
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
  const { results } = await c.env.DB.prepare(
    "SELECT id, broker, account_label, scope, created_at, last_synced_at FROM broker_connections WHERE user_id = ?",
  )
    .bind(session.userId)
    .all();
  return c.json({ connections: results ?? [] });
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

  let fetched: NormalizedPosition[];
  try {
    fetched = await adapter.fetchPositions(tokens);
  } catch (err) {
    if (err instanceof BrokerError) {
      return c.json({ error: err.message }, err.retryable ? 503 : 400);
    }
    throw err;
  }

  // Replace only what this broker previously supplied, so a sync never
  // destroys manually entered positions.
  await c.env.DB.prepare(
    "DELETE FROM positions WHERE portfolio_id = ? AND source = ?",
  )
    .bind(portfolio.id, `broker:${adapter.id}`)
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
    `broker:${adapter.id}`,
  );

  await c.env.DB.prepare(
    "UPDATE broker_connections SET last_synced_at = ? WHERE id = ?",
  )
    .bind(Date.now(), row.id)
    .run();
  await touchPortfolio(c.env, portfolio.id);

  return c.json({ ok: true, imported: fetched.length });
});

app.route("/", authed);

// -------------------------------------------------------------- shared

interface PositionRow {
  id: string;
  type: string;
  ticker: string;
  quantity: number;
  cost_basis: number;
  strike: number | null;
  expiry: string | null;
  right: string | null;
  contract_multiplier: number | null;
  iv: number | null;
  iv_is_estimate: number | null;
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
      strike: r.strike ?? 0,
      expiry: r.expiry ?? "",
      right: r.right === "put" ? "put" : "call",
      contractMultiplier: r.contract_multiplier ?? 100,
      iv: r.iv ?? 0.3,
      ivIsEstimate: r.iv_is_estimate === 1,
      source: r.source,
    };
  }
  return {
    id: r.id,
    type: "stock",
    ticker: r.ticker,
    quantity: r.quantity,
    costBasis: r.cost_basis,
    source: r.source,
  };
}

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error." }, 500);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

export default app;
