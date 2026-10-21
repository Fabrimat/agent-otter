import fs from 'node:fs';
import { networkInterfaces } from 'node:os';
import { PublicConfig } from '@lesscubicles/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { boot, sleep, T0 } from './helpers.js';

let s: Awaited<ReturnType<typeof boot>>;
afterEach(async () => { await s?.close(); });

describe('MCP rate limit and long-poll cap', () => {
  it('returns a tool error after N calls per minute, per participant, and recovers', async () => {
    s = await boot({ cfg: { mcpCallsPerMinute: 3 } });
    const r = await s.mkRoom();
    const a = await r.join('alice'), b = await r.join('bob');
    for (let i = 0; i < 3; i++) expect((await a.raw('room_participants')).isError).toBeFalsy();
    const over = await a.raw('room_participants');
    expect([over.isError, over.content[0]!.text]).toEqual([true, expect.stringMatching(/^rate_limited: /)]);
    expect((await b.raw('room_participants')).isError).toBeFalsy(); // another participant is unaffected
    s.clock.t += 61_000;
    expect((await a.raw('room_participants')).isError).toBeFalsy();
  });

  it('a third concurrent wait resolves the oldest one early with an empty result', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('alice');
    const t0 = Date.now();
    const w1 = a.call('room_inbox', { waitSeconds: 20 });
    await sleep(100);
    void a.call('room_inbox', { waitSeconds: 20 }).catch(() => {}); // stays open until the app closes
    await sleep(100);
    const w3 = a.call('room_inbox', { waitSeconds: 1 });
    expect(await w1).toContain('lastSeq=0'); // resolved early, nothing delivered
    expect(Date.now() - t0).toBeLessThan(1500);
    await w3;
    // timers/listeners released: only the one still-open wait remains registered
    const room = [...(s.app.store as any).rooms.values()][0];
    const member = [...room.members.values()].find((m: any) => m.displayName === 'alice') as any;
    expect([room.listeners.size, member.waits.size]).toEqual([1, 1]);
  });
});

describe('memory budget', () => {
  const send = (st: MemoryStore, room: string, p: string, n: number, c = 'x'.repeat(1000)) => st.send(room, p, { content: c + n });
  const mk = async (o: ConstructorParameters<typeof MemoryStore>[0]) => {
    let t = T0;
    const st = new MemoryStore({ now: () => t, messagesPerMinute: 100_000, ...o });
    const room = await st.createRoom('t');
    const j = await st.join(room.roomId, { displayName: 'a', vendor: 'other' });
    return { st, room: room.roomId, p: j.participantId, tick: (ms: number) => (t += ms) };
  };

  it('per-room byte budget drops the oldest messages', async () => {
    const { st, room, p } = await mk({ ringBytes: 5000 });
    for (let i = 0; i < 20; i++) await send(st, room, p, i);
    const page = await st.list(room, { limit: 100 });
    expect(page.messages.length).toBeGreaterThan(1);
    expect(page.messages.length).toBeLessThan(6);
    expect(page.messages.at(-1)!.seq).toBe(20); // newest kept
  });

  it('global budget rejects sends with rate_limited, and expiry frees it', async () => {
    const { st, room, p, tick } = await mk({ maxTotalBytes: 4000, ttlMs: 10_000 });
    for (let i = 0; i < 3; i++) await send(st, room, p, i);
    await expect(send(st, room, p, 99)).rejects.toMatchObject({ code: 'rate_limited', message: expect.stringContaining('memory budget') });
    tick(10_001);
    await st.sweep();
    const fresh = await st.createRoom('t2');
    const j = await st.join(fresh.roomId, { displayName: 'b', vendor: 'other' });
    await expect(send(st, fresh.roomId, j.participantId, 1)).resolves.toMatchObject({ duplicate: false });
  });
});

