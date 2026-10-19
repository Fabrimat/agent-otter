import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-otter/protocol';
import { initialRoomState, roomReducer } from '../src/roomState';
import { backoffMs, parseFrame } from '../src/useRoomSocket';
import { ROOM, msg, person } from './fixtures';

const run = (events: ServerEvent[]) => events.reduce(roomReducer, initialRoomState);
const init = (messages = [msg(0), msg(1)], lastSeq = 1): ServerEvent => ({
  type: 'init', roomId: ROOM, topic: 'T', expiresAt: 5, participants: [person()], messages, lastSeq,
});

describe('roomReducer', () => {
  it('init sets room and messages', () => {
    const s = run([init()]);
    expect(s).toMatchObject({ ready: true, topic: 'T', expiresAt: 5, lastSeq: 1 });
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it('dedupes by seq and keeps order', () => {
    const s = run([init(), { type: 'message', message: msg(1) }, { type: 'message', message: msg(3) }, { type: 'message', message: msg(2) }]);
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(s.lastSeq).toBe(3);
  });

  it('resume: second init merges, does not lose or duplicate', () => {
    const s = run([init(), { type: 'message', message: msg(2) }, init([msg(2), msg(3)], 3)]);
    expect(s.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(s.lastSeq).toBe(3);
  });

  it('tombstone replaces a live message', () => {
    const s = run([init(), { type: 'message', message: msg(1, { content: '[deleted]', deletedAt: 9 }) }]);
    expect(s.messages[1]?.deletedAt).toBe(9);
  });

  it('receipts accumulate per seq and participant', () => {
    const s = run([init(), { type: 'receipt', participantId: 'p1', seqs: [0, 1], at: 100 }, { type: 'receipt', participantId: 'p2', seqs: [1], at: 200 }]);
    expect(s.receipts).toEqual({ 0: { p1: 100 }, 1: { p1: 100, p2: 200 } });
  });

  it('paused, closing, closed', () => {
    let s = run([init(), { type: 'room_paused', paused: true }]);
    expect(s.paused).toBe(true);
    s = roomReducer(s, { type: 'room_paused', paused: false });
    expect(s.paused).toBe(false);
    s = roomReducer(s, { type: 'room_closing', expiresAt: 77 });
    expect(s).toMatchObject({ closing: true, expiresAt: 77 });
    s = roomReducer(s, { type: 'room_closed', reason: 'expired' });
    expect(s).toMatchObject({ closed: true, closing: false, closedReason: 'expired' });
  });

  it('error event is recorded', () => {
    expect(run([{ type: 'error', code: 'forbidden_role', message: 'no' }]).error).toEqual({ code: 'forbidden_role', message: 'no' });
  });
});

describe('socket frames', () => {
  it('accepts a valid frame', () => {
    expect(parseFrame(JSON.stringify({ type: 'room_paused', paused: true }))).toEqual({ type: 'room_paused', paused: true });
  });

  it('rejects malformed frames', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'message', message: { seq: 'x' } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'error', code: 'made_up', message: 'x' }))).toBeNull();
    expect(parseFrame(new ArrayBuffer(2))).toBeNull();
  });

  it('backoff grows and caps', () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(20)).toBe(15_000);
  });
});
