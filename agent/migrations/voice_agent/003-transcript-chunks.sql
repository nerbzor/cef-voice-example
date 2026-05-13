CREATE TABLE IF NOT EXISTS transcript_chunks (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  segment_index  INTEGER NOT NULL,
  text           TEXT NOT NULL,
  start_ms       INTEGER NOT NULL DEFAULT 0,
  end_ms         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tc_conv ON transcript_chunks(conversation_id, start_ms);
