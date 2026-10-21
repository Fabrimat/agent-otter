import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { redactPath } from '../src/log.js';
import { boot, freshDb, sleep } from './helpers.js';

let s: Awaited<ReturnType<typeof boot>>;
let tmp: string | undefined;
let db: Awaited<ReturnType<typeof freshDb>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await s?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
  await db?.drop();
  db = undefined;
});

/** Raw request so the client does not normalise `..` out of the path. */
const raw = (url: string, path: string) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((res, rej) => {
    const u = new URL(url);
    http.get({ host: u.hostname, port: u.port, path }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => res({ status: r.statusCode ?? 0, body, headers: r.headers }));
    }).on('error', rej);
  });

describe('logs and storage', () => {
  it('log capture contains no token, secret, ticket or message content', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('alice', 'other', 'path'), b = await r.join('bob');
    const marker = 'PAYLOAD-MARKER-9f3a1c';
    await a.call('room_send', { content: `${marker} @bob` });
    await b.call('room_inbox', { waitSeconds: 0 });
    await b.call('room_history');
    const w = await r.ws('admin');
    w.send({ type: 'send_message', content: `${marker}-human` });
    await w.until((e) => e.type === 'message');
    const ticket = await r.ticket(r.admin);
    await r.wsStatus({ ticket });
    await s.api('POST', `/mcp/${'z'.repeat(43)}`, { raw: '{}' });
    await s.api('POST', `/rooms/${r.room.roomId}/join`, { body: { inviteSecret: 'wrong', displayName: 'x', vendor: 'other' } });
    await sleep(50);
    const all = s.logs.join('\n');
    expect(all.length).toBeGreaterThan(100);
    for (const secret of [a.token, b.token, ticket, r.room.inviteSecret, r.room.adminSecret, r.room.viewSecret, marker, 'z'.repeat(43)]) expect(all, secret).not.toContain(secret);
    expect(all).toContain('/mcp/<redacted>');
    expect(redactPath('/mcp/abc?x=1')).toBe('/mcp/<redacted>');
  });

  it('writes nothing to disk during a full flow', async () => {
    const spies = [
      vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'appendFileSync'), vi.spyOn(fs, 'createWriteStream'), vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'appendFile'),
      vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'renameSync'), vi.spyOn(fsp, 'writeFile'), vi.spyOn(fsp, 'appendFile'), vi.spyOn(fsp, 'mkdir'), vi.spyOn(fsp, 'open'),
    ];
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('a'), b = await r.join('b');
    const w = await r.ws('admin');
    await a.call('room_send', { content: 'hi' });
    await b.call('room_inbox', { waitSeconds: 0 });
    await a.call('room_leave');
    await s.api('POST', `/rooms/${r.room.roomId}/admin`, { headers: r.admin, body: { action: 'close' } });
    await w.isClosed();
    for (const sp of spies) expect(sp).not.toHaveBeenCalled();
  });

  it('source has no file-write code, and only db.ts talks to a database', () => {
    const dir = new URL('../src/', import.meta.url);
    for (const f of fs.readdirSync(dir)) {
      const code = fs.readFileSync(new URL(f, dir), 'utf8');
      expect(code, f).not.toMatch(/writeFile|appendFile|createWriteStream|writeSync|redis/i);
      if (f !== 'db.ts') expect(code, f).not.toMatch(/node:sqlite|DatabaseSync|better-sqlite|\bpg\b|\bPool\b|\.query\(/);
    }
    // the behavioural half (an anonymous room issues zero queries and changes zero rows) runs below against a real database
  });
});

