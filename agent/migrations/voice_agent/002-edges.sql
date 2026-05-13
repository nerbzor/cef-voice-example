CREATE TABLE IF NOT EXISTS edges (
  id        TEXT PRIMARY KEY,
  src       TEXT NOT NULL,
  dst       TEXT NOT NULL,
  type      TEXT NOT NULL,
  attribute TEXT NOT NULL DEFAULT '{}'
)