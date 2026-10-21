import { afterEach, describe, expect, it } from 'vitest';
import { CreateRoomResponse, MessagesResponse, RoomPublicInfo, ServerEvent, WsTicketResponse, LIMITS } from '@lesscubicles/protocol';
import { boot, sleep, T0 } from './helpers.js';

let s: Awaited<ReturnType<typeof boot>>;
afterEach(async () => { await s?.close(); });

const origin = (url: string) => new URL(url).host;

describe('REST', () => {
  it('create, get, join, messages follow the protocol schemas', async () => {
    s = await boot();
    const { room, admin, view, join } = await s.mkRoom('my topic');
    expect(CreateRoomResponse.parse(room).expiresAt).toBe(T0 + LIMITS.roomTtlMs);
    expect(room.inviteSecret).toMatch(/^[0-9a-f]{32}$/);
    for (const h of [{ 'x-invite-secret': room.inviteSecret }, view, admin]) {
      const g = await s.api('GET', `/rooms/${room.roomId}`, { headers: h });
      expect(g.status).toBe(200);
      expect(RoomPublicInfo.parse(g.json)).toMatchObject({ topic: 'my topic', paused: false, closed: false });
    }
    const a = await join('alice'), b = await join('bob');
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.snippets.claudeCode).toContain('Authorization: Bearer');
    expect(a.snippets.pathFallbackUrl).toBe(`http://localhost:3000/mcp/${a.token}`);
    for (let i = 1; i <= 3; i++) await a.call('room_send', { content: `m${i}` });
    const m = await s.api('GET', `/rooms/${room.roomId}/messages?limit=2`, { headers: view });
    const parsed = MessagesResponse.parse(m.json);
    expect(parsed.messages.map((x) => x.seq)).toEqual([3, 2]); // newest first
    expect(parsed.hasMore).toBe(true);
    expect(parsed.messages[0]!.relation).toBe('other');
    const older = MessagesResponse.parse((await s.api('GET', `/rooms/${room.roomId}/messages?beforeSeq=2`, { headers: admin })).json);
    expect(older.messages.map((x) => x.seq)).toEqual([1]);
    expect(older.hasMore).toBe(false);
    void b;
  });

  it('wrong or missing secrets are refused; invite cannot read messages; ids are validated', async () => {
    s = await boot();
    const { room } = await s.mkRoom();
    const id = room.roomId;
    expect((await s.api('GET', `/rooms/${id}`)).json).toMatchObject({ code: 'bad_secret' });
    expect((await s.api('GET', `/rooms/${id}`, { headers: { 'x-admin-secret': 'f'.repeat(32) } })).status).toBe(403);
    expect((await s.api('GET', `/rooms/${id}/messages`, { headers: { 'x-invite-secret': room.inviteSecret } })).status).toBe(403);
    expect((await s.api('POST', `/rooms/${id}/admin`, { headers: { 'x-view-secret': room.viewSecret }, body: { action: 'close' } })).status).toBe(403);
    expect((await s.api('POST', `/rooms/${id}/join`, { body: { inviteSecret: 'nope', displayName: 'z', vendor: 'other' } })).json).toMatchObject({ code: 'bad_secret' });
    expect((await s.api('GET', '/rooms/' + 'a'.repeat(12), { headers: { 'x-admin-secret': room.adminSecret } })).json).toMatchObject({ code: 'room_not_found' });
    expect((await s.api('GET', '/rooms/not-an-id')).status).toBe(404);
  });

  it('strict bodies: unknown or server-owned fields are rejected, junk is a 400, big bodies a 413', async () => {
    s = await boot();
    const { room, admin } = await s.mkRoom();
    const join = (body: object) => s.api('POST', `/rooms/${room.roomId}/join`, { body });
    const ok = { inviteSecret: room.inviteSecret, displayName: 'z', vendor: 'other' };
    for (const extra of [{ from: 'x' }, { seq: 5 }, { ownerId: 'o_1' }, { hops: 1 }]) expect((await join({ ...ok, ...extra })).json).toMatchObject({ code: 'bad_request' });
    expect((await join({ ...ok, vendor: 'nope' })).status).toBe(400);
    expect((await join({ ...ok, displayName: 'x'.repeat(33) })).status).toBe(400);
    expect((await s.api('POST', '/rooms/anonymous', { body: { topic: 'a', admin: true } })).status).toBe(400);
    expect((await s.api('POST', '/rooms/anonymous', { raw: '{nope' })).json).toMatchObject({ code: 'bad_request' });
    expect((await s.api('POST', '/rooms/anonymous', { body: { topic: 'x'.repeat(10_000) } })).json).toMatchObject({ code: 'payload_too_large' });
    expect((await s.api('POST', `/rooms/${room.roomId}/admin`, { headers: admin, body: { action: 'explode' } })).status).toBe(400);
    expect((await s.api('GET', `/rooms/${room.roomId}/messages?limit=9999`, { headers: admin })).status).toBe(400);
    const err = await s.api('POST', `/rooms/${room.roomId}/join`, { body: { ...ok, displayName: 'SECRET-VALUE-'.repeat(5) } });
    expect(err.text).not.toContain('SECRET-VALUE'); // validation errors never echo input
  });

  it('create rate limit per IP: 5 per hour; X-Forwarded-For only counts with TRUST_PROXY', async () => {
    s = await boot({ createsPerHour: LIMITS.roomsPerIpPerHour });
    const create = (h: Record<string, string> = {}) => s.api('POST', '/rooms/anonymous', { body: {}, headers: h });
    for (let i = 0; i < 5; i++) expect((await create({ 'x-forwarded-for': `9.9.9.${i}` })).status).toBe(200); // header ignored: same client
    const limited = await create({ 'x-forwarded-for': '1.2.3.4' });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe('rate_limited');
    s.clock.t += 3600_001;
    expect((await create()).status).toBe(200);
    await s.close();

    s = await boot({ cfg: { trustProxy: true }, createsPerHour: 2 });
    for (let i = 0; i < 4; i++) expect((await create({ 'x-forwarded-for': `10.0.0.${i}` })).status).toBe(200); // distinct proxied clients
    for (let i = 0; i < 2; i++) expect((await create({ 'x-forwarded-for': `evil, 10.0.0.77` })).status).toBe(200);
    expect((await create({ 'x-forwarded-for': `other-forged, 10.0.0.77` })).status).toBe(429); // only the proxy-appended entry counts
  });

  it('caps: rooms, agents per room, humans per room, ring size, message rate', async () => {
    s = await boot({ cfg: { maxRooms: 2 }, storeOptions: { maxAgents: 2, ringSize: 5, messagesPerMinute: 4 } });
    const r = await s.mkRoom();
    await s.mkRoom();
    const third = await s.api('POST', '/rooms/anonymous', { body: {} });
    expect([third.status, third.json.code]).toEqual([429, 'rate_limited']);
    const a = await r.join('a'), b = await r.join('b');
    const full = await s.api('POST', `/rooms/${r.room.roomId}/join`, { body: { inviteSecret: r.room.inviteSecret, displayName: 'c', vendor: 'other' } });
    expect([full.status, full.json.code]).toEqual([409, 'room_full']);
    for (let i = 1; i <= 4; i++) await a.call('room_send', { content: `m${i}` });
    const limited = await a.raw('room_send', { content: 'm5' });
    expect([limited.isError, limited.content[0]!.text]).toEqual([true, expect.stringContaining('rate_limited')]);
    s.clock.t += 61_000;
    await a.call('room_send', { content: 'm5' });
    await a.call('room_send', { content: 'm6' });
    const seqs = MessagesResponse.parse((await s.api('GET', `/rooms/${r.room.roomId}/messages`, { headers: r.admin })).json).messages.map((m) => m.seq);
    expect(seqs).toEqual([6, 5, 4, 3, 2]); // ring of 5
    void b;
  });

  it('admin: pause blocks sending, kick revokes, close ends everything', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('a'), b = await r.join('b');
    const act = (body: object) => s.api('POST', `/rooms/${r.room.roomId}/admin`, { headers: r.admin, body });
    const browser = await r.ws('admin');
    expect((await act({ action: 'pause' })).json).toEqual({ ok: true });
    expect(await browser.until((e) => e.type === 'room_paused')).toMatchObject({ paused: true });
    const paused = await a.raw('room_send', { content: 'x' });
    expect(paused.content[0]!.text).toContain('room_paused');
    browser.send({ type: 'send_message', content: 'human while paused' });
    expect(await browser.until((e) => e.type === 'error')).toMatchObject({ code: 'room_paused' });
    await act({ action: 'pause', paused: false });
    await a.call('room_send', { content: 'back' });
    expect((await act({ action: 'approve', participantId: a.participantId })).status).toBe(200); // no-op in 1a
    expect((await act({ action: 'kick', participantId: 'p_nobody' })).status).toBe(400);
    await act({ action: 'kick', participantId: b.participantId });
    expect((await s.api('POST', '/mcp', { headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, raw: '{}' })).status).toBe(401);
    expect(await a.call('room_participants')).toContain('"left":true');
    await act({ action: 'close' });
    expect(await browser.until((e) => e.type === 'room_closed')).toBeTruthy();
    expect(await browser.isClosed()).toBe(true);
    expect((await s.api('GET', `/rooms/${r.room.roomId}`, { headers: r.admin })).json).toMatchObject({ closed: true });
    expect((await s.api('POST', `/rooms/${r.room.roomId}/join`, { body: { inviteSecret: r.room.inviteSecret, displayName: 'late', vendor: 'other' } })).json).toMatchObject({ code: 'room_closed' });
    expect((await s.api('POST', '/mcp', { headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, raw: '{}' })).status).toBe(401);
    expect(MessagesResponse.parse((await s.api('GET', `/rooms/${r.room.roomId}/messages`, { headers: r.admin })).json).messages).toEqual([]); // content is gone
  });

  it('the admin cannot kick their own human: error, room stays open, admin can reconnect', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const w = await r.ws('admin');
    const init = await w.until((e) => e.type === 'init');
    const host = init.type === 'init' ? init.participants.find((p) => p.kind === 'human')!.participantId : '';
    const k = await s.api('POST', `/rooms/${r.room.roomId}/admin`, { headers: r.admin, body: { action: 'kick', participantId: host } });
    expect([k.status, k.json.code]).toEqual([403, 'forbidden_role']);
    await sleep(100);
    expect(w.events.some((e) => e.type === 'room_closed')).toBe(false);
    expect((await s.api('GET', `/rooms/${r.room.roomId}`, { headers: r.admin })).json).toMatchObject({ closed: false });
    const again = await r.ws('admin');
    expect((await again.until((e) => e.type === 'init')).type).toBe('init');
  });
});

