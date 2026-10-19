// Persistence for PERMANENT rooms only: plain SQL over one small pool. MemoryStore stays the live engine; anonymous rooms never call this file.
// Deferred (phase 2b+): LISTEN/NOTIFY fan-out, retention job, JSON export, author self-delete, audit log.
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import type { StoredMessage, Vendor } from '@agent-office/protocol';

pg.types.setTypeParser(20, Number); // bigint (seq, ts): safe below 2^53, and a string seq would break every comparison

const MIGRATIONS = new URL('../migrations/', import.meta.url); // src/ under tsx, dist/ in the image: both sit next to migrations/
const LOCK = 7_240_001; // pg_advisory_lock key: one migrator at a time across concurrently booting instances

export type RoomRow = { id: string; topic: string; invite_hash: string; view_hash: string; admin_hash: string; admin_owner_id: string; last_seq: number; paused: boolean; closed: boolean };
export type ParticipantRow = { room_id: string; id: string; kind: 'agent' | 'human'; owner_id: string; display_name: string; vendor: Vendor | null; join_seq: number; left: boolean; cursor: number | null };
export type NewParticipant = { id: string; kind: 'agent' | 'human'; ownerId: string; displayName: string; vendor?: Vendor };
export type Db = ReturnType<typeof openDb>;

type Row = Record<string, any>;
const toMsg = (r: Row): StoredMessage => ({
  roomId: r.room_id, seq: r.seq, id: r.id, ts: r.ts,
  from: { kind: r.from_kind, participantId: r.from_participant_id, ownerId: r.from_owner_id, displayName: r.from_display_name, ...(r.from_vendor && { vendor: r.from_vendor }) },
  content: r.content, mentions: r.mentions, ...(r.reply_to && { replyTo: r.reply_to }), hops: r.hops, ...(r.deleted_at !== null && { deletedAt: r.deleted_at }),
});

