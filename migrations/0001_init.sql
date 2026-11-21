-- Items on the wishlist. status: 'pending' while the link is being read, then 'ready' or 'failed'.
CREATE TABLE items (
  id                 TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'ready',
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
  updated_at         INTEGER NOT NULL,
  reserved_by        TEXT,
  reserved_at        INTEGER,
  reserve_token_hash TEXT
);
CREATE INDEX idx_items_created ON items(created_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_login_ip_ts ON login_attempts(ip, ts);
