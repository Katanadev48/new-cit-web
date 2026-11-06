BEGIN IMMEDIATE;

DROP INDEX IF EXISTS idx_orders_user_created;

CREATE INDEX IF NOT EXISTS idx_orders_user_created_id
  ON orders(user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_created_id
  ON orders(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status_created_id
  ON orders(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_users_created_id
  ON users(created_at DESC, id DESC);

PRAGMA user_version = 2;

COMMIT;