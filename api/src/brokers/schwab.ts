/**
 * Charles Schwab adapter (the former TD Ameritrade API).
 *
 * Standard OAuth 2.0, but the developer application needs Schwab's approval
 * before the credentials work, so this ships behind configuration rather than
 * being wired on by default.
 */

import {
  BrokerAuthExpiredError,
  BrokerError,
  type BrokerAdapter,
  type BrokerEnv,
  type BrokerTokens,
  type NormalizedPosition,
} from "./types.js";
import type { OptionRight } from "@onebook/finance";

const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const TRADER_BASE = "https://api.schwabapi.com/trader/v1";

interface SchwabInstrument {
  symbol: string;
  assetType: string;
  underlyingSymbol?: string;
  putCall?: "PUT" | "CALL";
  strikePrice?: number;
  expirationDate?: string;
}

interface SchwabPosition {
  instrument: SchwabInstrument;
  longQuantity: number;
  shortQuantity: number;
  averagePrice: number;
}

function basicAuth(env: BrokerEnv): string {
  return btoa(`${env.clientId}:${env.clientSecret}`);
}

export const schwabAdapter: BrokerAdapter = {
  id: "schwab",
  displayName: "Charles Schwab",
  authModel: "oauth2",
  notes:
    "Requires an approved Schwab developer application. Register the OneBook callback URL as the redirect URI before connecting.",

  authUrl(state: string, redirectUri: string, env: BrokerEnv): string {
    if (!env.clientId) {
      throw new BrokerError("Schwab client ID is not configured.", "schwab");
    }
    const params = new URLSearchParams({
      client_id: env.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "readonly",
      state,
    });
    return `${AUTH_URL}?${params}`;
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
    env: BrokerEnv,
  ): Promise<BrokerTokens> {
    if (!env.clientId || !env.clientSecret) {
      throw new BrokerError("Schwab OAuth is not configured.", "schwab");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth(env)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      throw new BrokerError(
        `Schwab token exchange failed with ${response.status}.`,
        "schwab",
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };
  },

  async refresh(tokens: BrokerTokens, env: BrokerEnv): Promise<BrokerTokens> {
    if (!tokens.refreshToken) throw new BrokerAuthExpiredError("schwab");
    if (!env.clientId || !env.clientSecret) {
      throw new BrokerError("Schwab OAuth is not configured.", "schwab");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth(env)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
    });

    if (!response.ok) throw new BrokerAuthExpiredError("schwab");

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      // Schwab may or may not rotate the refresh token; keep the old one if not.
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: tokens.scope,
      accountLabel: tokens.accountLabel,
    };
  },

  async fetchPositions(tokens: BrokerTokens): Promise<NormalizedPosition[]> {
    const response = await fetch(
      `${TRADER_BASE}/accounts?fields=positions`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
    );

    if (response.status === 401) throw new BrokerAuthExpiredError("schwab");
    if (!response.ok) {
      throw new BrokerError(
        `Schwab returned ${response.status} while fetching positions.`,
        "schwab",
        response.status >= 500,
      );
    }

    const accounts = (await response.json()) as {
      securitiesAccount?: { positions?: SchwabPosition[] };
    }[];

    const out: NormalizedPosition[] = [];
    for (const account of accounts) {
      for (const p of account.securitiesAccount?.positions ?? []) {
        const normalized = toNormalized(p);
        if (normalized) out.push(normalized);
      }
    }
    return out;
  },
};

export function toNormalized(p: SchwabPosition): NormalizedPosition | null {
  // Schwab splits direction across two fields rather than signing quantity.
  const quantity = (p.longQuantity ?? 0) - (p.shortQuantity ?? 0);
  if (quantity === 0) return null;

  const { instrument } = p;

  if (instrument.assetType === "OPTION") {
    if (
      !instrument.putCall ||
      instrument.strikePrice === undefined ||
      !instrument.expirationDate
    ) {
      return null;
    }
    const right: OptionRight =
      instrument.putCall === "CALL" ? "call" : "put";
    return {
      type: "option",
      ticker: (instrument.underlyingSymbol ?? instrument.symbol).toUpperCase(),
      quantity,
      costBasis: p.averagePrice,
      strike: instrument.strikePrice,
      // Schwab returns a full timestamp; the risk engine wants a plain date.
      expiry: instrument.expirationDate.slice(0, 10),
      right,
      contractMultiplier: 100,
      ivIsEstimate: true,
    };
  }

  return {
    type: "stock",
    ticker: instrument.symbol.toUpperCase(),
    quantity,
    costBasis: p.averagePrice,
  };
}
