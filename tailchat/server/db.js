// SQLite storage. The server only ever sees encrypted message bodies: what it
// stores in clear is routing metadata (who is in which chat, when a message was
// sent, receipts, reactions and poll vote indices).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- Tailscale login name, e.g. alice@example.com
  name TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT 'Hey there! I am using Tailchat.',
  avatar TEXT,                       -- file id of an uploaded (unencrypted) profile photo
  tailscale_avatar TEXT,             -- profile picture URL reported by Tailscale
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  hide_last_seen INTEGER NOT NULL DEFAULT 0,
  read_receipts INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,          -- ECDH P-256 public key, JWK JSON
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'broadcast')),
  name TEXT,
  description TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  direct_key TEXT UNIQUE,            -- "a|b" for a direct chat, so there is only one per pair
  disappearing INTEGER NOT NULL DEFAULT 0,   -- seconds, 0 = off
  invite_code TEXT UNIQUE,
  admins_only_send INTEGER NOT NULL DEFAULT 0,
  admins_only_edit INTEGER NOT NULL DEFAULT 0,
  pinned_message TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS members (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  joined_seq INTEGER NOT NULL DEFAULT 0,     -- messages up to here predate this member
  left_at INTEGER,
  left_seq INTEGER,                          -- last message a former member may still read
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0,
  cleared_seq INTEGER NOT NULL DEFAULT 0,    -- "clear chat" hides everything up to here
  pinned_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  marked_unread INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,        -- "delete chat": hidden until the next message
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  seq INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  sender_device TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('msg', 'system')),
  payload TEXT,                      -- encrypted envelope (msg) or event JSON (system)
  files TEXT NOT NULL DEFAULT '[]',
  view_once INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  expires_at INTEGER,
  UNIQUE (chat_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS hidden (user_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (user_id, message_id));
CREATE TABLE IF NOT EXISTS stars (user_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, message_id));
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL, options TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS view_once_opened (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  size INTEGER NOT NULL,
  public INTEGER NOT NULL DEFAULT 0, -- profile and group photos, readable by anyone on the tailnet
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_links (
  file_id TEXT NOT NULL,
  message_id TEXT,
  status_id TEXT
);
CREATE INDEX IF NOT EXISTS file_links_file ON file_links(file_id);

CREATE TABLE IF NOT EXISTS statuses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS status_views (
  status_id TEXT NOT NULL, viewer_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (status_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS blocks (user_id TEXT NOT NULL, blocked_id TEXT NOT NULL, PRIMARY KEY (user_id, blocked_id));

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  video INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER,
  participants TEXT NOT NULL DEFAULT '[]'
);
`;

export function openDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'tailchat.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map();
  // Prepared statements are cached by SQL text, so call sites can stay inline.
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  return {
    raw: db,
    get: (sql, ...args) => stmt(sql).get(...args),
    all: (sql, ...args) => stmt(sql).all(...args),
    run: (sql, ...args) => stmt(sql).run(...args),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}
