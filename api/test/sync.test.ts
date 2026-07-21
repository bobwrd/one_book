/**
 * Broker sync, driven through the real route rather than its helpers.
 *
 * The behavior under test is the connection-health signal: a failed
 * `fetchPositions` must leave a `broker_connection_errors` row behind, and a
 * later success must clear it. Settings reads that row to show a connection as
 * broken, so getting it wrong means a dead connection looks healthy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { encryptToken } from "../src/crypto.js";
import type { Env } from "../src/env.js";

const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const SESSION_ID = "session-abc";
const USER_ID = "usr_1";
const PORTFOLIO_ID = "pf_1";
const CONNECTION_ID = "conn_1";

interface Tables {
  portfolios: Record<string, unknown>[];
  broker_connections: Record<string, unknown>[];
  broker_connection_errors: Record<string, unknown>[];
  positions: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
}

/**
 * In-memory D1 stand-in, dispatching on the statement text. It only knows the
 * statements this route issues — enough to exercise real routing, ownership
 * checks, and write ordering without a database.
 */
/** Bind args of every `UPDATE sessions SET last_seen_at` issued this test. */
let sessionUpdates: number[][] = [];

function fakeDb(tables: Tables) {
  function run(sql: string, args: unknown[]) {
    if (sql.includes("UPDATE sessions SET last_seen_at")) {
      sessionUpdates.push(args as number[]);
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO broker_connection_errors")) {
      const [connection_id, message, occurred_at] = args;
      tables.broker_connection_errors = tables.broker_connection_errors.filter(
        (r) => r.connection_id !== connection_id,
      );
      tables.broker_connection_errors.push({
        connection_id,
        message,
        occurred_at,
      });
      return { changes: 1 };
    }
    if (sql.includes("DELETE FROM broker_connection_errors")) {
      const before = tables.broker_connection_errors.length;
      tables.broker_connection_errors = tables.broker_connection_errors.filter(
        (r) => r.connection_id !== args[0],
      );
      return { changes: before - tables.broker_connection_errors.length };
    }
    if (sql.includes("DELETE FROM positions")) {
      const before = tables.positions.length;
      tables.positions = tables.positions.filter(
        (r) => !(r.portfolio_id === args[0] && r.source === args[1]),
      );
      return { changes: before - tables.positions.length };
    }
    if (sql.includes("INSERT INTO positions")) {
      tables.positions.push({
        id: args[0],
        portfolio_id: args[1],
        type: args[2],
        ticker: args[3],
        quantity: args[4],
        source: args[17],
      });
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO transactions")) {
      tables.transactions.push({
        id: args[0],
        portfolio_id: args[1],
        ticker: args[2],
        position_type: args[3],
        side: args[4],
        quantity: args[5],
        price: args[6],
        source: args[12],
      });
      return { changes: 1 };
    }
    // UPDATE statements (last_synced_at, portfolios.updated_at) need no state.
    return { changes: 1 };
  }

  function first(sql: string, args: unknown[]) {
    if (sql.includes("FROM portfolios")) {
      return (
        tables.portfolios.find(
          (p) => p.id === args[0] && p.user_id === args[1],
        ) ?? null
      );
    }
    if (sql.includes("FROM broker_connections")) {
      return (
        tables.broker_connections.find(
          (r) => r.user_id === args[0] && r.broker === args[1],
        ) ?? null
      );
    }
    return null;
  }

  function all(sql: string, args: unknown[]) {
    if (sql.includes("FROM positions")) {
      return tables.positions.filter(
        (r) => r.portfolio_id === args[0] && r.source === args[1],
      );
    }
    return [];
  }

  function statement(sql: string, args: unknown[] = []) {
    return {
      sql,
      args,
      bind(...next: unknown[]) {
        return statement(sql, next);
      },
      async first<T>() {
        return first(sql, args) as T | null;
      },
      async all<T>() {
        return { results: all(sql, args) as T[], success: true };
      },
      async run() {
        return { success: true, meta: run(sql, args) };
      },
    };
  }

  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: { sql: string; args: unknown[] }[]) {
      return statements.map((s) => ({ success: true, meta: run(s.sql, s.args) }));
    },
  };
}

