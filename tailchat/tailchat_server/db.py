"""SQLite storage. The server only ever sees encrypted message bodies: what it
stores in clear is routing metadata (who is in which chat, when a message was
sent, receipts, reactions and poll vote indices)."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
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
  -- community: a community's announcements group; channel: one-way posts to followers
  type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'community', 'channel')),
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
  last_seq INTEGER NOT NULL DEFAULT 0,
  community_id TEXT,                 -- a group that belongs to a community
  device_pair TEXT                   -- "a|b": a chat between two devices of one person
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
CREATE INDEX IF NOT EXISTS files_owner ON files(owner);
CREATE INDEX IF NOT EXISTS users_avatar ON users(avatar) WHERE avatar IS NOT NULL;
CREATE INDEX IF NOT EXISTS chats_avatar ON chats(avatar) WHERE avatar IS NOT NULL;

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

-- Chat history one of your devices shared with another of yours (PROTOCOL.md
-- §9): each message's key, re-encrypted by the sharing device for the new one.
CREATE TABLE IF NOT EXISTS history_keys (
  message_id TEXT NOT NULL,
  device_id TEXT NOT NULL,           -- the device that may now read the message
  by_device TEXT NOT NULL,           -- the device that shared it
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, device_id)
);
CREATE INDEX IF NOT EXISTS history_keys_device ON history_keys(device_id);
CREATE TABLE IF NOT EXISTS history_requests (
  device_id TEXT PRIMARY KEY,        -- the device asking for history
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'declined', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  by_device TEXT,                    -- the device that answered
  shared INTEGER NOT NULL DEFAULT 0
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
"""


def _dict_row(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


class Database:
    def __init__(self, data_dir: Path):
        (data_dir / "files").mkdir(parents=True, exist_ok=True, mode=0o700)
        # Autocommit mode: transactions are opened explicitly with tx().
        self.conn = sqlite3.connect(data_dir / "tailchat.db", isolation_level=None, check_same_thread=False)
        self.conn.row_factory = _dict_row
        self.conn.executescript("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
        self._migrate()
        self.conn.executescript(SCHEMA)
        if "device_pair" not in {r["name"] for r in self.conn.execute("PRAGMA table_info(chats)").fetchall()}:
            self.conn.execute("ALTER TABLE chats ADD COLUMN device_pair TEXT")
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._depth = 0

    def _migrate(self) -> None:
        """Databases from before communities and channels: widen the chat
        types and add community_id (SQLite can't alter a CHECK in place)."""
        cols = [r["name"] for r in self.conn.execute("PRAGMA table_info(chats)").fetchall()]
        if not cols or "community_id" in cols:
            return
        create = SCHEMA[SCHEMA.index("CREATE TABLE IF NOT EXISTS chats") : SCHEMA.index(");", SCHEMA.index("CREATE TABLE IF NOT EXISTS chats")) + 2]
        self.conn.executescript(
            "BEGIN;"
            + create.replace("IF NOT EXISTS chats", "chats_new")
            + f"INSERT INTO chats_new ({', '.join(cols)}) SELECT {', '.join(cols)} FROM chats;"
            + "DROP TABLE chats; ALTER TABLE chats_new RENAME TO chats; COMMIT;"
        )

    def get(self, sql: str, *args) -> dict | None:
        return self.conn.execute(sql, args).fetchone()

    def all(self, sql: str, *args) -> list[dict]:
        return self.conn.execute(sql, args).fetchall()

    def run(self, sql: str, *args) -> sqlite3.Cursor:
        return self.conn.execute(sql, args)

    @contextmanager
    def tx(self):
        if self._depth:
            self._depth += 1
            try:
                yield
            finally:
                self._depth -= 1
            return
        self.conn.execute("BEGIN IMMEDIATE")
        self._depth = 1
        try:
            yield
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        else:
            self.conn.execute("COMMIT")
        finally:
            self._depth = 0

    def close(self) -> None:
        self.conn.close()
