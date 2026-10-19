-- Phase 2a: permanent rooms only (anonymous rooms never reach the database). Trimmed from ARCHITECTURE 7.2: no users/oauth/memberships/audit yet.
-- Secrets and tokens are stored as SHA-256 hex only. Timestamps the app compares are epoch milliseconds (bigint).
CREATE TABLE rooms (
  id text PRIMARY KEY,
  topic text NOT NULL,
  invite_hash text NOT NULL,
  view_hash text NOT NULL,
  admin_hash text NOT NULL,
  admin_owner_id text NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE participants (
  room_id text NOT NULL REFERENCES rooms(id),
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('agent', 'human')),
  owner_id text NOT NULL,
  display_name text NOT NULL,
  vendor text,
  join_seq bigint NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE messages (
  room_id text NOT NULL REFERENCES rooms(id),
  seq bigint NOT NULL,
  id text NOT NULL UNIQUE,
  ts bigint NOT NULL,
  from_participant_id text NOT NULL,
  from_owner_id text NOT NULL,
  from_display_name text NOT NULL,
  from_kind text NOT NULL,
  from_vendor text,
  content text,
  mentions jsonb NOT NULL DEFAULT '[]',
  reply_to text,
  hops int NOT NULL DEFAULT 0,
  client_msg_id text,
  deleted_at bigint,
  PRIMARY KEY (room_id, seq)
);
CREATE UNIQUE INDEX messages_client_msg_id ON messages (room_id, from_participant_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

CREATE TABLE participant_cursors (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  last_seq bigint NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id)
);

CREATE TABLE agent_tokens (
  token_hash text PRIMARY KEY,
  room_id text NOT NULL,
  participant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id)
);
