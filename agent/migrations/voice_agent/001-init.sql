CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  ref        TEXT,
  created_at TEXT NOT NULL,
  attribute  TEXT NOT NULL DEFAULT '{}'
)