function fakeKv(session: unknown) {
  return {
    async get(key: string) {
      return key === `session:${SESSION_ID}` ? JSON.stringify(session) : null;
    },
    async put() {},
    async delete() {},
  };
}

let tables: Tables;
let env: Env;

function mockFetch(handler: (url: URL) => Response) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
    Promise.resolve(handler(new URL(String(input)))),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function syncRequest() {
  return app.request(
    `/portfolios/${PORTFOLIO_ID}/sync`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `onebook_session=${SESSION_ID}`,
      },
      body: JSON.stringify({ broker: "alpaca" }),
    },
    env,
  );
}

beforeEach(async () => {
  sessionUpdates = [];
  tables = {
    portfolios: [{ id: PORTFOLIO_ID, name: "Main", user_id: USER_ID }],
    broker_connections: [
      {
        id: CONNECTION_ID,
        user_id: USER_ID,
        broker: "alpaca",
        access_token_enc: await encryptToken(
          JSON.stringify({ keyId: "k", secretKey: "s", paper: true }),
          ENCRYPTION_KEY,
        ),
        refresh_token_enc: null,
        expires_at: null,
        scope: "read-only",
      },
    ],
    broker_connection_errors: [],
    positions: [],
    transactions: [],
  };

  env = {
    DB: fakeDb(tables) as unknown as D1Database,
    KV: fakeKv({
      userId: USER_ID,
      email: "a@example.com",
      createdAt: Date.now(),
    }) as unknown as KVNamespace,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    STATE_SIGNING_SECRET: "s",
    APP_ORIGIN: "http://localhost:5173",
    API_ORIGIN: "http://localhost:8787",
  } as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session last-seen tracking", () => {
  /**
   * Settings renders `last_seen_at` as relative time. If nothing ever wrote it
   * the column would silently mirror `created_at` forever -- a "Last seen"
   * value that is dead data dressed as live.
   */
  function updates() {
    return sessionUpdates.slice();
  }

  it("refreshes last_seen_at on an authenticated request", async () => {
    await app.request(
      "/portfolios",
      { headers: { cookie: `onebook_session=${SESSION_ID}` } },
      env,
    );

    const [write] = updates();
    expect(write).toBeDefined();
    // now, session id, and the staleness cutoff.
    expect(write[1]).toBe(SESSION_ID);
    expect(typeof write[0]).toBe("number");
  });

  it("guards the write on staleness rather than reading first", async () => {
    await app.request(
      "/portfolios",
      { headers: { cookie: `onebook_session=${SESSION_ID}` } },
      env,
    );

    const [write] = updates();
    // The cutoff trails "now" by the refresh window, so a session touched a
    // moment ago matches nothing and costs no row write.
    expect(write[0] - write[2]).toBe(5 * 60 * 1000);
  });

  it("does not touch a session for an unauthenticated request", async () => {
    await app.request("/portfolios", {}, env);
    expect(updates()).toHaveLength(0);
  });
});

describe("public reference data", () => {
  /**
   * These routes must stay registered above `app.route("/", authed)`. Mounting
   * `authed` at "/" spreads its auth guard across every path, and Hono runs
   * middleware in registration order — so a public route declared after it
   * silently starts 401ing. That is invisible until someone signed out hits it.
   */
  function publicRequest(path: string) {
    return app.request(path, {}, env);
  }

  it("serves FX rates without a session", async () => {
    mockFetch(() => json({ rates: { EUR: 0.92 } }));

    const response = await publicRequest("/fx/EUR");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currency: "EUR", rate: 0.92 });
  });

  it("short-circuits USD without a session", async () => {
    const response = await publicRequest("/fx/USD");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rate: 1 });
  });

  it("serves news without a session", async () => {
    const response = await publicRequest("/instruments/AAPL/news");

    expect(response.status).toBe(200);
    // No key configured, so this is the "not available" shape, not a 401.
    expect(await response.json()).toEqual({
      items: [],
      available: false,
      stale: false,
    });
  });

  it("still guards the account routes", async () => {
    for (const path of ["/me/preferences", "/me/sessions", "/portfolios"]) {
      expect((await publicRequest(path)).status).toBe(401);
    }
  });
});

