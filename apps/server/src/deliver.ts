import { type DeliveredMessage, type StoredMessage, relationOf } from '@agent-otter/protocol';
import type { Names } from './store.js';

/** Browser/REST form of a message for one recipient: relation computed here, ownerId dropped, mentions as names. Agents get wrapDelivery instead. */
export const toDelivered = (m: StoredMessage, names: Names, recipientOwnerId: string): DeliveredMessage => ({
  roomId: m.roomId, seq: m.seq, id: m.id, ts: m.ts,
  from: { kind: m.from.kind, participantId: m.from.participantId, displayName: m.from.displayName, ...(m.from.vendor && { vendor: m.from.vendor }) },
  relation: relationOf(m.from.ownerId, recipientOwnerId, m.from.kind),
  content: m.content === null || m.deletedAt ? '[deleted]' : m.content,
  mentions: m.mentions.flatMap((p) => names.get(p) ?? []),
  ...(m.replyTo && { replyTo: m.replyTo }),
  ...(m.deletedAt && { deletedAt: m.deletedAt }),
});
