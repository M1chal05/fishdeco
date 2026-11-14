PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL DEFAULT 'discord-only',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discord_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_collectors_collection ON collectors(collection_id);
CREATE INDEX IF NOT EXISTS idx_collectors_user ON collectors(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collectors_user_collection
  ON collectors(user_id, collection_id) WHERE user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS owned_items (
  collector_id TEXT NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  PRIMARY KEY (collector_id, item_id)
);
CREATE TABLE IF NOT EXISTS primary_assignments (
  collection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_primary_user ON primary_assignments(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_expiry ON auth_attempts(expires_at);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_meta(key, value) VALUES ('revision', 0);
