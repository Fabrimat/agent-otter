// REST client for the protocol contract. Secrets travel only in headers, never in URLs; every response is zod-validated.
import {
  AdminResponse, CreateRoomResponse, ErrorResponse, HEADERS, JoinResponse, MessagesResponse, PublicConfig, ROUTES, RoomPublicInfo, WsTicketResponse,
  type CreateRoomRequest, type ErrorCode, type JoinRequest,
} from '@agent-office/protocol';
type Schema<T> = { safeParse(x: unknown): { success: true; data: T } | { success: false } };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: ErrorCode) {
    super(message);
  }
}

async function call<T>(schema: Schema<T>, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    referrerPolicy: 'no-referrer',
    credentials: 'omit',
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const e = ErrorResponse.safeParse(json);
    throw new ApiError(e.success ? e.data.error : `request failed (${res.status})`, res.status, e.success ? e.data.code : undefined);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError('unexpected response from server', res.status);
  return parsed.data;
}

export type Secret = { kind: 'invite' | 'view' | 'admin'; value: string };
const auth = (s: Secret) => ({ [HEADERS[s.kind]]: s.value });

export type AdminActionInput = { action: 'kick'; participantId: string } | { action: 'close' } | { action: 'pause'; paused: boolean };

export const api = {
  config: () => call(PublicConfig, ROUTES.config),
  createRoom: (body: CreateRoomRequest, createKey?: string) =>
    call(CreateRoomResponse, ROUTES.createRoom, { method: 'POST', body, headers: createKey ? { [HEADERS.create]: createKey } : undefined }),
  getRoom: (id: string, s: Secret) => call(RoomPublicInfo, ROUTES.room(id), { headers: auth(s) }),
  join: (id: string, body: JoinRequest) => call(JoinResponse, ROUTES.join(id), { method: 'POST', body }),
  admin: (id: string, adminSecret: string, body: AdminActionInput) =>
    call(AdminResponse, ROUTES.admin(id), { method: 'POST', headers: auth({ kind: 'admin', value: adminSecret }), body }),
  messages: (id: string, s: Secret, q: { beforeSeq?: number; limit?: number } = {}) => call(MessagesResponse, ROUTES.messages(id, q), { headers: auth(s) }),
  wsTicket: (id: string, s: Secret & { kind: 'admin' | 'view' }) => call(WsTicketResponse, ROUTES.wsTicket(id), { method: 'POST', headers: auth(s) }),
};
