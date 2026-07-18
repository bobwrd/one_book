/**
 * The one interface every broker hides behind.
 *
 * Section 4.1 of the brief is the reason this exists: brokers disagree on auth
 * model, position shape, and option symbology, and several have no retail API
 * at all. The frontend and risk engine must never special-case a broker, so
 * everything normalizes to `NormalizedPosition` here.
 */

import type { OptionRight } from "@onebook/finance";

export type BrokerId =
  | "alpaca"
  | "tradier"
  | "schwab"
  | "etrade"
  | "tradestation"
  | "ibkr"
  | "tastytrade";

export type AuthModel = "oauth2" | "oauth1" | "api-key" | "local-gateway";

export interface NormalizedPosition {
  type: "stock" | "option";
  ticker: string;
  /** Signed; negative is short. */
  quantity: number;
  costBasis: number;
  /** Option-only. */
  strike?: number;
  expiry?: string;
  right?: OptionRight;
  contractMultiplier?: number;
  /** Present only when the broker supplies a live IV or option quote. */
  iv?: number;
  ivIsEstimate?: boolean;
}

export interface BrokerTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch millis. */
  expiresAt?: number;
  scope?: string;
  accountLabel?: string;
}

export interface BrokerCredentials {
  [key: string]: string;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    public readonly broker: BrokerId,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

/** Thrown when tokens are present but no longer valid. */
export class BrokerAuthExpiredError extends BrokerError {
  constructor(broker: BrokerId) {
    super(`${broker} connection has expired; reconnect required.`, broker);
    this.name = "BrokerAuthExpiredError";
  }
}

export interface BrokerAdapter {
  readonly id: BrokerId;
  readonly displayName: string;
  readonly authModel: AuthModel;
  /** Human-readable notes surfaced in the connect UI. */
  readonly notes?: string;
  /** Fields the user must supply for `api-key` brokers. */
  readonly credentialFields?: { key: string; label: string; secret: boolean }[];

  /** OAuth brokers: build the authorization URL for a signed `state`. */
  authUrl?(state: string, redirectUri: string, env: BrokerEnv): string;

  /** OAuth brokers: exchange the callback code for tokens. */
  exchangeCode?(
    code: string,
    redirectUri: string,
    env: BrokerEnv,
  ): Promise<BrokerTokens>;

  /** API-key brokers: validate credentials and return them as tokens. */
  connectWithKeys?(
    credentials: BrokerCredentials,
    env: BrokerEnv,
  ): Promise<BrokerTokens>;

  /** Refresh where the broker supports it. */
  refresh?(tokens: BrokerTokens, env: BrokerEnv): Promise<BrokerTokens>;

  fetchPositions(tokens: BrokerTokens): Promise<NormalizedPosition[]>;
}

export interface BrokerEnv {
  clientId?: string;
  clientSecret?: string;
}

/**
 * Brokers with no official retail API. Listed explicitly so the UI can route
 * users to CSV import with an honest explanation rather than a dead end.
 *
 * Deliberately no unofficial/scraping adapters: they violate broker terms of
 * service and put the user's actual brokerage account at risk.
 */
export const CSV_ONLY_BROKERS = [
  { id: "robinhood", displayName: "Robinhood" },
  { id: "webull", displayName: "Webull" },
  { id: "fidelity", displayName: "Fidelity" },
  { id: "vanguard", displayName: "Vanguard" },
] as const;
