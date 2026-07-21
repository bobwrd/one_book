-- One-time migration: widen `positions` for bonds + per-position currency.
-- Run ONCE, by hand, against a database that already has the old `positions`
-- shape. Back up first. Do NOT add this to schema.sql or any automated step --
-- SQLite can't ALTER a CHECK constraint in place, so this recreates the table.
--
--   wrangler d1 execute onebook --local  --file=api/src/migrations/0001_positions_bond_currency.sql
--   wrangler d1 execute onebook --remote --file=api/src/migrations/0001_positions_bond_currency.sql

CREATE TABLE positions_v2 (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('stock', 'option', 'bond')),
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_basis REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  strike REAL,
  expiry TEXT,
  right TEXT CHECK (right IN ('call', 'put') OR right IS NULL),
  contract_multiplier REAL,
  iv REAL,
  iv_is_estimate INTEGER,
  coupon_rate REAL,
  maturity TEXT,
  face_value REAL,
  price REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  CHECK (
    type = 'stock'
    OR (type = 'option' AND strike IS NOT NULL AND expiry IS NOT NULL AND right IS NOT NULL)
    OR (type = 'bond' AND coupon_rate IS NOT NULL AND maturity IS NOT NULL
        AND face_value IS NOT NULL AND price IS NOT NULL)
  )
);

INSERT INTO positions_v2
  (id, portfolio_id, type, ticker, quantity, cost_basis, currency,
   strike, expiry, right, contract_multiplier, iv, iv_is_estimate,
   coupon_rate, maturity, face_value, price, source, created_at)
SELECT
  id, portfolio_id, type, ticker, quantity, cost_basis, 'USD',
  strike, expiry, right, contract_multiplier, iv, iv_is_estimate,
  NULL, NULL, NULL, NULL, source, created_at
FROM positions;

DROP TABLE positions;
ALTER TABLE positions_v2 RENAME TO positions;
CREATE INDEX IF NOT EXISTS idx_positions_portfolio ON positions(portfolio_id);
