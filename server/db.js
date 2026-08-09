"use strict";
/* ============================================================
   Database — SQLite via better-sqlite3 (synchronous, no pool).

   Design notes
   ------------
   Records are stored as JSON blobs rather than wide columns. Coaches in
   different disciplines need different fields on a client (level, event,
   parent contact, injury history), so a rigid schema would either be
   constantly migrated or full of nulls. The tradeoff is that we can't
   query inside a record from SQL — acceptable, because every read here is
   "give me this coach's records since cursor N", never a content search.

   Sync ordering uses a per-user monotonic counter, NOT timestamps.
   Phones have wrong clocks. A device whose clock is five minutes fast
   would poison a timestamp cursor and silently skip records forever.
   ============================================================ */

const path = require("path");
const fs = require("fs");
const sqlite = require("./sqlite");

const file = process.env.DATABASE_FILE || "./data/coachdesk.db";
const abs = path.isAbsolute(file) ? file : path.join(__dirname, "..", file);
fs.mkdirSync(path.dirname(abs), { recursive: true });

const db = sqlite.open(abs);
db.pragma("journal_mode = WAL");   // concurrent reads while writing
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Password reset tokens.
-- Only the SHA-256 of the token is stored: whoever reads this table
-- cannot mint a working reset link from it. Single use, short lived.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

-- Pending email changes. The new address has to prove it's reachable
-- before it becomes the account's login and recovery route — otherwise a
-- typo would lock the coach out permanently.
CREATE TABLE IF NOT EXISTS email_changes (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_emailchg_user ON email_changes(user_id);

-- One row per client/event. 'kind' discriminates.
CREATE TABLE IF NOT EXISTS records (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,              -- 'client' | 'event'
  id         TEXT NOT NULL,              -- client-generated id
  data       TEXT NOT NULL,              -- JSON
  updated_at TEXT NOT NULL,              -- logical time from the device (conflict resolution)
  deleted    INTEGER NOT NULL DEFAULT 0, -- soft delete, so deletions propagate
  server_seq INTEGER NOT NULL,           -- monotonic per user (sync cursor)
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(user_id, server_seq);

-- Profile is a singleton per user, so it gets its own table.
CREATE TABLE IF NOT EXISTS profiles (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  server_seq INTEGER NOT NULL
);

-- Google OAuth tokens + incremental sync token, one row per user.
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,
  refresh_token TEXT NOT NULL,
  calendar_id   TEXT NOT NULL DEFAULT 'primary',
  sync_token    TEXT,
  last_sync_at  TEXT,
  connected_at  TEXT NOT NULL
);
`);

/* --- migrations ------------------------------------------------------
   Additive only. Each guarded so re-running is harmless.               */
function addColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
addColumn("google_accounts", "sync_token", "TEXT");
addColumn("google_accounts", "last_sync_at", "TEXT");
// CoachDesk is for coaches, who must be adults. The attestation is recorded
// with a timestamp rather than merely enforced in the UI, so there is
// evidence of what was agreed and when.
addColumn("users", "age_attested", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "age_attested_at", "TEXT");

/* --- sequence -------------------------------------------------------- */
const bumpSeq = db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?");
const readSeq = db.prepare("SELECT seq FROM users WHERE id = ?");

/** Allocate the next sync sequence number for a user. Call inside a txn. */
function nextSeq(userId) {
  bumpSeq.run(userId);
  const row = readSeq.get(userId);
  if (!row) throw new Error("Unknown user " + userId);
  return row.seq;
}

function currentSeq(userId) {
  const row = readSeq.get(userId);
  return row ? row.seq : 0;
}

module.exports = { db, nextSeq, currentSeq, driver: sqlite.driver };
