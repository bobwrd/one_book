/**
 * Magic-link authentication.
 *
 * No passwords, so there is no hashing choice to get wrong, no reset flow, and
 * no credential to leak. Login tokens are single-use, short-lived, and stored
 * hashed; sessions live in KV with a TTL and are referenced by an HTTP-only
 * cookie.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  LOGIN_TOKEN_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type Env,
  type SessionData,
} from "./env.js";
import { randomId, randomToken, sha256Hex } from "./crypto.js";

export interface AuthedVariables {
  session: SessionData;
}

export type AppContext = Context<{ Bindings: Env; Variables: AuthedVariables }>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Issue a magic link. Returns the token so the caller can email it.
 *
 * Deliberately does not reveal whether the email already has an account —
 * the endpoint's response is identical either way, so this cannot be used to
 * enumerate registered users.
 */
export async function createLoginToken(
  env: Env,
  email: string,
): Promise<string> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + LOGIN_TOKEN_TTL_SECONDS * 1000;

  await env.DB.prepare(
    "INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)",
  )
    .bind(tokenHash, email, expiresAt)
    .run();

  return token;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Consume a magic-link token and return the session.
 * Creates the user on first login.
 */
export async function consumeLoginToken(
  env: Env,
  token: string,
  userAgent?: string,
): Promise<{ sessionId: string; session: SessionData }> {
  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(
    "SELECT token_hash, email, expires_at, consumed_at FROM login_tokens WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      email: string;
      expires_at: number;
      consumed_at: number | null;
    }>();

  if (!row) throw new AuthError("Invalid or expired login link.");
  if (row.consumed_at !== null) {
    throw new AuthError("This login link has already been used.");
  }
  if (row.expires_at < Date.now()) {
    throw new AuthError("This login link has expired.");
  }

  // Mark consumed before issuing the session, and make the update conditional
  // on it still being unconsumed so two concurrent redemptions cannot both
  // succeed.
  const consumed = await env.DB.prepare(
    "UPDATE login_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
  )
    .bind(Date.now(), tokenHash)
    .run();

  if (consumed.meta.changes === 0) {
    throw new AuthError("This login link has already been used.");
  }

  let user = await env.DB.prepare(
    "SELECT id, email FROM users WHERE email = ?",
  )
    .bind(row.email)
    .first<{ id: string; email: string }>();

  if (!user) {
    const id = randomId("usr");
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
    )
      .bind(id, row.email, Date.now())
      .run();
    user = { id, email: row.email };
  }

  const session: SessionData = {
    userId: user.id,
    email: user.email,
    createdAt: Date.now(),
  };
  const sessionId = randomToken(32);

  await env.KV.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // KV stays the source of truth for the payload and TTL. This row exists only
  // so "which sessions belong to this user" is answerable — KV cannot be
  // enumerated by user.
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      sessionId,
      user.id,
      session.createdAt,
      session.createdAt,
      userAgent ?? null,
    )
    .run();

  return { sessionId, session };
}

/**
 * The caller's own session id, read from the cookie.
 *
 * The client cannot read an httpOnly cookie, so anything that needs to mark
 * "this is the session you're using right now" has to resolve it server-side.
 */
export function currentSessionId(c: AppContext): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: AppContext, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(c: AppContext): Promise<void> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await c.env.KV.delete(`session:${sessionId}`);
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?")
      .bind(sessionId)
      .run();
  }
  setCookie(c, SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

export async function readSession(
  c: AppContext,
): Promise<SessionData | null> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;

  const raw = await c.env.KV.get(`session:${sessionId}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

/**
 * How stale `last_seen_at` may get before a request refreshes it.
 *
 * Writing on every authenticated request would cost a D1 write per API call
 * for a column nothing reads in real time. Settings shows this as relative
 * time ("3h ago"), so minute-level precision is already more than it renders.
 */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

/**
 * Record that a session was used.
 *
 * The freshness guard lives in the WHERE clause so this stays a single
 * statement — no read to decide whether to write.
 */
async function touchSession(env: Env, sessionId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?",
  )
    .bind(now, sessionId, now - LAST_SEEN_REFRESH_MS)
    .run();
}

/**
 * Route guard. Every authenticated route hangs off this, so `user_id` is
 * always derived from the session and never from a client-supplied value.
 */
export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthedVariables;
}> = async (c, next) => {
  const session = await readSession(c as AppContext);
  if (!session) {
    return c.json({ error: "Not authenticated." }, 401);
  }
  c.set("session", session);

  // Off the response path: the caller is waiting on their actual request, not
  // on session bookkeeping. Failures here are deliberately swallowed — a
  // missed timestamp must never turn a working request into an error.
  const sessionId = currentSessionId(c as AppContext);
  if (sessionId) {
    const write = touchSession(c.env, sessionId).catch(() => {});
    try {
      c.executionCtx.waitUntil(write);
    } catch {
      // No execution context (unit tests, some runtimes); the write is
      // already in flight, so just let it settle.
      await write;
    }
  }

  await next();
};

/** Build the magic-link URL the user clicks. */
export function magicLinkUrl(env: Env, token: string): string {
  return `${env.API_ORIGIN}/auth/callback?token=${encodeURIComponent(token)}`;
}
