// Permanent rooms on a real SQLite file: a temp file per test, no service and no env var needed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessagesResponse, OperatorRoomsResponse, ROUTES, RoomPublicInfo, RotateSecretsResponse } from '@lesscubicles/protocol';
import { openDb } from '../src/db.js';
import { boot, freshDb, headers, parseSeq, sleep } from './helpers.js';

const KEY = 'operator-key-0123456789';
const op = { 'x-create-key': KEY };
let s: Awaited<ReturnType<typeof boot>> | undefined;
let db: Awaited<ReturnType<typeof freshDb>> | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  await db?.drop();
  db = undefined;
});

const start = async () => (s = await boot({ cfg: { databasePath: db!.path, createKey: KEY } }));
const restart = async () => { await s!.close(); return start(); };
const seqs = (t: string) => headers(t).map((h) => Number(/ seq=(\d+)/.exec(h)![1]));
const mem = (id: string) => (s!.app.store as any).rooms.get(id) as { seq: number; ring: { seq: number; content: string | null }[] };

describe('permanent rooms: creation gate (no database needed)', () => {
  it('POST /rooms needs both CREATE_KEY and DATABASE_PATH, else create_disabled; anonymous creation is unchanged', async () => {
    s = await boot({ cfg: { createKey: KEY } });
    expect((await s.api('POST', ROUTES.createPermanentRoom, { headers: op, body: {} })).json).toMatchObject({ code: 'create_disabled' });
    expect((await s.api('GET', ROUTES.operatorRooms, { headers: op })).status).toBe(503);
    expect((await s.api('POST', ROUTES.createRoom, { headers: op, body: {} })).json).toMatchObject({ kind: 'anonymous' });
    await s.close();
    s = await boot();
    expect((await s.api('POST', ROUTES.createPermanentRoom, { body: {} })).status).toBe(503);
  });

  it('DATABASE_PATH set but unopenable: the process exits non-zero and never logs the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-secretdir-'));
    try {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_PATH: dir, PORT: '0' } }); // a directory is not a database
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (out += c));
      const code = await new Promise<number | null>((ok) => p.on('exit', ok));
      expect(code).not.toBe(0);
      expect(out).toContain('boot_failed');
      expect(out).not.toContain('ao-secretdir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('permanent rooms on SQLite', () => {
  it('T1 restart: tokens, cursors, history, seq and departed participants survive', async () => {
    db = await freshDb();
    await start();
    expect((await s!.api('GET', '/healthz')).json).toEqual({ ok: true });
    const r = await s!.mkRoom('perm', 'permanent');
    expect(r.room).toMatchObject({ kind: 'permanent', expiresAt: null });
    const id = r.room.roomId;
    const a = await r.join('alice'), b = await r.join('bob'), c = await r.join('carol');
    expect(await c.call('room_leave')).toBe('left');
    for (let i = 1; i <= 5; i++) await a.call('room_send', { content: `m${i}` });
    const first = await b.call('room_inbox', { waitSeconds: 0 });
    expect(seqs(first)).toEqual([1, 2, 3, 4, 5]);
    expect(parseSeq(first)).toBe(5);

    await restart();
    const b2 = await s!.agent(b.token);
    expect(seqs(await b2.call('room_inbox', { waitSeconds: 0 }))).toEqual([]); // cursor 5 survived
    const h = await b2.call('room_history');
    expect(seqs(h)).toEqual([1, 2, 3, 4, 5]);
    expect(h).toContain('m3');
    expect(h).toMatch(/<<<MSG [0-9a-f]+ seq=1 /); // same wrapping as live delivery
    const a2 = await s!.agent(a.token);
    expect(await a2.call('room_send', { content: 'm6' })).toMatch(/^sent seq=6 /);
    await expect(s!.agent(c.token)).rejects.toThrow(); // departed: token revoked
    expect((await s!.api('POST', ROUTES.join(id), { body: { inviteSecret: r.room.inviteSecret, displayName: 'carol', vendor: 'other' } })).json).toMatchObject({ code: 'name_taken' });
    const parts = db.sql('SELECT display_name, join_seq, left_at IS NOT NULL AS left FROM participants ORDER BY rowid');
    expect(parts).toEqual([
      { display_name: 'alice', join_seq: 0, left: 0 }, { display_name: 'bob', join_seq: 0, left: 0 }, { display_name: 'carol', join_seq: 0, left: 1 },
    ]);
    const info = RoomPublicInfo.parse((await s!.api('GET', ROUTES.room(id), { headers: r.admin })).json);
    expect(info.participants.find((p) => p.displayName === 'carol')).toMatchObject({ left: true });
  });

  it('T2 concurrency: 50 parallel sends from 3 agents get gapless ordered seqs everywhere', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('c', 'permanent');
    const ag = [await r.join('a1'), await r.join('a2'), await r.join('a3')];
    const w = await r.ws('admin');
    await w.until((e) => e.type === 'init');
    const outs = await Promise.all(Array.from({ length: 50 }, (_, i) => ag[i % 3]!.call('room_send', { content: `x${i}` })));
    const all = Array.from({ length: 50 }, (_, i) => i + 1);
    expect((db.sql('SELECT seq FROM messages ORDER BY seq')).map((x) => x.seq)).toEqual(all);
    expect(mem(r.room.roomId).ring.map((x) => x.seq)).toEqual(all);
    for (let i = 0; i < 100 && w.events.filter((e) => e.type === 'message').length < 50; i++) await sleep(20);
    expect(w.events.flatMap((e) => (e.type === 'message' ? [e.message.seq] : []))).toEqual(all);
    // per agent: own sends + everything delivered (piggybacks, then a drain) = 1..50, nothing twice
    for (const [k, a] of ag.entries()) {
      const own = outs.filter((_, i) => i % 3 === k).map((t) => Number(/sent seq=(\d+)/.exec(t)![1]));
      const got = [...outs.filter((_, i) => i % 3 === k).flatMap(seqs), ...seqs(await a.call('room_inbox', { waitSeconds: 0 }))];
      expect(new Set(got).size).toBe(got.length);
      expect([...own, ...got].sort((x, y) => x - y)).toEqual(all);
    }
  });

  it('T3 a failing INSERT rejects the send and changes nothing; the next send gets the next seq', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('f', 'permanent');
    const a = await r.join('alice');
    const w = await r.ws('admin');
    await w.until((e) => e.type === 'init');
    await a.call('room_send', { content: 'one' });
    await w.until((e) => e.type === 'message');
    db.sql(`CREATE TRIGGER t3 BEFORE INSERT ON messages WHEN NEW.content = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const n = w.events.length;
    const res = await a.raw('room_send', { content: 'boom' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^internal: /);
    expect(mem(r.room.roomId).seq).toBe(1);
    expect(mem(r.room.roomId).ring.map((x) => x.seq)).toEqual([1]);
    expect((db.sql('SELECT last_seq FROM rooms'))[0].last_seq).toBe(1); // the UPDATE rolled back with the INSERT
    await sleep(50);
    expect(w.events.slice(n).filter((e) => e.type === 'message')).toEqual([]);
    expect(await a.call('room_send', { content: 'two' })).toMatch(/^sent seq=2 /);
    expect(s!.logs.join('\n')).toContain('"evt":"db_error","op":"send"');
  });

  it('T5 since_join on agent read paths, before and after restart; admin/view readers see everything', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('sj', 'permanent');
    const a = await r.join('alice');
    for (let i = 1; i <= 3; i++) await a.call('room_send', { content: `early${i}` });
    const c = await r.join('carol');
    expect(c.cursorStartsAt).toBe(3);
    for (let i = 4; i <= 5; i++) await a.call('room_send', { content: `late${i}` });
    const check = async (call: (n: string, x?: Record<string, unknown>) => Promise<string>) => {
      expect(seqs(await call('room_inbox', { sinceSeq: 0, waitSeconds: 0 }))).toEqual([4, 5]);
      expect(seqs(await call('room_history'))).toEqual([4, 5]);
      expect(seqs(await call('room_history', { beforeSeq: 4 }))).toEqual([]);
    };
    await check(c.call);
    const rest = MessagesResponse.parse((await s!.api('GET', ROUTES.messages(r.room.roomId), { headers: r.view })).json);
    expect(rest.messages.map((m) => m.seq)).toEqual([5, 4, 3, 2, 1]);
    const w = await r.ws('admin', { lastSeq: 0 });
    const init = await w.until((e) => e.type === 'init');
    expect(init.type === 'init' && init.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    await restart();
    await check((await s!.agent(c.token)).call);
  });

  it('T6 tombstone: content NULL in SQL, [deleted] everywhere, seq and cursors kept, also after restart', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('t', 'permanent');
    const a = await r.join('alice'), b = await r.join('bob');
    for (const t of ['keep-1', 'ERASE-ME-7c1', 'keep-3']) await a.call('room_send', { content: t });
    expect(parseSeq(await b.call('room_inbox', { waitSeconds: 0 }))).toBe(3);
    const erase = (seq: number) => s!.api('POST', ROUTES.admin(r.room.roomId), { headers: r.admin, body: { action: 'erase', seq } });
    expect((await erase(2)).status).toBe(200);
    expect((await erase(99)).json).toMatchObject({ code: 'bad_request' });
    expect((await s!.api('POST', ROUTES.admin(r.room.roomId), { headers: r.view, body: { action: 'erase', seq: 1 } })).status).toBe(403);
    const rows = db.sql('SELECT seq, content, deleted_at IS NOT NULL AS deleted FROM messages ORDER BY seq');
    expect(rows).toEqual([{ seq: 1, content: 'keep-1', deleted: 0 }, { seq: 2, content: null, deleted: 1 }, { seq: 3, content: 'keep-3', deleted: 0 }]);
    expect((db.sql('SELECT last_seq FROM participant_cursors'))).toEqual(expect.arrayContaining([{ last_seq: 3 }]));
    const everywhere = async (call: (n: string, x?: Record<string, unknown>) => Promise<string>) => {
      const rest = MessagesResponse.parse((await s!.api('GET', ROUTES.messages(r.room.roomId), { headers: r.admin })).json);
      expect(rest.messages.map((m) => [m.seq, m.content])).toEqual([[3, 'keep-3'], [2, '[deleted]'], [1, 'keep-1']]);
      for (const t of [await call('room_history'), await call('room_inbox', { sinceSeq: 0, waitSeconds: 0 })]) {
        expect(seqs(t)).toEqual([1, 2, 3]);
        expect(t).toContain('[deleted]');
        expect(t).not.toContain('ERASE-ME');
      }
    };
    await everywhere(b.call);
    expect(mem(r.room.roomId).ring.find((x) => x.seq === 2)!.content).toBeNull();
    await restart();
    const b2 = await s!.agent(b.token);
    expect(seqs(await b2.call('room_inbox', { waitSeconds: 0 }))).toEqual([]); // cursor unchanged by the erase
    await everywhere(b2.call);
  });

  it('T7 at rest: no plaintext secret or raw token in any column', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('rest', 'permanent');
    const a = await r.join('alice'), b = await r.join('bob');
    await a.call('room_send', { content: 'hello' });
    await b.call('room_inbox', { waitSeconds: 0 });
    const rot = RotateSecretsResponse.parse((await s!.api('POST', ROUTES.operatorRotate(r.room.roomId), { headers: op })).json);
    const tables = (db.sql(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)).map((x) => x.name as string);
    expect(tables).toEqual(expect.arrayContaining(['rooms', 'participants', 'messages', 'participant_cursors', 'agent_tokens', 'schema_migrations']));
    let dump = '';
    for (const t of tables) dump += db.sql(`SELECT * FROM ${t}`).map((x) => JSON.stringify(x)).join('\n');
    for (const secret of [r.room.inviteSecret, r.room.adminSecret, r.room.viewSecret, rot.inviteSecret, rot.adminSecret, rot.viewSecret, a.token, b.token, KEY]) {
      expect(dump, 'plaintext at rest').not.toContain(secret);
    }
    const sha = (x: string) => createHash('sha256').update(x).digest('hex');
    expect(dump).toContain(sha(a.token));
    expect((db.sql('SELECT admin_hash FROM rooms'))[0].admin_hash).toBe(sha(rot.adminSecret));
  });

  it('T8 a permanent room survives the clock moving 2 h and sweep(): no closing, no room_closed', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('long', 'permanent');
    const a = await r.join('alice');
    const w = await r.ws('admin');
    await w.until((e) => e.type === 'init');
    s!.clock.t += 2 * 3600_000;
    await s!.app.store.sweep();
    await sleep(50);
    expect(w.events.map((e) => e.type)).not.toEqual(expect.arrayContaining(['room_closing']));
    expect(w.events.map((e) => e.type)).not.toContain('room_closed');
    expect(await a.call('room_send', { content: 'still here' })).toMatch(/^sent seq=1 /);
    expect((await s!.api('GET', ROUTES.room(r.room.roomId), { headers: r.admin })).json).toMatchObject({ closed: false, expiresAt: null });
  });

  it('T9 migrations are idempotent and two handles on one file apply them once', async () => {
    db = await freshDb();
    const x = openDb(db.path), y = openDb(db.path);
    try {
      await Promise.all([x.migrate(), y.migrate(), x.migrate()]);
      await y.migrate();
    } finally {
      await x.end();
      await y.end();
    }
    expect(db.sql('SELECT version FROM schema_migrations').map((v) => v.version)).toEqual(['001_init.sql']);
    await start(); // booting on an already migrated database is a no-op
    expect(db.sql('SELECT count(*) AS n FROM schema_migrations')[0].n).toBe(1);
  });

  it('T10 drift guard: a row written behind our back is detected, the ring resyncs, no duplicate seq', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('d', 'permanent');
    const a = await r.join('alice');
    await a.call('room_send', { content: 'mine-1' });
    // what a second writer does: claim the next seq and insert
    db.sql('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ?', [r.room.roomId]); // db.sql is a second handle on the same file
    db.sql(`INSERT INTO messages (room_id, seq, id, ts, from_participant_id, from_owner_id, from_display_name, from_kind, content)
      SELECT id, 2, 'foreign-1', 0, 'p_ghost', 'o_ghost', 'ghost', 'agent', 'foreign' FROM rooms WHERE id = ?`, [r.room.roomId]);
    expect(await a.call('room_send', { content: 'mine-3' })).toMatch(/^sent seq=3 /);
    expect(s!.logs.join('\n')).toContain('"evt":"seq_drift"');
    expect(mem(r.room.roomId).ring.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(mem(r.room.roomId).seq).toBe(3);
    expect((db.sql('SELECT seq FROM messages ORDER BY seq')).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(await a.call('room_send', { content: 'mine-4' })).toMatch(/^sent seq=4 /);
  });

  it('T11 permanent tokens: no path fallback URL in the join response, /mcp/<token> is 401, Bearer works', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('p', 'permanent');
    const a = await r.join('alice');
    expect(a.snippets.pathFallbackUrl).toBeUndefined();
    expect(a.snippets.claudeCode).toContain('Authorization: Bearer');
    expect(JSON.stringify(a)).not.toContain(`/mcp/${a.token}`);
    await expect(s!.agent(a.token, 'path')).rejects.toThrow();
    expect((await s!.api('POST', `/mcp/${a.token}`, { raw: '{}' })).status).toBe(401);
    expect(await a.call('room_participants')).toContain('alice');
    // anonymous rooms keep the fallback
    const anon = (await s!.api('POST', ROUTES.createRoom, { headers: op, body: {} })).json;
    const j = (await s!.api('POST', ROUTES.join(anon.roomId), { body: { inviteSecret: anon.inviteSecret, displayName: 'bob', vendor: 'other' } })).json;
    expect(j.snippets.pathFallbackUrl).toBe(`http://localhost:3000/mcp/${j.token}`);
    expect(await (await s!.agent(j.token, 'path')).call('room_participants')).toContain('bob');
  });

  it('restart with more pending than BOOT_RING: the reply announces the gap and room_history recovers the skipped messages', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('gap', 'permanent');
    const a = await r.join('alice'), b = await r.join('bob');
    await a.call('room_send', { content: 'seed' });
    db.sql(`WITH RECURSIVE g(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM g WHERE n < 250)
      INSERT INTO messages (room_id, seq, id, ts, from_participant_id, from_owner_id, from_display_name, from_kind, content)
      SELECT ?, n, 'bulk-' || n, 0, 'p_ghost', 'o_ghost', 'ghost', 'agent', 'bulk' || n FROM g`, [r.room.roomId]);
    db.sql('UPDATE rooms SET last_seq = 250 WHERE id = ?', [r.room.roomId]);
    await restart();
    const b2 = await s!.agent(b.token);
    const t = await b2.call('room_inbox', { waitSeconds: 0 });
    expect(seqs(t)[0]).toBe(51); // ring holds 51..250
    expect(t).toContain('room_history({beforeSeq:51})');
    expect(seqs(await b2.call('room_history', { beforeSeq: 51 })).at(-1)).toBe(50);
  });

  it('operator: list, rotate, close; closed rooms keep readable history and refuse writes, also after restart', async () => {
    db = await freshDb();
    await start();
    const r = await s!.mkRoom('ops', 'permanent');
    const id = r.room.roomId;
    const a = await r.join('alice');
    await a.call('room_send', { content: 'before close' });
    expect((await s!.api('GET', ROUTES.operatorRooms)).json).toMatchObject({ code: 'create_forbidden' });
    expect((await s!.api('GET', ROUTES.operatorRooms, { headers: { 'x-create-key': 'wrong' } })).status).toBe(403);
    const list = OperatorRoomsResponse.parse((await s!.api('GET', ROUTES.operatorRooms, { headers: op })).json);
    expect(list.rooms).toEqual([{ roomId: id, topic: 'ops', closed: false, lastSeq: 1, activeParticipants: 1 }]);

    const rot = RotateSecretsResponse.parse((await s!.api('POST', ROUTES.operatorRotate(id), { headers: op })).json);
    expect((await s!.api('GET', ROUTES.room(id), { headers: r.admin })).status).toBe(403); // old secret dead
    expect((await s!.api('GET', ROUTES.room(id), { headers: { 'x-admin-secret': rot.adminSecret } })).status).toBe(200);
    expect(await a.call('room_send', { content: 'agents keep their tokens' })).toMatch(/^sent seq=2 /);

    expect((await s!.api('POST', ROUTES.operatorClose(id), { headers: op })).json).toEqual({ ok: true });
    await expect(a.raw('room_send', { content: 'after close' })).rejects.toThrow(); // token revoked: 401
    await expect(s!.agent(a.token)).rejects.toThrow();
    expect((await s!.api('POST', ROUTES.join(id), { body: { inviteSecret: rot.inviteSecret, displayName: 'zed', vendor: 'other' } })).json).toMatchObject({ code: 'room_closed' });
    expect((db.sql('SELECT count(*) AS n FROM agent_tokens WHERE revoked_at IS NULL'))[0].n).toBe(0);

    await restart();
    expect((await s!.api('GET', ROUTES.room(id), { headers: { 'x-view-secret': rot.viewSecret } })).json).toMatchObject({ closed: true, kind: 'permanent' });
    const hist = MessagesResponse.parse((await s!.api('GET', ROUTES.messages(id), { headers: { 'x-view-secret': rot.viewSecret } })).json);
    expect(hist.messages.map((m) => m.content)).toEqual(['agents keep their tokens', 'before close']);
    expect(OperatorRoomsResponse.parse((await s!.api('GET', ROUTES.operatorRooms, { headers: op })).json).rooms[0]).toMatchObject({ closed: true });
    await expect(s!.agent(a.token)).rejects.toThrow();
  });
});
