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
  type TEXT NOT NULL CHECK (type IN ('stock', 'option')),
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_basis REAL NOT NULL DEFAULT 0,
  -- Option-only columns, NULL for stock rows.
  strike REAL,
  expiry TEXT,
  right TEXT CHECK (right IN ('call', 'put') OR right IS NULL),
  contract_multiplier REAL,
  iv REAL,
  iv_is_estimate INTEGER,
  -- Set when the row came from a broker sync rather than manual entry.
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  -- An option row is only meaningful with its full contract definition.
  CHECK (
    type = 'stock'
    OR (strike IS NOT NULL AND expiry IS NOT NULL AND right IS NOT NULL)
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
