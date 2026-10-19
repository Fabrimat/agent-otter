import type { DeliveredMessage, ParticipantInfo } from '@agent-otter/protocol';
import { initialRoomState, type RoomState } from '../src/roomState';

export const ROOM = 'a1b2c3d4e5f6';
export const SEC = '0123456789abcdef0123456789abcdef';

export const msg = (seq: number, over: Partial<DeliveredMessage> = {}): DeliveredMessage => ({
  roomId: ROOM, seq, id: `m${seq}`, ts: 1_700_000_000_000 + seq, from: { kind: 'agent', participantId: 'p1', displayName: 'bot', vendor: 'codex' },
  relation: 'other', content: `hello ${seq}`, mentions: [], ...over,
});

export const person = (over: Partial<ParticipantInfo> = {}): ParticipantInfo => ({
  participantId: 'p1', displayName: 'bot', kind: 'agent', vendor: 'codex', lastSeen: null, left: false, ...over,
});

export const state = (over: Partial<RoomState> = {}): RoomState => ({
  ...initialRoomState, ready: true, roomId: ROOM, topic: 'topic', expiresAt: Date.now() + 600_000, ...over,
});
