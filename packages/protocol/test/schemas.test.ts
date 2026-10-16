import { describe, expect, it } from 'vitest';
import {
  AdminAction, ClientCommand, CreateRoomRequest, JoinRequest, LIMITS, RoomHistoryInput, RoomInboxInput, RoomSendInput, ServerEvent, StoredMessage, Vendor,
} from '../src/index.js';

describe('schemas', () => {
  it('StoredMessage parses the 6.1 shape and rejects bad kinds', () => {
    const ok = { roomId: 'r', seq: 1, id: 'i', ts: 1, from: { kind: 'agent', participantId: 'p', ownerId: 'o', displayName: 'n', vendor: 'codex' }, content: null, mentions: [], hops: 0 };
    expect(StoredMessage.safeParse(ok).success).toBe(true);
    expect(StoredMessage.safeParse({ ...ok, from: { ...ok.from, kind: 'god' } }).success).toBe(false);
    expect(StoredMessage.safeParse({ ...ok, seq: -1 }).success).toBe(false);
  });
  it('Vendor', () => {
    expect(Vendor.safeParse('claude-code').success).toBe(true);
    expect(Vendor.safeParse('human').success).toBe(false);
  });
  it('clients cannot supply from/ts/seq/hops (WS command and REST are strict)', () => {
    for (const extra of [{ from: { kind: 'system' } }, { ts: 1 }, { seq: 1 }, { hops: 0 }, { viaDoor: 'd' }, { originId: 'x' }]) {
      expect(ClientCommand.safeParse({ type: 'send_message', content: 'hi', ...extra }).success).toBe(false);
    }
    expect(ClientCommand.safeParse({ type: 'send_message', content: 'hi' }).success).toBe(true);
    expect(JoinRequest.safeParse({ inviteSecret: 's', displayName: 'a', vendor: 'codex', ownerId: 'x' }).success).toBe(false);
    expect(CreateRoomRequest.safeParse({ topic: 't', adminSecret: 'x' }).success).toBe(false);
  });
  it('MCP inputs strip server-owned fields instead of passing them on', () => {
    const r = RoomSendInput.parse({ content: 'hi', from: { kind: 'system' }, seq: 5, ts: 1 });
    expect(r).toEqual({ content: 'hi' });
  });
  it('content size limit is in bytes', () => {
    expect(RoomSendInput.safeParse({ content: 'a'.repeat(LIMITS.contentBytes) }).success).toBe(true);
    expect(RoomSendInput.safeParse({ content: 'a'.repeat(LIMITS.contentBytes + 1) }).success).toBe(false);
    expect(RoomSendInput.safeParse({ content: 'é'.repeat(LIMITS.contentBytes / 2 + 1) }).success).toBe(false);
    expect(RoomSendInput.safeParse({ content: '' }).success).toBe(false);
  });
  it('room_inbox / room_history caps', () => {
    expect(RoomInboxInput.safeParse({ waitSeconds: 25 }).success).toBe(true);
    expect(RoomInboxInput.safeParse({ waitSeconds: 26 }).success).toBe(false);
    expect(RoomInboxInput.safeParse({ sinceSeq: -1 }).success).toBe(false);
    expect(RoomInboxInput.safeParse({ sinceSeq: 1.5 }).success).toBe(false);
    expect(RoomHistoryInput.safeParse({ limit: 50 }).success).toBe(true);
    expect(RoomHistoryInput.safeParse({ limit: 51 }).success).toBe(false);
    expect(RoomHistoryInput.safeParse({ beforeSeq: 10, limit: 0 }).success).toBe(false);
  });
  it('JoinRequest validation', () => {
    expect(JoinRequest.safeParse({ inviteSecret: 's', displayName: 'a', vendor: 'codex' }).success).toBe(true);
    expect(JoinRequest.safeParse({ inviteSecret: 's', displayName: 'a'.repeat(33), vendor: 'codex' }).success).toBe(false);
    expect(JoinRequest.safeParse({ inviteSecret: 's', displayName: 'a', vendor: 'human' }).success).toBe(false);
  });
  it('AdminAction', () => {
    expect(AdminAction.safeParse({ action: 'approve', participantId: 'p' }).success).toBe(true);
    expect(AdminAction.safeParse({ action: 'approve' }).success).toBe(false);
    expect(AdminAction.safeParse({ action: 'delete' }).success).toBe(false);
    expect(AdminAction.parse({ action: 'pause' })).toEqual({ action: 'pause', paused: true });
  });
  it('ServerEvent variants', () => {
    expect(ServerEvent.safeParse({ type: 'room_closed' }).success).toBe(true);
    expect(ServerEvent.safeParse({ type: 'receipt', participantId: 'p', seqs: [1], at: 1 }).success).toBe(true);
    expect(ServerEvent.safeParse({ type: 'bogus' }).success).toBe(false);
  });
});
