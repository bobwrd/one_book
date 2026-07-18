export interface Env {
  DB: D1Database;
  /** Sessions, OAuth state, and short-lived token cache. */
  KV: KVNamespace;

  /** 32 bytes, base64. `openssl rand -base64 32` */
  TOKEN_ENCRYPTION_KEY: string;
  /** Signs OAuth `state` values. */
  STATE_SIGNING_SECRET: string;

  /** Public origin of the deployed frontend, for CORS and redirects. */
  APP_ORIGIN: string;
  /** Public origin of this Worker, for OAuth redirect URIs. */
  API_ORIGIN: string;

  /** "alpaca" (default), "alphavantage", or "finnhub". */
  MARKET_DATA_PROVIDER?: string;

  /**
   * Alpaca market data. Separate from any user's brokerage connection: this
   * is the app's own data subscription, not someone's trading account.
   */
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  /** "iex" (free tier) or "sip" (full consolidated tape, paid). */
  ALPACA_DATA_FEED?: string;

  ALPHA_VANTAGE_API_KEY?: string;
  FINNHUB_API_KEY?: string;

  SCHWAB_CLIENT_ID?: string;
  SCHWAB_CLIENT_SECRET?: string;
  TRADIER_CLIENT_ID?: string;
  TRADIER_CLIENT_SECRET?: string;
  TRADESTATION_CLIENT_ID?: string;
  TRADESTATION_CLIENT_SECRET?: string;

  /** Set to "1" in dev to log magic links instead of emailing them. */
  DEV_LOG_MAGIC_LINKS?: string;
}

export interface SessionData {
  userId: string;
  email: string;
  createdAt: number;
}

export const SESSION_COOKIE = "onebook_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const LOGIN_TOKEN_TTL_SECONDS = 60 * 15;
