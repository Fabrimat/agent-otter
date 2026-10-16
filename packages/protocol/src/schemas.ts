// Everything that crosses a process boundary is defined here (ARCHITECTURE sections 6, 8, 11).
import * as z from 'zod/v4';

/** Default limits (ARCHITECTURE section 11, anonymous column). All configurable server-side; these are the protocol-level caps. */
export const LIMITS = {
  contentBytes: 16 * 1024,
  topicChars: 300,
  displayNameChars: 32,
  vendorChars: 24,
  roomTtlMs: 3600_000,
  agentsPerRoom: 5,
  humansPerRoom: 5,
  messagesPerMinutePerRoom: 60,
  ringSize: 1000,
  roomsPerIpPerHour: 5,
  inboxWaitMaxSeconds: 25,
  inboxLimitMax: 50,
  historyLimitDefault: 20,
  historyLimitMax: 50,
  clientMsgIdChars: 64,
} as const;

export const Vendor = z.enum(['claude-code', 'codex', 'opencode', 'hermes', 'other']);
export type Vendor = z.infer<typeof Vendor>;

export const Relation = z.enum(['own', 'other', 'system']);
export type Relation = z.infer<typeof Relation>;

const Kind = z.enum(['agent', 'human', 'system']);
const utf8 = new TextEncoder();
const Content = z.string().min(1).max(LIMITS.contentBytes).refine((s) => utf8.encode(s).length <= LIMITS.contentBytes, `content exceeds ${LIMITS.contentBytes} bytes`);
const Seq = z.number().int().min(0);
const Id = z.string().min(1).max(64);

export const StoredMessage = z.object({
  roomId: z.string(),
  seq: Seq,
  id: z.string(),
  ts: z.number().int(),
  from: z.object({
    kind: Kind,
    participantId: z.string(),
    ownerId: z.string(),
    displayName: z.string(),
    vendor: Vendor.optional(),
  }),
  content: z.string().nullable(),
  mentions: z.array(z.string()).max(32),
  replyTo: z.string().optional(),
  originId: z.string().optional(),
  hops: z.number().int().min(0),
  viaDoor: z.string().optional(),
  topicId: z.string().optional(),
  deletedAt: z.number().int().optional(),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

/** What a recipient (browser or agent) sees: no ownerId, relation computed for that recipient, mentions as display names. */
export const DeliveredMessage = z.object({
  roomId: z.string(),
  seq: Seq,
  id: z.string(),
  ts: z.number().int(),
  from: z.object({ kind: Kind, participantId: z.string(), displayName: z.string(), vendor: Vendor.optional() }),
  relation: Relation,
  content: z.string().nullable(),
  mentions: z.array(z.string()),
  replyTo: z.string().optional(),
  deletedAt: z.number().int().optional(),
});
export type DeliveredMessage = z.infer<typeof DeliveredMessage>;

export const ParticipantInfo = z.object({
  participantId: z.string(),
  displayName: z.string(),
  kind: z.enum(['agent', 'human']),
  vendor: Vendor.optional(),
  deliveryMode: z.enum(['pull', 'push']).optional(),
  lastSeen: z.number().int().nullable(),
  left: z.boolean(),
});
export type ParticipantInfo = z.infer<typeof ParticipantInfo>;

/** Phase 1a error codes, used by REST ErrorResponse and the WS `error` event. */
export const ErrorCode = z.enum([
  'bad_request', 'bad_secret', 'room_not_found', 'room_closed', 'room_paused', 'rate_limited', 'secret_detected',
  'name_taken', 'reserved_name', 'payload_too_large', 'forbidden_role', 'bad_ticket', 'room_full', 'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ---- REST (strict: clients cannot smuggle server-owned fields) ----
export const CreateRoomRequest = z.strictObject({ topic: z.string().max(LIMITS.topicChars).optional() });
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;
export const CreateRoomResponse = z.object({
  roomId: z.string(),
  inviteSecret: z.string(),
  adminSecret: z.string(),
  viewSecret: z.string(), // read-only transcript link secret
  expiresAt: z.number().int(),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

export const JoinRequest = z.strictObject({
  inviteSecret: z.string().min(1),
  displayName: z.string().min(1).max(LIMITS.displayNameChars),
  vendor: Vendor,
});
export type JoinRequest = z.infer<typeof JoinRequest>;
export const JoinResponse = z.object({
  participantId: z.string(),
  token: z.string(),
  displayName: z.string(),
  vendor: Vendor,
  cursorStartsAt: Seq,
  snippets: z.object({
    claudeCode: z.string(),
    claudeCodePowerShell: z.string(),
    codexConfigToml: z.string(),
    codexEnv: z.string(),
    codexPowerShell: z.string(),
    pathFallbackUrl: z.string(),
  }),
  note: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponse>;

export const AdminAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), participantId: z.string() }),
  z.strictObject({ action: z.literal('kick'), participantId: z.string() }),
  z.strictObject({ action: z.literal('close') }),
  z.strictObject({ action: z.literal('pause'), paused: z.boolean().default(true) }),
]);
export type AdminAction = z.infer<typeof AdminAction>;

// ---- WebSocket ----
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), roomId: z.string(), topic: z.string(), expiresAt: z.number().int(), participants: z.array(ParticipantInfo), messages: z.array(DeliveredMessage), lastSeq: Seq }),
  z.object({ type: z.literal('message'), message: DeliveredMessage }),
  z.object({ type: z.literal('participants'), participants: z.array(ParticipantInfo) }),
  z.object({ type: z.literal('receipt'), participantId: z.string(), seqs: z.array(Seq), at: z.number().int() }),
  z.object({ type: z.literal('room_paused'), paused: z.boolean() }),
  z.object({ type: z.literal('room_closing'), expiresAt: z.number().int() }),
  z.object({ type: z.literal('room_closed'), reason: z.string().optional() }),
  z.object({ type: z.literal('error'), code: ErrorCode, message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const ClientCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('send_message'), content: Content, replyTo: Id.optional(), clientMsgId: z.string().max(LIMITS.clientMsgIdChars).optional() }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

// ---- MCP tools (z.object: unknown keys from a model are stripped, never trusted) ----
export const RoomSendInput = z.object({ content: Content, replyTo: Id.optional(), clientMsgId: z.string().max(LIMITS.clientMsgIdChars).optional() });
export const RoomInboxInput = z.object({
  sinceSeq: Seq.optional(),
  limit: z.number().int().min(1).max(LIMITS.inboxLimitMax).optional(),
  waitSeconds: z.number().min(0).max(LIMITS.inboxWaitMaxSeconds).optional(),
});
export const RoomHistoryInput = z.object({ beforeSeq: Seq.optional(), limit: z.number().int().min(1).max(LIMITS.historyLimitMax).optional() });
export const RoomParticipantsInput = z.object({});
export const RoomParticipantsOutput = z.object({ you: z.string(), topic: z.string(), participants: z.array(ParticipantInfo) });
export const RoomLeaveInput = z.object({});
export const RoomLeaveOutput = z.object({ left: z.literal(true) });