// "Leaves no trace" = zero rows changed AND zero queries after boot AND no persistence log event (the room id in the access log is fine).
describe('anonymous rooms with persistence switched on', () => {
  it('a full anonymous flow (through expiry) issues no query and changes no row', async () => {
    db = await freshDb();
    s = await boot({ cfg: { databasePath: db.path } });
    const counts = () => db!.sql(`SELECT (SELECT count(*) FROM rooms) AS rooms, (SELECT count(*) FROM participants) AS participants,
      (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM participant_cursors) AS cursors, (SELECT count(*) FROM agent_tokens) AS tokens,
      (SELECT count(*) FROM cubicles) AS cubicles, (SELECT count(*) FROM cubicle_pages) AS cubicle_pages`);
    const before = counts();
    const handle = s.app.db!.handle; // every statement goes through prepare() or exec()
    const queries = [vi.spyOn(handle, 'prepare'), vi.spyOn(handle, 'exec')];
    const logStart = s.logs.length;
    const marker = 'ANON-MARKER-51d2';
    const r = await s.mkRoom('anon topic');
    expect(r.room).toMatchObject({ kind: 'anonymous' });
    const a = await r.join('alice', 'other', 'path'), b = await r.join('bob');
    const w = await r.ws('admin');
    await a.call('room_send', { content: `${marker} @bob`, clientMsgId: 'c1' });
    await a.call('room_send', { content: 'again', clientMsgId: 'c1' });
    await b.call('room_inbox', { waitSeconds: 0 });
    await b.call('room_history');
    await b.call('room_participants');
    await a.call('cubicle_write', { content: `${marker} cubicle`, visibility: 'owner' });
    await a.call('cubicle_write', { page: 'two', content: 'second page' });
    await b.call('cubicle_list');
    await b.call('cubicle_read', { participantId: a.participantId });
    await s.api('GET', `/rooms/${r.room.roomId}/cubicles`, { headers: r.admin });
    await s.api('GET', `/rooms/${r.room.roomId}/cubicles/${a.participantId}`, { headers: r.admin });
    await a.call('cubicle_delete', { page: 'two' });
    w.send({ type: 'send_message', content: `${marker}-human` });
    await w.until((e) => e.type === 'message' && e.message.from.kind === 'human');
    const admin = (body: object) => s.api('POST', `/rooms/${r.room.roomId}/admin`, { headers: r.admin, body });
    await admin({ action: 'pause', paused: true });
    await admin({ action: 'pause', paused: false });
    expect((await admin({ action: 'erase', seq: 1 })).status).toBe(200);
    await s.api('GET', `/rooms/${r.room.roomId}/messages`, { headers: r.view });
    expect((await admin({ action: 'erase_cubicle', participantId: a.participantId })).status).toBe(200);
    await admin({ action: 'kick', participantId: b.participantId });
    await a.call('room_leave');
    s.clock.t += 3600_000 + 1;
    await s.app.store.sweep();
    expect(await w.isClosed()).toBe(true);
    for (const q of queries) expect(q).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);
    const after = s.logs.slice(logStart).join('\n');
    expect(after).not.toMatch(/"evt":"(db_error|seq_drift|room_created)"/);
    expect(after).not.toContain(marker);
  });

  it('log capture of a permanent-room flow contains no token, secret, key, database path or message content', async () => {
    db = await freshDb();
    const key = 'create-key-for-log-test-42';
    s = await boot({ cfg: { databasePath: db.path, createKey: key } });
    const r = await s.mkRoom('perm', 'permanent');
    const a = await r.join('alice'), b = await r.join('bob');
    const marker = 'PERM-PAYLOAD-MARKER-c0ffee';
    await a.call('room_send', { content: `${marker} @bob` });
    await b.call('room_inbox', { waitSeconds: 0 });
    await b.call('room_history');
    const w = await r.ws('admin');
    await w.until((e) => e.type === 'init'); // commands sent before init are not read yet (the SQL init read takes a moment)
    w.send({ type: 'send_message', content: `${marker}-human` });
    await w.until((e) => e.type === 'message');
    const rot = (await s.api('POST', `/operator/rooms/${r.room.roomId}/rotate`, { headers: { 'x-create-key': key } })).json;
    await s.api('POST', `/rooms/${r.room.roomId}/admin`, { headers: { 'x-admin-secret': rot.adminSecret }, body: { action: 'erase', seq: 1 } });
    await s.api('POST', `/mcp/${a.token}`, { raw: '{}' }); // refused path token
    await s.api('GET', '/operator/rooms', { headers: { 'x-create-key': 'wrong-key-xyz' } });
    await s.api('GET', '/healthz');
    await sleep(50);
    const all = s.logs.join('\n');
    expect(all).toContain('"evt":"room_created"');
    for (const secret of [a.token, b.token, r.room.inviteSecret, r.room.adminSecret, r.room.viewSecret, rot.inviteSecret, rot.adminSecret, rot.viewSecret,
      key, 'wrong-key-xyz', marker, db.path]) expect(all, secret).not.toContain(secret);
  });
});