describe('WebSocket', () => {
  it('ticket is one-time and expires after 30 s', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const t = WsTicketResponse.parse((await s.api('POST', `/rooms/${r.room.roomId}/ws-ticket`, { headers: r.admin })).json);
    expect([t.role, t.expiresInSeconds]).toEqual(['admin', 30]);
    expect(await r.wsStatus({ ticket: t.ticket })).toBe('open');
    expect(await r.wsStatus({ ticket: t.ticket })).toBe(401); // replay
    const t2 = await r.ticket(r.admin);
    s.clock.t += 31_000;
    expect(await r.wsStatus({ ticket: t2 })).toBe(401); // expired
    expect(await r.wsStatus({ ticket: 'a'.repeat(32) })).toBe(401);
    expect(await r.wsStatus({ ticket: 'short' })).toBe(401);
    expect((await s.api('POST', `/rooms/${r.room.roomId}/ws-ticket`, { headers: { 'x-invite-secret': r.room.inviteSecret } })).status).toBe(403);
    const v = WsTicketResponse.parse((await s.api('POST', `/rooms/${r.room.roomId}/ws-ticket`, { headers: r.view })).json);
    expect(v.role).toBe('viewer');
  });

  it('a ticket only works for the room it was issued for', async () => {
    s = await boot();
    const r1 = await s.mkRoom('one'), r2 = await s.mkRoom('two');
    const w = await r1.ws('admin');
    expect(await w.until((e) => e.type === 'init')).toMatchObject({ topic: 'one' });
    const t = await r2.ticket(r2.admin);
    const other = await r2.ws('admin', { ticket: t });
    expect(await other.until((e) => e.type === 'init')).toMatchObject({ topic: 'two', roomId: r2.room.roomId });
  });

  it('Origin must match Host', async () => {
    s = await boot();
    const r = await s.mkRoom();
    expect(await r.wsStatus({ origin: 'https://evil.example' })).toBe(403);
    expect(await r.wsStatus({ origin: 'null' })).toBe(403);
    expect(await r.wsStatus({ origin: `http://${origin(s.url)}` })).toBe('open');
  });

  it('admin sends as the human; viewers are read-only; secret scan applies; agents see receipts', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('alice');
    const admin = await r.ws('admin'), viewer = await r.ws('view');
    const init = ServerEvent.parse(await admin.until((e) => e.type === 'init'));
    expect(init).toMatchObject({ type: 'init', lastSeq: 0 });
    expect(init.type === 'init' && init.participants.map((p) => p.displayName).sort()).toEqual(['alice', 'host']);

    admin.send({ type: 'send_message', content: 'hello from the human' });
    const m = await viewer.until((e) => e.type === 'message');
    expect(m).toMatchObject({ message: { content: 'hello from the human', relation: 'other', from: { kind: 'human', displayName: 'host' } } });
    const adminMsg = await admin.until((e) => e.type === 'message');
    expect(adminMsg).toMatchObject({ message: { relation: 'own' } }); // the admin browser owns its own human

    viewer.send({ type: 'send_message', content: 'let me in' });
    expect(await viewer.until((e) => e.type === 'error')).toMatchObject({ code: 'forbidden_role' });
    expect((await s.api('GET', `/rooms/${r.room.roomId}/messages`, { headers: r.view })).json.messages).toHaveLength(1);

    admin.send({ type: 'send_message', content: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz' });
    expect(await admin.until((e) => e.type === 'error' && e.code === 'secret_detected')).toBeTruthy();
    admin.send({ type: 'send_message', content: 'x', from: 'system', seq: 1 });
    await admin.until((e) => e.type === 'error' && e.code === 'bad_request');
    admin.send({ type: 'nope' });
    admin.w.send('not json');

    expect(await a.call('room_inbox', { waitSeconds: 0 })).toContain('hello from the human');
    expect(await admin.until((e) => e.type === 'receipt')).toMatchObject({ participantId: a.participantId, seqs: [1] });
    expect(await viewer.until((e) => e.type === 'receipt')).toBeTruthy();
    expect(s.logs.join('\n')).not.toContain('sk-ant-api03');
  });

  it('resume from lastSeq sends only newer messages; a fresh connect gets the recent ring', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('a');
    for (let i = 1; i <= 4; i++) await a.call('room_send', { content: `m${i}` });
    const fresh = await r.ws('view');
    const f = await fresh.until((e) => e.type === 'init');
    expect(f.type === 'init' && f.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    const resumed = await r.ws('view', { lastSeq: 2 });
    const x = await resumed.until((e) => e.type === 'init');
    expect(x.type === 'init' && [x.messages.map((m) => m.seq), x.lastSeq]).toEqual([[3, 4], 4]);
  });

  it('closing warning 60 s before expiry; expiry sweep closes sockets and revokes tokens', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('a');
    const w = await r.ws('admin'), v = await r.ws('view');
    s.clock.t = T0 + LIMITS.roomTtlMs - 30_000;
    await s.app.store.sweep();
    expect(await w.until((e) => e.type === 'room_closing')).toMatchObject({ expiresAt: T0 + LIMITS.roomTtlMs });
    expect(w.events.filter((e) => e.type === 'room_closing')).toHaveLength(1);
    await s.app.store.sweep();
    expect(w.events.filter((e) => e.type === 'room_closing')).toHaveLength(1); // once
    expect(await w.isClosed(200)).toBe(false);
    s.clock.t = T0 + LIMITS.roomTtlMs; // never refreshed by activity
    await a.call('room_send', { content: 'x' }).catch(() => {});
    await s.app.store.sweep();
    expect(await w.until((e) => e.type === 'room_closed')).toBeTruthy();
    expect(await w.isClosed()).toBe(true);
    expect(await v.isClosed()).toBe(true);
    expect((await s.api('GET', `/rooms/${r.room.roomId}`, { headers: r.admin })).status).toBe(404);
    expect((await s.api('POST', '/mcp', { headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, raw: '{}' })).status).toBe(401);
  });

  it('admin reconnects reuse one stable human: no ghosts, no cap exhaustion, tabs share it', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const tab1 = await r.ws('admin');
    await tab1.until((e) => e.type === 'init');
    for (let i = 0; i < 60; i++) {
      const t = await r.ws('admin');
      await t.until((e) => e.type === 'init');
      t.w.close();
      await t.isClosed();
    }
    const info = await s.app.store.getRoom(r.room.roomId);
    expect(info!.participants.filter((p) => p.kind === 'human')).toHaveLength(1);
    expect(info!.participants.find((p) => p.kind === 'human')).toMatchObject({ displayName: 'host', left: false }); // tab1 still holds it
    const a = await r.join('agent-after-reconnects'); // the room is not full
    expect(a.displayName).toBe('agent-after-reconnects');
    tab1.w.close();
    await tab1.isClosed();
    await sleep(50);
    expect((await s.app.store.getRoom(r.room.roomId))!.participants.find((p) => p.kind === 'human')!.left).toBe(true); // last tab gone
    const back = await r.ws('admin');
    await back.until((e) => e.type === 'init');
    expect((await s.app.store.getRoom(r.room.roomId))!.participants.filter((p) => p.kind === 'human')).toMatchObject([{ left: false }]);
  });

  it('expiry wakes a waiting long-poll at once', async () => {
    s = await boot();
    const r = await s.mkRoom();
    const a = await r.join('a');
    const t0 = Date.now();
    const poll = fetch(`${s.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'room_inbox', arguments: { waitSeconds: 20 } } }) }).then((x) => x.text());
    await sleep(200);
    s.clock.t = T0 + LIMITS.roomTtlMs;
    await s.app.store.sweep();
    await poll;
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('resume with a gap larger than one batch sends the newest batch, not the oldest', async () => {
    s = await boot({ storeOptions: { messagesPerMinute: 10_000 } });
    const r = await s.mkRoom();
    const a = await r.join('a');
    for (let i = 1; i <= 600; i++) await s.app.store.send(r.room.roomId, a.participantId, { content: `m${i}` });
    const w = await r.ws('view', { lastSeq: 10 });
    const init = await w.until((e) => e.type === 'init');
    expect(init.type === 'init' && [init.messages.length, init.messages[0]!.seq, init.messages.at(-1)!.seq, init.lastSeq]).toEqual([500, 101, 600, 600]);
  });
});