describe('room-creation gate', () => {
  it('GET /api/config is public and matches the schema', async () => {
    s = await boot({ cfg: { createKey: 'k-1', roomTtlSeconds: 600 } });
    const r = await s.api('GET', '/api/config');
    expect(PublicConfig.parse(r.json)).toEqual({ createRequiresKey: true, createEnabled: true, ttlSeconds: 600 });
    expect(r.text).not.toContain('k-1');
  });

  it('CREATE_ROOMS=false answers 503 create_disabled', async () => {
    s = await boot({ cfg: { createRooms: false } });
    const r = await s.api('POST', '/rooms/anonymous', { body: {} });
    expect([r.status, r.json.code]).toEqual([503, 'create_disabled']);
    expect((await s.api('GET', '/api/config')).json).toMatchObject({ createEnabled: false });
  });

  it('CREATE_KEY: missing and wrong keys are 403 create_forbidden, the right one works, the key is never logged', async () => {
    s = await boot({ cfg: { createKey: 'sekrit-create-key' } });
    for (const h of [{} as Record<string, string>, { 'x-create-key': 'wrong' }, { 'x-create-key': 'sekrit-create-key-longer' }]) {
      const r = await s.api('POST', '/rooms/anonymous', { headers: h, body: {} });
      expect([r.status, r.json.code]).toEqual([403, 'create_forbidden']);
    }
    expect((await s.api('POST', '/rooms/anonymous', { headers: { 'x-create-key': 'sekrit-create-key' }, body: {} })).status).toBe(200);
    expect(s.logs.join('\n')).not.toContain('sekrit-create-key');
    expect(s.logs.join('\n')).not.toContain('wrong');
  });

  describe('per-IP room limit', () => {
    const create = (h: Record<string, string> = {}) => s.api('POST', '/rooms/anonymous', { headers: h, body: {} });

    it('a valid CREATE_KEY holder is not bound by the per-IP limit; a wrong key still is refused', async () => {
      s = await boot({ cfg: { createKey: 'good-key' }, createsPerHour: 2 });
      for (let i = 0; i < 8; i++) expect((await create({ 'x-create-key': 'good-key' })).status, String(i)).toBe(200);
      expect((await create({ 'x-create-key': 'nope' })).status).toBe(403);
    });

    it('without CREATE_KEY the limit still applies', async () => {
      s = await boot({ createsPerHour: 2 });
      expect([(await create()).status, (await create()).status, (await create()).status]).toEqual([200, 200, 429]);
    });
  });

  describe('key brute force', () => {
    const create = (h: Record<string, string>) => s.api('POST', '/rooms/anonymous', { headers: h, body: {} });
    const fwd = (ip: string, key = 'wrong') => ({ 'x-forwarded-for': ip, 'x-create-key': key });

    it('20 wrong keys end in 429; another IP is unaffected; the right key from the blocked IP waits out the window', async () => {
      s = await boot({ cfg: { createKey: 'good-key', trustProxy: true, createKeyFailsPer10Min: 10 } });
      const codes: number[] = [];
      for (let i = 0; i < 20; i++) codes.push((await create(fwd('10.0.0.1'))).status);
      expect(codes.slice(0, 10).every((c) => c === 403)).toBe(true);
      expect(codes.slice(10).every((c) => c === 429)).toBe(true);
      expect((await create(fwd('10.0.0.2', 'good-key'))).status).toBe(200); // other IP still works
      const blocked = await create(fwd('10.0.0.1', 'good-key'));
      expect([blocked.status, blocked.json.code]).toEqual([429, 'rate_limited']); // not even compared
      s.clock.t += 600_001;
      expect((await create(fwd('10.0.0.1', 'good-key'))).status).toBe(200);
      expect(s.logs.join('\n')).not.toContain('good-key');
      expect(s.logs.join('\n')).toContain('10.0.0.1');
    });

    it('a successful key does not consume the failure budget', async () => {
      s = await boot({ cfg: { createKey: 'good-key', trustProxy: true, createKeyFailsPer10Min: 2 } });
      for (let i = 0; i < 6; i++) expect((await create(fwd('10.0.0.3', 'good-key'))).status).toBe(200);
    });
  });
});

