// Single REST/WS/MCP contract for phase 1a: apps/server and apps/web both code against this file.
import * as z from 'zod/v4';
import { DeliveredMessage, ErrorCode, LIMITS, ParticipantInfo } from './schemas.js';

// ---- formats (the server generates hex ids/secrets of exactly these lengths; both sides validate with these) ----
export const ROOM_ID = /^[0-9a-f]{12}$/;
export const SECRET = /^[0-9a-f]{32}$/; // invite, view, admin secrets
export const TICKET = /^[0-9a-f]{32}$/;
export const AGENT_TOKEN = /^[A-Za-z0-9_-]{32,64}$/; // 32 to 64 chars of base64url/hex

// ---- headers ----
export const HEADERS = { invite: 'x-invite-secret', view: 'x-view-secret', admin: 'x-admin-secret' } as const;

// ---- paths ----
const rid = (id: string) => {
  if (!ROOM_ID.test(id)) throw new Error('invalid room id');
  return id;
};
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Express-style patterns (`:id`) for the server router; builders for clients. */
export const ROUTES = {
  createRoom: '/rooms/anonymous', // POST
  room: (id: string) => `/rooms/${rid(id)}`, // GET
  join: (id: string) => `/rooms/${rid(id)}/join`, // POST
  admin: (id: string) => `/rooms/${rid(id)}/admin`, // POST
  messages: (id: string, q: { beforeSeq?: number; limit?: number } = {}) => `/rooms/${rid(id)}/messages${qs(q)}`, // GET
  wsTicket: (id: string) => `/rooms/${rid(id)}/ws-ticket`, // POST
  ws: (ticket: string, lastSeq?: number) => {
    if (!TICKET.test(ticket)) throw new Error('invalid ticket');
    return `/ws${qs({ ticket, lastSeq })}`; // WebSocket upgrade
  },
  mcp: '/mcp', // Authorization: Bearer <token>
  mcpFallback: (token: string) => {
    if (!AGENT_TOKEN.test(token)) throw new Error('invalid token');
    return `/mcp/${token}`;
  },
  patterns: {
    room: '/rooms/:id', join: '/rooms/:id/join', admin: '/rooms/:id/admin', messages: '/rooms/:id/messages', wsTicket: '/rooms/:id/ws-ticket', mcpFallback: '/mcp/:token',
  },
} as const;

// ---- shared shapes ----
export const ErrorResponse = z.object({ error: z.string(), code: ErrorCode.optional() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** POST /rooms/anonymous: body CreateRoomRequest, response CreateRoomResponse (schemas.ts). */

/** GET /rooms/:id. Header accepted: exactly one of HEADERS.invite | view | admin (any of the three). */
export const RoomPublicInfo = z.object({
  roomId: z.string(), topic: z.string(), expiresAt: z.number().int(), participants: z.array(ParticipantInfo), paused: z.boolean(), closed: z.boolean(),
});
export type RoomPublicInfo = z.infer<typeof RoomPublicInfo>;

/** POST /rooms/:id/join: body JoinRequest, response JoinResponse (schemas.ts). */
/** POST /rooms/:id/admin: header accepted: HEADERS.admin ONLY. Body AdminAction (schemas.ts). `approve` is accepted but a no-op in 1a (joins are open). */
export const AdminResponse = z.object({ ok: z.literal(true) });

/**
 * GET /rooms/:id/messages. Header accepted: HEADERS.admin | view ONLY (not invite).
 * Browser response: tombstoned messages carry the literal string '[deleted]' in `content`; the server must substitute it
 * (null is only the stored form and must never be sent to browsers).
 */
const digits = z.string().regex(/^\d+$/).transform(Number); // strict: rejects '', '1e3', '0x10', '-1', ' 1'
export const MessagesQuery = z.object({
  beforeSeq: digits.pipe(z.number().int().min(0)).optional(),
  limit: digits.pipe(z.number().int().min(1).max(LIMITS.historyLimitMax)).optional(),
});
/**
 * Paging contract: `messages` are ordered NEWEST FIRST (descending seq). `beforeSeq` is exclusive
 * (returns seq < beforeSeq); `hasMore` says older messages exist. Clients that render oldest-first reverse them.
 */
export const MessagesResponse = z.object({ messages: z.array(DeliveredMessage), hasMore: z.boolean() });
export type MessagesResponse = z.infer<typeof MessagesResponse>;

/**
 * POST /rooms/:id/ws-ticket. Header accepted: HEADERS.admin | view ONLY (not invite). Ticket is one-time and short-lived,
 * bound server-side to exactly one room and one role (the role follows the secret used here).
 */
export const WsTicketResponse = z.object({ ticket: z.string().regex(TICKET), role: z.enum(['admin', 'viewer']), expiresInSeconds: z.number().int().positive() });
export type WsTicketResponse = z.infer<typeof WsTicketResponse>;

/**
 * WS /ws?ticket=&lastSeq=. Events: ServerEvent, commands: ClientCommand. The ticket fixes room and role.
 * A viewer's `send_message` must produce `{type:'error', code:'forbidden_role', message}`; an admin-role sender is the room's human participant.
 */
export const WsQuery = z.object({ ticket: z.string().regex(TICKET), lastSeq: digits.pipe(z.number().int().min(0)).optional() });