export function openDb(url: string, onIdleError: (e: unknown) => void = () => {}) {
  const pool = new pg.Pool({ connectionString: url, max: 5, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  pool.on('error', onIdleError); // an idle client dropping must not crash the process; the next query reconnects
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Row[];
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  return {
    pool,
    end: () => pool.end(),
    ping: async () => void (await q('SELECT 1')),

    /** Applies pending migrations/*.sql in name order, each in its own transaction, under an advisory lock (concurrent boots wait, then see them applied). */
    async migrate() {
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
        await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
        const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));
        for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
          if (done.has(f)) continue;
          await c.query('BEGIN');
          try {
            await c.query(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
            await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
            await c.query('COMMIT');
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          }
        }
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
        c.release();
      }
    },

    /** Everything needed to rebuild the in-memory rooms. Messages: the newest `perRoom` of each OPEN room, ascending. */
    async loadAll(perRoom: number) {
      const rooms = (await q('SELECT id, topic, invite_hash, view_hash, admin_hash, admin_owner_id, last_seq, paused, closed_at IS NOT NULL AS closed FROM rooms')) as RoomRow[];
      const participants = (await q(`SELECT p.room_id, p.id, p.kind, p.owner_id, p.display_name, p.vendor, p.join_seq, p.left_at IS NOT NULL AS left, c.last_seq AS cursor
        FROM participants p LEFT JOIN participant_cursors c ON c.room_id = p.room_id AND c.participant_id = p.id ORDER BY p.joined_at`)) as ParticipantRow[];
      const tokens = await q(`SELECT t.token_hash, t.room_id, t.participant_id FROM agent_tokens t JOIN rooms r ON r.id = t.room_id
        WHERE t.revoked_at IS NULL AND r.closed_at IS NULL`);
      const messages = (await q(`SELECT * FROM (SELECT m.*, row_number() OVER (PARTITION BY m.room_id ORDER BY m.seq DESC) AS rn
        FROM messages m JOIN rooms r ON r.id = m.room_id AND r.closed_at IS NULL) x WHERE rn <= $1 ORDER BY room_id, seq`, [perRoom])).map(toMsg);
      return { rooms, participants, tokens: tokens as { token_hash: string; room_id: string; participant_id: string }[], messages };
    },

    insertRoom: async (r: { id: string; topic: string; hashes: Record<'invite' | 'view' | 'admin', string>; adminOwnerId: string }) =>
      void (await q('INSERT INTO rooms (id, topic, invite_hash, view_hash, admin_hash, admin_owner_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [r.id, r.topic, r.hashes.invite, r.hashes.view, r.hashes.admin, r.adminOwnerId])),

    /** Participant (+ token) in one transaction. join_seq is the room's committed last_seq, read in the same statement, so the join point is exact. */
    insertParticipant: (roomId: string, p: NewParticipant, tokenHash?: string) => tx(async (c) => {
      const r = await c.query(`INSERT INTO participants (room_id, id, kind, owner_id, display_name, vendor, join_seq)
        SELECT $1, $2, $3, $4, $5, $6, last_seq FROM rooms WHERE id = $1 RETURNING join_seq`, [roomId, p.id, p.kind, p.ownerId, p.displayName, p.vendor ?? null]);
      if (tokenHash) await c.query('INSERT INTO agent_tokens (token_hash, room_id, participant_id) VALUES ($1, $2, $3)', [tokenHash, roomId, p.id]);
      return r.rows[0]!.join_seq as number;
    }),

    /** Retry by client_msg_id: the existing row, looked up BEFORE a seq is claimed (a retry never burns a seq). Else claims last_seq+1 and inserts, one transaction. */
    appendMessage: (m: Omit<StoredMessage, 'seq'>, clientMsgId?: string) => tx(async (c): Promise<{ seq: number; id: string; duplicate: boolean }> => {
      if (clientMsgId) {
        const d = (await c.query('SELECT seq, id FROM messages WHERE room_id = $1 AND from_participant_id = $2 AND client_msg_id = $3', [m.roomId, m.from.participantId, clientMsgId])).rows[0];
        if (d) return { seq: d.seq, id: d.id, duplicate: true };
      }
      const seq = (await c.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq', [m.roomId])).rows[0]!.last_seq as number;
      await c.query(`INSERT INTO messages (room_id, seq, id, ts, from_participant_id, from_owner_id, from_display_name, from_kind, from_vendor, content, mentions, reply_to, hops, client_msg_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [m.roomId, seq, m.id, m.ts, m.from.participantId, m.from.ownerId, m.from.displayName, m.from.kind, m.from.vendor ?? null, m.content, JSON.stringify(m.mentions), m.replyTo ?? null, m.hops, clientMsgId ?? null]);
      return { seq, id: m.id, duplicate: false };
    }),

    /** Never moves a cursor backwards, so out-of-order best-effort writes are harmless. */
    setCursor: async (roomId: string, participantId: string, seq: number) =>
      void (await q(`INSERT INTO participant_cursors (room_id, participant_id, last_seq) VALUES ($1, $2, $3)
        ON CONFLICT (room_id, participant_id) DO UPDATE SET last_seq = GREATEST(participant_cursors.last_seq, EXCLUDED.last_seq)`, [roomId, participantId, seq])),

    markLeft: (roomId: string, participantId: string) => tx(async (c) => {
      await c.query('UPDATE participants SET left_at = now() WHERE room_id = $1 AND id = $2', [roomId, participantId]);
      await c.query('UPDATE agent_tokens SET revoked_at = now() WHERE room_id = $1 AND participant_id = $2 AND revoked_at IS NULL', [roomId, participantId]);
    }),

    setPaused: async (roomId: string, paused: boolean) => void (await q('UPDATE rooms SET paused = $2 WHERE id = $1', [roomId, paused])),

    closeRoom: (roomId: string) => tx(async (c) => {
      await c.query('UPDATE rooms SET closed_at = now() WHERE id = $1', [roomId]);
      await c.query('UPDATE agent_tokens SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL', [roomId]);
    }),

    rotateSecrets: async (roomId: string, h: Record<'invite' | 'view' | 'admin', string>) =>
      void (await q('UPDATE rooms SET invite_hash = $2, view_hash = $3, admin_hash = $4 WHERE id = $1', [roomId, h.invite, h.view, h.admin])),

    /** Admin erase: content gone, row and seq kept. Returns false when no such message. */
    tombstone: async (roomId: string, seq: number, at: number) =>
      ((await pool.query('UPDATE messages SET content = NULL, deleted_at = COALESCE(deleted_at, $3) WHERE room_id = $1 AND seq = $2', [roomId, seq, at])).rowCount ?? 0) > 0,

    /** `seq > lo AND seq < hi`, ascending when `forward`, else newest first; at most `limit` rows. `lastSeq` is the room's last_seq read in the SAME
     *  statement (one snapshot), so a caller can tell exactly which later messages it still needs. */
    async listMessages(roomId: string, o: { lo: number; hi: number | null; limit: number; forward: boolean }) {
      const rows = await q(`WITH r AS (SELECT last_seq FROM rooms WHERE id = $1)
        SELECT r.last_seq AS room_last_seq, m.* FROM r LEFT JOIN LATERAL (
          SELECT * FROM messages WHERE room_id = $1 AND seq > $2 AND ($3::bigint IS NULL OR seq < $3) ORDER BY seq ${o.forward ? 'ASC' : 'DESC'} LIMIT $4
        ) m ON true`, [roomId, o.lo, o.hi, o.limit]);
      return { lastSeq: (rows[0]?.room_last_seq ?? 0) as number, messages: rows.filter((r) => r.seq !== null).map(toMsg) };
    },
  };
}