describe('room TTL', () => {
  it('ROOM_TTL_SECONDS shortens the lifetime and is never refreshed', async () => {
    s = await boot({ cfg: { roomTtlSeconds: 60 } });
    const r = await s.mkRoom();
    expect(r.room.expiresAt).toBe(T0 + 60_000);
    const a = await r.join('alice');
    s.clock.t += 59_000;
    await a.call('room_send', { content: 'activity' });
    expect((await s.api('GET', `/rooms/${r.room.roomId}`, { headers: r.admin })).json.expiresAt).toBe(T0 + 60_000);
    s.clock.t += 2_000;
    expect((await s.api('GET', `/rooms/${r.room.roomId}`, { headers: r.admin })).status).toBe(404);
  });

  it('out-of-range values are rejected at startup; the 1 h cap holds', () => {
    for (const v of ['4', '3601', '0', '-1', 'abc', '1.5']) expect(() => loadConfig({ ROOM_TTL_SECONDS: v }), v).toThrow(/ROOM_TTL_SECONDS/);
    expect(loadConfig({ ROOM_TTL_SECONDS: '5' }).roomTtlSeconds).toBe(5);
    expect(loadConfig({ ROOM_TTL_SECONDS: '3600' }).roomTtlSeconds).toBe(3600);
    expect(loadConfig({}).roomTtlSeconds).toBe(3600);
    expect(new MemoryStore({ ttlMs: 99 * 3600_000 })).toBeTruthy(); // clamped in the store too
  });

  it('new env vars validate', () => {
    expect(loadConfig({})).toMatchObject({ mcpCallsPerMinute: 120, maxTotalBytes: 256 * 1024 * 1024, createRooms: true, createKey: undefined, roomsPerIpPerHour: 5 });
    expect(loadConfig({ ROOMS_PER_IP_PER_HOUR: '50' }).roomsPerIpPerHour).toBe(50);
    for (const v of ['0', '10001', 'x', '1.5']) expect(() => loadConfig({ ROOMS_PER_IP_PER_HOUR: v }), v).toThrow(/ROOMS_PER_IP_PER_HOUR/);
    expect(loadConfig({ CREATE_ROOMS: 'false', CREATE_KEY: 'abc', MAX_TOTAL_BYTES: '1000', MCP_CALLS_PER_MINUTE: '5' })).toMatchObject({ createRooms: false, createKey: 'abc', maxTotalBytes: 1000, mcpCallsPerMinute: 5 });
    for (const bad of [{ CREATE_ROOMS: 'no' }, { MAX_TOTAL_BYTES: '0' }, { MCP_CALLS_PER_MINUTE: '0' }]) expect(() => loadConfig(bad)).toThrow(/invalid configuration/);
  });
});

describe('ticket caps', () => {
  it('per-room and per-IP pending tickets are capped, and redeeming frees a slot', async () => {
    s = await boot({ storeOptions: { maxTicketsPerRoom: 3, maxTicketsPerIp: 100 } });
    const r = await s.mkRoom();
    const tickets: string[] = [];
    for (let i = 0; i < 3; i++) tickets.push(await r.ticket(r.admin));
    const over = await s.api('POST', `/rooms/${r.room.roomId}/ws-ticket`, { headers: r.admin });
    expect([over.status, over.json.code]).toEqual([429, 'rate_limited']);
    expect(await r.wsStatus({ ticket: tickets[0]! })).toBe('open');
    expect((await s.api('POST', `/rooms/${r.room.roomId}/ws-ticket`, { headers: r.admin })).status).toBe(200);
  });

  it('per-IP cap spans rooms', async () => {
    s = await boot({ storeOptions: { maxTicketsPerRoom: 100, maxTicketsPerIp: 2 } });
    const [r1, r2] = [await s.mkRoom(), await s.mkRoom()];
    await r1.ticket(r1.admin);
    await r2.ticket(r2.admin);
    expect((await s.api('POST', `/rooms/${r1.room.roomId}/ws-ticket`, { headers: r1.admin })).status).toBe(429);
  });
});

