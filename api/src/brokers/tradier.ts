/**
 * Tradier adapter — the second integration.
 *
 * OAuth 2.0 with strong options coverage and a sandbox. Tradier also issues
 * long-lived personal access tokens, which is the path that works without an
 * approved OAuth application, so both are supported.
 */

import { parseOsiSymbol } from "@onebook/finance";
import {
  BrokerAuthExpiredError,
  BrokerError,
  type BrokerAdapter,
  type BrokerCredentials,
  type BrokerEnv,
  type BrokerTokens,
  type NormalizedPosition,
} from "./types.js";

const API_BASE = "https://api.tradier.com/v1";
const SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const AUTH_BASE = "https://api.tradier.com/v1/oauth";

interface TradierPosition {
  symbol: string;
  quantity: number;
  cost_basis: number;
}

interface TradierCreds {
  accessToken: string;
  sandbox: boolean;
}

function parseCreds(tokens: BrokerTokens): TradierCreds {
  try {
    const parsed = JSON.parse(tokens.accessToken) as TradierCreds;
    if (!parsed.accessToken) throw new Error("incomplete");
    return parsed;
  } catch {
    // Older rows stored a bare bearer token; treat those as production.
    return { accessToken: tokens.accessToken, sandbox: false };
  }
}

function baseUrl(creds: TradierCreds): string {
  return creds.sandbox ? SANDBOX_BASE : API_BASE;
}

async function tradierGet<T>(
  path: string,
  creds: TradierCreds,
): Promise<T> {
  const response = await fetch(`${baseUrl(creds)}${path}`, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      Accept: "application/json",
    },
  });

  if (response.status === 401) throw new BrokerAuthExpiredError("tradier");
  if (!response.ok) {
    throw new BrokerError(
      `Tradier returned ${response.status} for ${path}.`,
      "tradier",
      response.status >= 500,
    );
  }
  return (await response.json()) as T;
}

export const tradierAdapter: BrokerAdapter = {
  id: "tradier",
  displayName: "Tradier",
  authModel: "api-key",
  notes:
    "Use a personal access token from your Tradier account settings. Sandbox tokens work for testing.",
  credentialFields: [
    { key: "accessToken", label: "Access Token", secret: true },
  ],

  async connectWithKeys(credentials: BrokerCredentials): Promise<BrokerTokens> {
    const creds: TradierCreds = {
      accessToken: (credentials.accessToken ?? "").trim(),
      sandbox: credentials.sandbox === "true",
    };
    if (!creds.accessToken) {
      throw new BrokerError("An access token is required.", "tradier");
    }

    const profile = await tradierGet<{
      profile?: { account?: unknown; id?: string };
    }>("/user/profile", creds);

    return {
      accessToken: JSON.stringify(creds),
      accountLabel: profile.profile?.id
        ? `${creds.sandbox ? "Sandbox" : "Live"} ${profile.profile.id}`
        : creds.sandbox
          ? "Sandbox account"
          : "Live account",
      scope: "read",
    };
  },

  authUrl(state: string, redirectUri: string, env: BrokerEnv): string {
    if (!env.clientId) {
      throw new BrokerError("Tradier client ID is not configured.", "tradier");
    }
    const params = new URLSearchParams({
      client_id: env.clientId,
      response_type: "code",
      scope: "read",
      state,
      redirect_uri: redirectUri,
    });
    return `${AUTH_BASE}/authorize?${params}`;
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
    env: BrokerEnv,
  ): Promise<BrokerTokens> {
    if (!env.clientId || !env.clientSecret) {
      throw new BrokerError("Tradier OAuth is not configured.", "tradier");
    }

    const response = await fetch(`${AUTH_BASE}/accesstoken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      throw new BrokerError(
        `Tradier token exchange failed with ${response.status}.`,
        "tradier",
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    return {
      accessToken: JSON.stringify({
        accessToken: data.access_token,
        sandbox: false,
      }),
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
      scope: data.scope,
    };
  },

  async fetchPositions(tokens: BrokerTokens): Promise<NormalizedPosition[]> {
    const creds = parseCreds(tokens);

    const profile = await tradierGet<{
      profile?: { account?: { account_number: string } | { account_number: string }[] };
    }>("/user/profile", creds);

    const raw = profile.profile?.account;
    const accounts = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (accounts.length === 0) return [];

    const out: NormalizedPosition[] = [];
    for (const account of accounts) {
      const data = await tradierGet<{
        positions?: { position?: TradierPosition | TradierPosition[] } | "null";
      }>(`/accounts/${account.account_number}/positions`, creds);

      // Tradier returns the string "null" for an empty account, and collapses
      // a single position into an object rather than a one-element array.
      if (!data.positions || data.positions === "null") continue;
      const position = data.positions.position;
      if (!position) continue;

      const list = Array.isArray(position) ? position : [position];
      out.push(...list.map(toNormalized));
    }

    return out;
  },
};

export function toNormalized(p: TradierPosition): NormalizedPosition {
  const osi = parseOsiSymbol(p.symbol);
  // Tradier reports cost basis as a total, not per unit.
  const units = Math.abs(p.quantity) || 1;

  if (osi) {
    return {
      type: "option",
      ticker: osi.ticker,
      quantity: p.quantity,
      costBasis: p.cost_basis / (units * 100),
      strike: osi.strike,
      expiry: osi.expiry,
      right: osi.right,
      contractMultiplier: 100,
      ivIsEstimate: true,
    };
  }

  return {
    type: "stock",
    ticker: p.symbol.toUpperCase(),
    quantity: p.quantity,
    costBasis: p.cost_basis / units,
  };
}
