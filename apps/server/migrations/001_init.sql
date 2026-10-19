-- Phase 2a: permanent rooms only (anonymous rooms never reach the database). Trimmed from ARCHITECTURE 7.2: no users/oauth/memberships/audit yet.
-- SQLite dialect. Secrets and tokens are stored as SHA-256 hex only. Every timestamp is epoch milliseconds (INTEGER); booleans are 0/1.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  invite_hash TEXT NOT NULL,
  view_hash TEXT NOT NULL,
  admin_hash TEXT NOT NULL,
  admin_owner_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  closed_at INTEGER
);

CREATE TABLE participants (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
  owner_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  vendor TEXT,
  join_seq INTEGER NOT NULL,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  left_at INTEGER,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE messages (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  from_participant_id TEXT NOT NULL,
  from_owner_id TEXT NOT NULL,
  from_display_name TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_vendor TEXT,
  content TEXT,
  mentions TEXT NOT NULL DEFAULT '[]', -- JSON array
  reply_to TEXT,
  hops INTEGER NOT NULL DEFAULT 0,
  client_msg_id TEXT,
  deleted_at INTEGER,
  PRIMARY KEY (room_id, seq)
);
CREATE UNIQUE INDEX messages_client_msg_id ON messages (room_id, from_participant_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

CREATE TABLE participant_cursors (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id)
);

CREATE TABLE agent_tokens (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  revoked_at INTEGER,
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id)
);
