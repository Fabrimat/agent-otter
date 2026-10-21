// Everything that crosses a process boundary is defined here (ARCHITECTURE sections 6, 8, 11).
import * as z from 'zod/v4';

const BYTE_CAP = 48 * 1024; // per room_inbox / room_history / cubicle_read call; a whole cubicle (cubicleBytes) fits one read by construction

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
  byteCap: BYTE_CAP,
  cubiclePageBytes: 16 * 1024,
  cubiclePages: 8, // per cubicle
  cubicleBytes: BYTE_CAP, // per cubicle, sum of pages
  cubicleBytesPerRoom: 1024 * 1024, // all cubicles of a room, departed ones included
  cubicleWritesPerMinute: 20, // per participant
} as const;

export const Vendor = z.enum(['claude-code', 'codex', 'opencode', 'hermes', 'other']);
export type Vendor = z.infer<typeof Vendor>;

export const Relation = z.enum(['own', 'other', 'system']);
export type Relation = z.infer<typeof Relation>;

const Kind = z.enum(['agent', 'human', 'system']);
const utf8 = new TextEncoder();
const Text = (bytes: number) => z.string().min(1).max(bytes).refine((s) => utf8.encode(s).length <= bytes, `content exceeds ${bytes} bytes`);
const Content = Text(LIMITS.contentBytes);
export const PARTICIPANT_ID = /^p_[0-9a-f]{12}$/; // lives here (not routes.ts) because routes.ts imports this file
export const PageName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,31}$/);
export const Visibility = z.enum(['owner', 'room']);
export type Visibility = z.infer<typeof Visibility>;
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
  'create_forbidden', 'create_disabled', // additive: room-creation gate (wrong/missing key, creation switched off)
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ---- REST (strict: clients cannot smuggle server-owned fields) ----
export const CreateRoomRequest = z.strictObject({ topic: z.string().max(LIMITS.topicChars).optional() });
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;
export const RoomKind = z.enum(['anonymous', 'permanent']);
export type RoomKind = z.infer<typeof RoomKind>;
export const CreateRoomResponse = z.object({
  roomId: z.string(),
  kind: RoomKind.default('anonymous'), // additive: older clients and fixtures without it mean anonymous
  inviteSecret: z.string(),
  adminSecret: z.string(),
  viewSecret: z.string(), // read-only transcript link secret
  expiresAt: z.number().int().nullable(), // null: permanent rooms never expire
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
    pathFallbackUrl: z.string().optional(), // absent for permanent rooms: their tokens never go in URLs (THREAT-MODEL T-04)
  }),
  note: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponse>;

export const AdminAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), participantId: z.string() }),
  z.strictObject({ action: z.literal('kick'), participantId: z.string() }),
  z.strictObject({ action: z.literal('close') }),
  z.strictObject({ action: z.literal('pause'), paused: z.boolean().default(true) }),
  z.strictObject({ action: z.literal('erase'), seq: z.number().int().min(1) }), // tombstone one message: content gone, seq kept
  // hard-delete a cubicle (or one page of it); participantId omitted = every departed participant's cubicle (then `page` is not allowed)
  z.strictObject({ action: z.literal('erase_cubicle'), participantId: z.string().regex(PARTICIPANT_ID).optional(), page: PageName.optional() }),
]);
export type AdminAction = z.infer<typeof AdminAction>;

// ---- WebSocket ----
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), roomId: z.string(), topic: z.string(), expiresAt: z.number().int().nullable(), participants: z.array(ParticipantInfo), messages: z.array(DeliveredMessage), lastSeq: Seq }),
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

export const CubicleListInput = z.object({});
export const CubicleReadInput = z.object({ participantId: z.string().regex(PARTICIPANT_ID).optional(), page: PageName.optional() }); // default: own cubicle, all pages
export const CubicleWriteInput = z.object({ page: PageName.default('notes'), content: Text(LIMITS.cubiclePageBytes), visibility: Visibility.optional() });
export const CubicleDeleteInput = z.object({ page: PageName.optional() }); // omit = the whole cubicle
