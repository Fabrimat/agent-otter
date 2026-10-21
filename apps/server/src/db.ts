// Persistence for PERMANENT rooms only: plain SQL on one SQLite file (node:sqlite, synchronous). MemoryStore stays the live engine; anonymous rooms never call this file.
// Single process per file: two processes on one file are unsupported (no cross-process migrator lock or fan-out; busy_timeout only rides out the backup tool).
// Methods stay async so callers are unchanged and a later move to Postgres (multi-instance, accounts) swaps this file only: keep the SQL portable.
// Deferred (phase 2b+): retention job, JSON export, author self-delete, audit log. Not used: LISTEN/NOTIFY, advisory locks.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { StoredMessage, Vendor } from '@lesscubicles/protocol';

const MIGRATIONS = new URL('../migrations/', import.meta.url); // src/ under tsx, dist/ in the image: both sit next to migrations/

export type RoomRow = { id: string; topic: string; invite_hash: string; view_hash: string; admin_hash: string; admin_owner_id: string; last_seq: number; paused: boolean; closed: boolean };
export type ParticipantRow = { room_id: string; id: string; kind: 'agent' | 'human'; owner_id: string; display_name: string; vendor: Vendor | null; join_seq: number; left: boolean; cursor: number | null };
export type NewParticipant = { id: string; kind: 'agent' | 'human'; ownerId: string; displayName: string; vendor?: Vendor };
export type CubicleStats = { pages: number; hasPage: boolean; oldBytes: number; cubicleBytes: number; roomBytes: number }; // seen by a write's cap check
export type Db = ReturnType<typeof openDb>;

type Row = Record<string, any>;
const NOW = "(unixepoch('subsec') * 1000)"; // epoch ms, like every timestamp the app compares
const toMsg = (r: Row): StoredMessage => ({
  roomId: r.room_id, seq: r.seq, id: r.id, ts: r.ts,
  from: { kind: r.from_kind, participantId: r.from_participant_id, ownerId: r.from_owner_id, displayName: r.from_display_name, ...(r.from_vendor && { vendor: r.from_vendor }) },
  content: r.content, mentions: JSON.parse(r.mentions), ...(r.reply_to && { replyTo: r.reply_to }), hops: r.hops, ...(r.deleted_at !== null && { deletedAt: r.deleted_at }),
});

