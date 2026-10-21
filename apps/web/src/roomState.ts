// Pure reducer for live room state. Input is only zod-validated ServerEvents.
import type { DeliveredMessage, ErrorCode, ParticipantInfo, ServerEvent } from '@lesscubicles/protocol';

export type RoomState = {
  ready: boolean;
  roomId: string;
  topic: string;
  expiresAt: number | null; // null = permanent room
  participants: ParticipantInfo[];
  messages: DeliveredMessage[]; // sorted by seq, unique seq
  lastSeq: number;
  paused: boolean;
  closing: boolean;
  closed: boolean;
  closedReason?: string;
  /** receipts[seq][participantId] = seen-at (ms) */
  receipts: Record<number, Record<string, number>>;
  error?: { code: ErrorCode; message: string };
};

export const initialRoomState: RoomState = {
  ready: false, roomId: '', topic: '', expiresAt: 0, participants: [], messages: [], lastSeq: -1, paused: false, closing: false, closed: false, receipts: {},
};

function merge(have: DeliveredMessage[], incoming: DeliveredMessage[]): DeliveredMessage[] {
  const bySeq = new Map(have.map((m) => [m.seq, m]));
  for (const m of incoming) {
    const old = bySeq.get(m.seq);
    if (!old || (m.deletedAt !== undefined && old.deletedAt === undefined)) bySeq.set(m.seq, m); // dedupe by seq; a tombstone may replace
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function roomReducer(s: RoomState, e: ServerEvent): RoomState {
  switch (e.type) {
    case 'init': {
      const messages = merge(s.messages, e.messages);
      return {
        ...s, ready: true, roomId: e.roomId, topic: e.topic, expiresAt: e.expiresAt, participants: e.participants, messages,
        lastSeq: Math.max(s.lastSeq, e.lastSeq, messages.at(-1)?.seq ?? -1), error: undefined,
      };
    }
    case 'message': {
      const messages = merge(s.messages, [e.message]);
      return { ...s, messages, lastSeq: Math.max(s.lastSeq, e.message.seq) };
    }
    case 'participants':
      return { ...s, participants: e.participants };
    case 'receipt': {
      const receipts = { ...s.receipts };
      for (const q of e.seqs) receipts[q] = { ...receipts[q], [e.participantId]: Math.max(receipts[q]?.[e.participantId] ?? 0, e.at) };
      return { ...s, receipts };
    }
    case 'room_paused':
      return { ...s, paused: e.paused };
    case 'room_closing':
      return { ...s, closing: true, expiresAt: e.expiresAt };
    case 'room_closed':
      return { ...s, closed: true, closing: false, closedReason: e.reason };
    case 'error':
      return { ...s, error: { code: e.code, message: e.message } };
  }
}