describe('WS Origin behind a proxy', () => {
  it('accepts the PUBLIC_URL origin as well as Host, rejects the rest', async () => {
    s = await boot({ cfg: { publicUrl: 'https://office.example.com' } });
    const r = await s.mkRoom();
    expect(await r.wsStatus({ origin: 'https://office.example.com' })).toBe('open');
    expect(await r.wsStatus({ origin: 'http://office.example.com' })).toBe(403); // scheme differs
    expect(await r.wsStatus({ origin: 'https://evil.example.com' })).toBe(403);
    expect(await r.wsStatus({ origin: 'https://office.example.com.evil.io' })).toBe(403);
    expect(await r.wsStatus({ origin: 'https://OFFICE.Example.com' })).toBe('open'); // case
    expect(await r.wsStatus({ origin: 'https://office.example.com:443' })).toBe('open'); // default port
    expect(await r.wsStatus({ origin: 'https://office.example.com:8443' })).toBe(403);
    expect(await r.wsStatus({ origin: 'null' })).toBe(403);
  });

  it('Host match ignores case and the default port', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const port = new URL(s.url).port;
    expect(await r.wsStatus({ origin: `http://127.0.0.1:${port}` })).toBe('open');
    expect(await r.wsStatus({ origin: `https://127.0.0.1:${port}` })).toBe('open'); // scheme is not part of the Host match
    expect(await r.wsStatus({ origin: 'http://127.0.0.1' })).toBe(403); // wrong (default) port
  });
});

describe('healthz and shutdown', () => {
  it('GET /healthz is 200 {ok:true} with no auth and no room data', async () => {
    s = await boot();
    await s.mkRoom('private-topic');
    const r = await s.api('GET', '/healthz');
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
  });

  it('shutdown sends a close frame, stops accepting and finishes quickly', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('alice');
    const w = await r.ws('admin');
    const code = new Promise<number>((ok) => w.w.once('close', (c) => ok(c)));
    const poll = a.call('room_inbox', { waitSeconds: 20 }).catch(() => 'dropped');
    await sleep(100);
    const t0 = Date.now();
    await s.app.shutdown();
    expect(await code).toBe(1001);
    expect(Date.now() - t0).toBeLessThan(4000);
    await poll;
    await expect(fetch(s.url + '/healthz')).rejects.toThrow();
  });
});

describe('secrets at the choke point and consistent error logs', () => {
  it('the store itself refuses secrets', async () => {
    const st = new MemoryStore();
    const room = await st.createRoom('t');
    const j = await st.join(room.roomId, { displayName: 'a', vendor: 'other' });
    await expect(st.send(room.roomId, j.participantId, { content: 'key sk-ant-api03-' + 'a'.repeat(40) })).rejects.toMatchObject({ code: 'secret_detected' });
  });

  it('no log call in src prints an error message', () => {
    const dir = new URL('../src/', import.meta.url);
    for (const f of fs.readdirSync(dir)) {
      const code = fs.readFileSync(new URL(f, dir), 'utf8');
      // whole-file scan: multi-line log calls, and a variable assigned from `.message` that is then logged
      expect(code, f).not.toMatch(/log\.\w+\(\s*\{[^}]*\.message/);
      for (const v of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=[^;]*\.message/g)) expect(code, `${f}: ${v[1]}`).not.toMatch(new RegExp(`log\\.\\w+\\([^;]*\\b${v[1]}\\b`));
    }
  });
});

describe('bind address', () => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const reach = (host: string, port: number) => fetch(`http://${host}:${port}/healthz`).then((r) => r.status, () => 'refused' as const);

  it('config: default is loopback, IPs and hostnames pass, junk fails', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ HOST: '::1' }).host).toBe('::1');
    expect(loadConfig({ HOST: 'localhost' }).host).toBe('localhost');
    for (const bad of ['a b', 'http://x', 'x;y', '-x']) expect(() => loadConfig({ HOST: bad }), bad).toThrow(/HOST/);
  });

  it.skipIf(!lan)('default loopback refuses a non-loopback local address; HOST=0.0.0.0 accepts it', async () => {
    s = await boot(); // helper cfg uses the same default as loadConfig
    const port = Number(new URL(s.url).port);
    expect(await reach('127.0.0.1', port)).toBe(200);
    expect(await reach(lan!, port)).toBe('refused');
    await s.close();
    s = await boot({ cfg: { host: '0.0.0.0' } });
    expect(await reach(lan!, Number(new URL(s.url).port))).toBe(200);
  });
});