describe("broker sync connection health", () => {
  it("records an error row when fetching positions fails", async () => {
    mockFetch(() => json({ message: "boom" }, 500));

    const response = await syncRequest();

    expect(response.status).toBe(503);
    expect(tables.broker_connection_errors).toHaveLength(1);
    expect(tables.broker_connection_errors[0].connection_id).toBe(CONNECTION_ID);
    expect(String(tables.broker_connection_errors[0].message)).toContain("500");
  });

  it("records an error row when the broker rejects the credentials", async () => {
    mockFetch(() => json({ message: "unauthorized" }, 401));

    await syncRequest();

    expect(tables.broker_connection_errors).toHaveLength(1);
  });

  it("clears the error row on a later success", async () => {
    tables.broker_connection_errors.push({
      connection_id: CONNECTION_ID,
      message: "previous failure",
      occurred_at: Date.now() - 1000,
    });
    mockFetch(() =>
      json([
        {
          symbol: "AAPL",
          qty: "100",
          side: "long",
          avg_entry_price: "150",
          asset_class: "us_equity",
        },
      ]),
    );

    const response = await syncRequest();

    expect(response.status).toBe(200);
    expect(tables.broker_connection_errors).toHaveLength(0);
  });

  it("keeps only the latest error rather than accumulating rows", async () => {
    mockFetch(() => json({ message: "boom" }, 500));

    await syncRequest();
    await syncRequest();

    expect(tables.broker_connection_errors).toHaveLength(1);
  });

  it("leaves no error row on a first successful sync", async () => {
    mockFetch(() => json([]));

    await syncRequest();

    expect(tables.broker_connection_errors).toHaveLength(0);
  });
});

describe("broker sync ledger rows", () => {
  it("records a transaction for a newly seen lot", async () => {
    mockFetch(() =>
      json([
        {
          symbol: "AAPL",
          qty: "100",
          side: "long",
          avg_entry_price: "150",
          asset_class: "us_equity",
        },
      ]),
    );

    await syncRequest();

    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions[0]).toMatchObject({
      ticker: "AAPL",
      side: "buy",
      quantity: 100,
      price: 150,
      source: "broker:alpaca",
    });
  });

  it("does not re-record a lot that was already present", async () => {
    // Brokers report positions, not fills, so an unchanged lot on the next
    // sync is the same trade — not a new one.
    tables.positions.push({
      id: "pos_existing",
      portfolio_id: PORTFOLIO_ID,
      type: "stock",
      ticker: "AAPL",
      quantity: 100,
      cost_basis: 150,
      strike: null,
      expiry: null,
      right: null,
      source: "broker:alpaca",
    });
    mockFetch(() =>
      json([
        {
          symbol: "AAPL",
          qty: "100",
          side: "long",
          avg_entry_price: "150",
          asset_class: "us_equity",
        },
      ]),
    );

    await syncRequest();

    expect(tables.transactions).toHaveLength(0);
  });

  it("records a sell-side row for a short lot", async () => {
    mockFetch(() =>
      json([
        {
          symbol: "TSLA",
          qty: "-50",
          side: "short",
          avg_entry_price: "200",
          asset_class: "us_equity",
        },
      ]),
    );

    await syncRequest();

    expect(tables.transactions[0]).toMatchObject({
      ticker: "TSLA",
      side: "sell",
      quantity: 50,
    });
  });

  it("does not touch positions or the ledger when the fetch fails", async () => {
    tables.positions.push({
      id: "pos_existing",
      portfolio_id: PORTFOLIO_ID,
      ticker: "AAPL",
      quantity: 100,
      source: "broker:alpaca",
    });
    mockFetch(() => json({ message: "boom" }, 500));

    await syncRequest();

    // A failed sync must not wipe the book it could not refresh.
    expect(tables.positions).toHaveLength(1);
    expect(tables.transactions).toHaveLength(0);
  });
});
