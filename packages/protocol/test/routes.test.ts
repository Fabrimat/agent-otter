import { describe, expect, it } from 'vitest';
import {
  AGENT_TOKEN, ErrorCode, ErrorResponse, HEADERS, MessagesQuery, MessagesResponse, ROOM_ID, ROUTES, RoomPublicInfo, SECRET, ServerEvent, WsQuery, WsTicketResponse,
} from '../src/index.js';

const id = 'abcdef012345';
const ticket = 'a'.repeat(32);

describe('routes', () => {
  it('path builders', () => {
    expect(ROUTES.createRoom).toBe('/rooms/anonymous');
    expect(ROUTES.room(id)).toBe(`/rooms/${id}`);
    expect(ROUTES.join(id)).toBe(`/rooms/${id}/join`);
    expect(ROUTES.admin(id)).toBe(`/rooms/${id}/admin`);
    expect(ROUTES.wsTicket(id)).toBe(`/rooms/${id}/ws-ticket`);
    expect(ROUTES.messages(id)).toBe(`/rooms/${id}/messages`);
    expect(ROUTES.messages(id, { beforeSeq: 10, limit: 20 })).toBe(`/rooms/${id}/messages?beforeSeq=10&limit=20`);
    expect(ROUTES.ws(ticket)).toBe(`/ws?ticket=${ticket}`);
    expect(ROUTES.ws(ticket, 7)).toBe(`/ws?ticket=${ticket}&lastSeq=7`);
    expect(ROUTES.mcp).toBe('/mcp');
    expect(ROUTES.mcpFallback('t'.repeat(32))).toBe('/mcp/' + 't'.repeat(32));
  });
  it('mcpFallback and ws validate formats', () => {
    for (const t of ['../rooms/x', 'a?b', 'short', 'a/b' + 'x'.repeat(30), '']) expect(() => ROUTES.mcpFallback(t), t).toThrow();
    expect(ROUTES.mcpFallback('t'.repeat(32))).toBe('/mcp/' + 't'.repeat(32));
    expect(() => ROUTES.ws('nope')).toThrow();
    expect(() => ROUTES.ws(ticket + '&x=1')).toThrow();
  });
  it('strict digit queries', () => {
    for (const bad of ['', '1e3', '0x10', '-1', ' 1', '1.5']) {
      expect(MessagesQuery.safeParse({ beforeSeq: bad }).success, bad).toBe(false);
      expect(MessagesQuery.safeParse({ limit: bad }).success, bad).toBe(false);
      expect(WsQuery.safeParse({ ticket, lastSeq: bad }).success, bad).toBe(false);
    }
    expect(MessagesQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
  it('builders reject malformed room ids (path injection)', () => {
    expect(() => ROUTES.room('../x')).toThrow();
    expect(() => ROUTES.join('abc')).toThrow();
  });
  it('formats and headers', () => {
    expect(ROOM_ID.test(id)).toBe(true);
    expect(ROOM_ID.test(id + 'a')).toBe(false);
    expect(SECRET.test('0'.repeat(32))).toBe(true);
    expect(SECRET.test('G'.repeat(32))).toBe(false);
    expect(AGENT_TOKEN.test('a_b-'.repeat(8))).toBe(true);
    expect(AGENT_TOKEN.test('a b'.repeat(12))).toBe(false);
    expect(HEADERS).toEqual({ invite: 'x-invite-secret', view: 'x-view-secret', admin: 'x-admin-secret', create: 'x-create-key' });
  });
  it('query schemas coerce and cap', () => {
    expect(MessagesQuery.parse({ beforeSeq: '5', limit: '50' })).toEqual({ beforeSeq: 5, limit: 50 });
    expect(MessagesQuery.parse({})).toEqual({});
    expect(MessagesQuery.safeParse({ limit: '51' }).success).toBe(false);
    expect(MessagesQuery.safeParse({ beforeSeq: '-1' }).success).toBe(false);
    expect(WsQuery.parse({ ticket, lastSeq: '3' })).toEqual({ ticket, lastSeq: 3 });
    expect(WsQuery.safeParse({ ticket: 'short' }).success).toBe(false);
  });
  it('responses', () => {
    expect(ErrorResponse.safeParse({ error: 'x', code: 'bad_secret' }).success).toBe(true);
    expect(ErrorResponse.safeParse({ error: 'x', code: 'nope' }).success).toBe(false);
    expect(ErrorCode.options).toEqual(expect.arrayContaining(['create_forbidden', 'create_disabled', 'bad_secret', 'room_not_found', 'room_closed', 'rate_limited', 'secret_detected', 'name_taken', 'reserved_name', 'payload_too_large', 'forbidden_role']));
    expect(WsTicketResponse.safeParse({ ticket, role: 'viewer', expiresInSeconds: 30 }).success).toBe(true);
    expect(WsTicketResponse.safeParse({ ticket, role: 'root', expiresInSeconds: 30 }).success).toBe(false);
    expect(RoomPublicInfo.safeParse({ roomId: id, topic: '', expiresAt: 1, participants: [], paused: false, closed: false }).success).toBe(true);
    expect(RoomPublicInfo.safeParse({ roomId: id, kind: 'permanent', topic: '', expiresAt: null, participants: [], paused: false, closed: false }).success).toBe(true);
    expect(RoomPublicInfo.safeParse({ roomId: id }).success).toBe(false);
    expect(MessagesResponse.safeParse({ messages: [], hasMore: false }).success).toBe(true);
    expect(ServerEvent.safeParse({ type: 'error', code: 'forbidden_role', message: 'viewers cannot send' }).success).toBe(true);
    expect(ServerEvent.safeParse({ type: 'error', code: 'zzz', message: 'x' }).success).toBe(false);
  });
});
