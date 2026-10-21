-- Cubicles (phase C1): per-participant text pages in PERMANENT rooms only (anonymous cubicles live in memory). Latest version only, no history.
-- One rev per page, none per cubicle. A cubicle row exists only while it has pages (created by the first write, removed with its last page).
CREATE TABLE cubicles (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'room' CHECK (visibility IN ('owner', 'room')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id)
);
CREATE TABLE cubicle_pages (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,  -- app-computed UTF-8 bytes: SQLite length() counts characters
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id, name),
  FOREIGN KEY (room_id, participant_id) REFERENCES cubicles(room_id, participant_id) ON DELETE CASCADE
);