export function openDb(path: string) {
  if (path !== ':memory:') process.umask(0o077); // db, -wal and -shm are created 0600
  const h = new DatabaseSync(path);
  if (path !== ':memory:' && h.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode !== 'wal') throw new Error('sqlite: WAL unavailable'); // fail closed: durability and reader/writer behaviour assume WAL
  h.exec('PRAGMA synchronous = FULL'); // permanent rooms are the durable promise: fsync every commit (NORMAL could lose the last commits on power loss); the volume is tiny
  h.exec('PRAGMA foreign_keys = ON');
  h.exec('PRAGMA secure_delete = ON'); // deleted cubicle/message bytes are overwritten in free pages (the -wal file keeps old images until a checkpoint)
  h.exec('PRAGMA busy_timeout = 2000');
  const q = (sql: string, params: SQLInputValue[] = []) => h.prepare(sql).all(...params).map((r) => ({ ...r })) as Row[];
  const run = (sql: string, params: SQLInputValue[] = []) => h.prepare(sql).run(...params);
  /** One write transaction. BEGIN IMMEDIATE takes the write lock up front, so nothing upgrades mid-way and fails with SQLITE_BUSY. */
  function tx<T>(fn: () => T): T {
    h.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      h.exec('COMMIT');
      return out;
    } catch (e) {
      try { h.exec('ROLLBACK'); } catch { /* the failure that matters is e */ }
      throw e;
    }
  }

  return {
    handle: h,
    end: async () => { if (h.isOpen) h.close(); },
    ping: async () => void q('SELECT 1'),

    /** Applies pending migrations/*.sql in name order, each in its own transaction; the applied check runs inside it, so a second handle on the same file waits, then sees it applied. */
    async migrate() {
      h.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT ${NOW})`);
      for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
        tx(() => {
          if (q('SELECT 1 FROM schema_migrations WHERE version = ?', [f]).length) return;
          h.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
          run('INSERT INTO schema_migrations (version) VALUES (?)', [f]);
        });
      }
    },

    /** Everything needed to rebuild the in-memory rooms. Messages: the newest `perRoom` of each OPEN room, ascending. */
    async loadAll(perRoom: number) {
      const rooms = q('SELECT id, topic, invite_hash, view_hash, admin_hash, admin_owner_id, last_seq, paused, closed_at IS NOT NULL AS closed FROM rooms')
        .map((r) => ({ ...r, paused: !!r.paused, closed: !!r.closed })) as RoomRow[];
      const participants = q(`SELECT p.room_id, p.id, p.kind, p.owner_id, p.display_name, p.vendor, p.join_seq, p.left_at IS NOT NULL AS left, c.last_seq AS cursor
        FROM participants p LEFT JOIN participant_cursors c ON c.room_id = p.room_id AND c.participant_id = p.id ORDER BY p.joined_at, p.rowid`)
        .map((r) => ({ ...r, left: !!r.left })) as ParticipantRow[];
      const tokens = q(`SELECT t.token_hash, t.room_id, t.participant_id FROM agent_tokens t JOIN rooms r ON r.id = t.room_id
        WHERE t.revoked_at IS NULL AND r.closed_at IS NULL`);
      const messages = q(`SELECT * FROM (SELECT m.*, row_number() OVER (PARTITION BY m.room_id ORDER BY m.seq DESC) AS rn
        FROM messages m JOIN rooms r ON r.id = m.room_id AND r.closed_at IS NULL) x WHERE rn <= ? ORDER BY room_id, seq`, [perRoom]).map(toMsg);
      return { rooms, participants, tokens: tokens as { token_hash: string; room_id: string; participant_id: string }[], messages };
    },

    insertRoom: async (r: { id: string; topic: string; hashes: Record<'invite' | 'view' | 'admin', string>; adminOwnerId: string }) =>
      void run('INSERT INTO rooms (id, topic, invite_hash, view_hash, admin_hash, admin_owner_id) VALUES (?, ?, ?, ?, ?, ?)',
        [r.id, r.topic, r.hashes.invite, r.hashes.view, r.hashes.admin, r.adminOwnerId]),

    /** Participant (+ token) in one transaction. join_seq is the room's committed last_seq, read in the same statement, so the join point is exact. */
    insertParticipant: async (roomId: string, p: NewParticipant, tokenHash?: string) => tx(() => {
      const r = h.prepare(`INSERT INTO participants (room_id, id, kind, owner_id, display_name, vendor, join_seq)
        SELECT ?, ?, ?, ?, ?, ?, last_seq FROM rooms WHERE id = ? RETURNING join_seq`).get(roomId, p.id, p.kind, p.ownerId, p.displayName, p.vendor ?? null, roomId);
      if (tokenHash) run('INSERT INTO agent_tokens (token_hash, room_id, participant_id) VALUES (?, ?, ?)', [tokenHash, roomId, p.id]);
      return r!.join_seq as number;
    }),

    /** Retry by client_msg_id: the existing row, looked up BEFORE a seq is claimed (a retry never burns a seq). Else claims last_seq+1 and inserts, one transaction. */
    appendMessage: async (m: Omit<StoredMessage, 'seq'>, clientMsgId?: string) => tx((): { seq: number; id: string; duplicate: boolean } => {
      if (clientMsgId) {
        const d = q('SELECT seq, id FROM messages WHERE room_id = ? AND from_participant_id = ? AND client_msg_id = ?', [m.roomId, m.from.participantId, clientMsgId])[0];
        if (d) return { seq: d.seq, id: d.id, duplicate: true };
      }
      const seq = h.prepare('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(m.roomId)!.last_seq as number;
      run(`INSERT INTO messages (room_id, seq, id, ts, from_participant_id, from_owner_id, from_display_name, from_kind, from_vendor, content, mentions, reply_to, hops, client_msg_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.roomId, seq, m.id, m.ts, m.from.participantId, m.from.ownerId, m.from.displayName, m.from.kind, m.from.vendor ?? null, m.content, JSON.stringify(m.mentions), m.replyTo ?? null, m.hops, clientMsgId ?? null]);
      return { seq, id: m.id, duplicate: false };
    }),

    /** Never moves a cursor backwards, so out-of-order best-effort writes are harmless. */
    setCursor: async (roomId: string, participantId: string, seq: number) =>
      void run(`INSERT INTO participant_cursors (room_id, participant_id, last_seq) VALUES (?, ?, ?)
        ON CONFLICT (room_id, participant_id) DO UPDATE SET last_seq = MAX(participant_cursors.last_seq, excluded.last_seq)`, [roomId, participantId, seq]),

    markLeft: async (roomId: string, participantId: string) => tx(() => {
      run(`UPDATE participants SET left_at = ${NOW} WHERE room_id = ? AND id = ?`, [roomId, participantId]);
      run(`UPDATE agent_tokens SET revoked_at = ${NOW} WHERE room_id = ? AND participant_id = ? AND revoked_at IS NULL`, [roomId, participantId]);
    }),

    setPaused: async (roomId: string, paused: boolean) => void run('UPDATE rooms SET paused = ? WHERE id = ?', [paused ? 1 : 0, roomId]),

    closeRoom: async (roomId: string) => tx(() => {
      run(`UPDATE rooms SET closed_at = ${NOW} WHERE id = ?`, [roomId]);
      run(`UPDATE agent_tokens SET revoked_at = ${NOW} WHERE room_id = ? AND revoked_at IS NULL`, [roomId]);
    }),

    rotateSecrets: async (roomId: string, s: Record<'invite' | 'view' | 'admin', string>) =>
      void run('UPDATE rooms SET invite_hash = ?, view_hash = ?, admin_hash = ? WHERE id = ?', [s.invite, s.view, s.admin, roomId]),

    /** Admin erase: content gone, row and seq kept. Returns false when no such message. */
    tombstone: async (roomId: string, seq: number, at: number) =>
      Number(run('UPDATE messages SET content = NULL, deleted_at = COALESCE(deleted_at, ?) WHERE room_id = ? AND seq = ?', [at, roomId, seq]).changes) > 0,

    /** `seq > lo AND seq < hi`, ascending when `forward`, else newest first; at most `limit` rows. `lastSeq` is the room's last_seq read with no await in
     *  between (one process, synchronous driver: one snapshot), so a caller can tell exactly which later messages it still needs. */
    async listMessages(roomId: string, o: { lo: number; hi: number | null; limit: number; forward: boolean }) {
      const lastSeq = (q('SELECT last_seq FROM rooms WHERE id = ?', [roomId])[0]?.last_seq ?? 0) as number;
      const rows = q(`SELECT * FROM messages WHERE room_id = ? AND seq > ? AND (? IS NULL OR seq < ?) ORDER BY seq ${o.forward ? 'ASC' : 'DESC'} LIMIT ?`,
        [roomId, o.lo, o.hi, o.hi, o.limit]);
      return { lastSeq, messages: rows.map(toMsg) };
    },

    /** Every cubicle of the room with its page metadata (no content). */
    async listCubicles(roomId: string) {
      const out = new Map<string, { participantId: string; visibility: 'owner' | 'room'; updatedAt: number; pages: { name: string; bytes: number; rev: number; updatedAt: number }[] }>();
      for (const c of q('SELECT participant_id, visibility, updated_at FROM cubicles WHERE room_id = ? ORDER BY updated_at, participant_id', [roomId])) {
        out.set(c.participant_id, { participantId: c.participant_id, visibility: c.visibility, updatedAt: c.updated_at, pages: [] });
      }
      for (const p of q('SELECT participant_id, name, bytes, rev, updated_at FROM cubicle_pages WHERE room_id = ? ORDER BY name', [roomId])) {
        out.get(p.participant_id)?.pages.push({ name: p.name, bytes: p.bytes, rev: p.rev, updatedAt: p.updated_at });
      }
      return [...out.values()];
    },

    /** One cubicle with page content (all pages, or just `page`); undefined when it has no row. */
    async readCubicle(roomId: string, participantId: string, page?: string) {
      const c = q('SELECT visibility FROM cubicles WHERE room_id = ? AND participant_id = ?', [roomId, participantId])[0];
      if (!c) return undefined;
      const pages = q('SELECT name, content, bytes, rev, updated_at FROM cubicle_pages WHERE room_id = ? AND participant_id = ? AND (? IS NULL OR name = ?) ORDER BY name',
        [roomId, participantId, page ?? null, page ?? null]).map((p) => ({ name: p.name as string, content: p.content as string, bytes: p.bytes as number, rev: p.rev as number, updatedAt: p.updated_at as number }));
      return { visibility: c.visibility as 'owner' | 'room', pages };
    },

    /** Upserts one page in one transaction. `check` sees the counts BEFORE the write and throws to refuse (the transaction rolls back), so the per-room
     *  SUM(bytes) cap cannot race another write. Returns the new rev. */
    writePage: async (roomId: string, participantId: string, w: { page: string; content: string; bytes: number; visibility?: 'owner' | 'room'; at: number }, check: (s: CubicleStats) => void) => tx(() => {
      const old = q('SELECT bytes FROM cubicle_pages WHERE room_id = ? AND participant_id = ? AND name = ?', [roomId, participantId, w.page])[0];
      const own = q('SELECT count(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM cubicle_pages WHERE room_id = ? AND participant_id = ?', [roomId, participantId])[0]!;
      const room = q('SELECT COALESCE(SUM(bytes), 0) AS b FROM cubicle_pages WHERE room_id = ?', [roomId])[0]!;
      check({ pages: own.n, hasPage: !!old, oldBytes: old?.bytes ?? 0, cubicleBytes: own.b, roomBytes: room.b });
      run(`INSERT INTO cubicles (room_id, participant_id, visibility, updated_at) VALUES (?, ?, COALESCE(?, 'room'), ?)
        ON CONFLICT (room_id, participant_id) DO UPDATE SET updated_at = excluded.updated_at, visibility = COALESCE(?, visibility)`, [roomId, participantId, w.visibility ?? null, w.at, w.visibility ?? null]);
      return h.prepare(`INSERT INTO cubicle_pages (room_id, participant_id, name, content, bytes, rev, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT (room_id, participant_id, name) DO UPDATE SET content = excluded.content, bytes = excluded.bytes, rev = cubicle_pages.rev + 1, updated_at = excluded.updated_at
        RETURNING rev`).get(roomId, participantId, w.page, w.content, w.bytes, w.at)!.rev as number;
    }),

    /** Real DELETE of one page (and of the cubicle with its last page). False when there was no such page. */
    deletePage: async (roomId: string, participantId: string, page: string) => tx(() => {
      const gone = Number(run('DELETE FROM cubicle_pages WHERE room_id = ? AND participant_id = ? AND name = ?', [roomId, participantId, page]).changes) > 0;
      run('DELETE FROM cubicles WHERE room_id = ? AND participant_id = ? AND NOT EXISTS (SELECT 1 FROM cubicle_pages WHERE room_id = ? AND participant_id = ?)', [roomId, participantId, roomId, participantId]);
      return gone;
    }),

    /** Real DELETE of whole cubicles (pages go with them by ON DELETE CASCADE). Returns how many cubicles existed. */
    eraseCubicles: async (roomId: string, participantIds: string[]) => tx(() =>
      participantIds.reduce((n, id) => n + Number(run('DELETE FROM cubicles WHERE room_id = ? AND participant_id = ?', [roomId, id]).changes), 0)),
  };
}
