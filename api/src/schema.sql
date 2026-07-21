-- OneBook D1 schema.
-- Applied with: wrangler d1 migrations apply onebook

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Magic-link tokens. Single-use, short-lived, and stored hashed so a database
-- read cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_expires ON login_tokens(expires_at);

CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('stock', 'option', 'bond')),
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_basis REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  -- Option-only columns, NULL for stock/bond rows.
  strike REAL,
  expiry TEXT,
  right TEXT CHECK (right IN ('call', 'put') OR right IS NULL),
  contract_multiplier REAL,
  iv REAL,
  iv_is_estimate INTEGER,
  -- Bond-only columns, NULL for stock/option rows.
  coupon_rate REAL,
  maturity TEXT,
  face_value REAL,
  price REAL,
  -- Set when the row came from a broker sync rather than manual entry.
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  -- An option row is only meaningful with its full contract definition, and a
  -- bond row with its coupon, maturity, face amount, and mark.
  CHECK (
    type = 'stock'
    OR (type = 'option' AND strike IS NOT NULL AND expiry IS NOT NULL AND right IS NOT NULL)
    OR (type = 'bond' AND coupon_rate IS NOT NULL AND maturity IS NOT NULL
        AND face_value IS NOT NULL AND price IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_positions_portfolio ON positions(portfolio_id);

CREATE TABLE IF NOT EXISTS broker_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  -- AES-GCM ciphertext, base64. The key lives in a Worker secret, never here.
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  scope TEXT,
  account_label TEXT,
  created_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  UNIQUE (user_id, broker)
);

CREATE INDEX IF NOT EXISTS idx_broker_connections_user ON broker_connections(user_id);

-- Historical closes, cached aggressively to stay inside free market-data tiers.
CREATE TABLE IF NOT EXISTS price_cache (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_price_cache_ticker ON price_cache(ticker);

-- Latest quote per ticker, with its own short TTL.
CREATE TABLE IF NOT EXISTS quote_cache (
  ticker TEXT PRIMARY KEY,
  price REAL NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- FX reference rates, quote currency per 1 USD. Cache-first, same pattern as
-- price_cache/quote_cache.
CREATE TABLE IF NOT EXISTS fx_rate_cache (
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  rate REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (base, quote)
);

-- User-defined groupings of positions, scoped per book. A position belongs to
-- at most one group, enforced by position_id being the primary key.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'olive',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_portfolio ON groups(portfolio_id);

CREATE TABLE IF NOT EXISTS position_groups (
  position_id TEXT PRIMARY KEY REFERENCES positions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_groups_group ON position_groups(group_id);

-- Cached headlines per ticker.
CREATE TABLE IF NOT EXISTS news_cache (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_cache_ticker ON news_cache(ticker, published_at);

-- Trade ledger. Deliberately redundant with `positions` (own copies of
-- strike/expiry/right) so a transaction stays meaningful after the position it
-- built is edited, deleted, or replaced by a broker sync.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  position_type TEXT NOT NULL CHECK (position_type IN ('stock', 'option', 'bond')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  fee REAL NOT NULL DEFAULT 0,
  strike REAL,
  expiry TEXT,
  right TEXT CHECK (right IN ('call', 'put') OR right IS NULL),
  source TEXT NOT NULL DEFAULT 'manual',
  executed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_ticker ON transactions(portfolio_id, ticker);

-- Presence of a row = that connection's last sync failed. Sync success deletes
-- any existing row for the connection.
CREATE TABLE IF NOT EXISTS broker_connection_errors (
  connection_id TEXT PRIMARY KEY REFERENCES broker_connections(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);

-- Per-user settings. Kept off `users` (which stays id/email/created_at only)
-- so this needs no ALTER TABLE.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  currency TEXT NOT NULL DEFAULT 'USD',
  compact_numbers INTEGER NOT NULL DEFAULT 0,
  show_unrealized_pnl INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Enumerable index of sessions, so Settings can list/revoke them. KV stays the
-- source of truth for the session payload and TTL; this table just makes
-- "which sessions belong to this user" queryable.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