describe('static files', () => {
  it('serves the SPA with security headers, falls back to index.html, and never leaves the dist dir', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ao-static-'));
    const dist = join(tmp, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>spa</title><script src="/assets/app.js"></script>');
    await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(tmp, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    await writeFile(join(dist, 'assets', 'ok.txt'), 'inside');
    s = await boot({ cfg: { webDist: dist } });

    const idx = await raw(s.url, '/');
    expect(idx.status).toBe(200);
    expect(idx.body).toContain('<title>spa</title>');
    const csp = String(idx.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(idx.headers['referrer-policy']).toBe('no-referrer');
    expect(idx.headers['x-content-type-options']).toBe('nosniff');
    expect((await raw(s.url, '/assets/app.js')).headers['content-type']).toContain('javascript');
    expect((await raw(s.url, '/r/some-room')).body).toContain('<title>spa</title>'); // SPA fallback
    expect((await raw(s.url, '/assets/missing.js')).status).toBe(404);

    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/assets/../../secret.txt', '/%252e%252e/secret.txt', '/%00', '/%', '//etc/passwd', '/C:/Windows/win.ini', '/assets/%2e%2e/%2e%2e/secret.txt']) {
      const r = await raw(s.url, p);
      expect(r.body, p).not.toContain('TOP-SECRET-OUTSIDE');
    }
    expect((await raw(s.url, '/assets/ok.txt')).body).toBe('inside');
    // API still wins over the SPA and answers JSON
    expect((await raw(s.url, '/rooms/' + 'a'.repeat(12))).headers['content-type']).toContain('application/json');
  });

  it('API responses carry the security headers too, and no static dir means a JSON 404', async () => {
    s = await boot();
    const r = await raw(s.url, '/nothing');
    expect(r.status).toBe(404);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });
});

describe('config', () => {
  it('has safe defaults and validates at startup', () => {
    expect(loadConfig({})).toMatchObject({ port: 3000, publicUrl: 'http://localhost:3000', trustProxy: false, maxRooms: 1000, logLevel: 'info' });
    expect(loadConfig({ PORT: '8080', PUBLIC_URL: 'https://office.example.com/', TRUST_PROXY: 'true', MAX_ROOMS: '5', LOG_LEVEL: 'warn' })).toMatchObject({
      port: 8080, publicUrl: 'https://office.example.com', trustProxy: true, maxRooms: 5, logLevel: 'warn',
    });
    expect(loadConfig({ DATABASE_PATH: ':memory:' }).databasePath).toBe(':memory:');
    expect(loadConfig({ DATABASE_PATH: join(tmpdir(), 'ao.db') }).databasePath).toBe(join(tmpdir(), 'ao.db'));
    for (const bad of [{ PORT: 'abc' }, { PORT: '99999' }, { PUBLIC_URL: 'ftp://x' }, { PUBLIC_URL: 'http://x"; rm -rf /' }, { TRUST_PROXY: 'yes' }, { MAX_ROOMS: '0' }, { LOG_LEVEL: 'loud' }, { DATABASE_PATH: join(tmpdir(), 'does-not-exist-ao', 'ao.db') }, { WEB_DIST: join(tmpdir(), 'does-not-exist-ao') }]) {
      expect(() => loadConfig(bad), JSON.stringify(bad)).toThrow(/invalid configuration/);
    }
  });
});
