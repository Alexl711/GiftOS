CREATE TABLE IF NOT EXISTS items (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  url                TEXT,
  source             TEXT,
  category           TEXT NOT NULL DEFAULT 'Other',
  image              TEXT,
  price              REAL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  notes              TEXT,
  starred            INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  reserved_by        TEXT,
  reserved_at        INTEGER,
  reserve_token_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_ip_ts ON login_attempts(ip, ts);
