import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AdminAction, CreateRoomRequest, HEADERS, JoinRequest, LIMITS, MessagesQuery, ROOM_ID, ROUTES, buildSnippets,
  type JoinResponse, type MessagesResponse, type WsTicketResponse,
} from '@agent-office/protocol';
import type { z } from 'zod/v4';
import type { Config } from './config.js';
import { toDelivered } from './deliver.js';
import { StoreError } from './errors.js';
import { clientIp, fail, readJson, send } from './http.js';
import type { Logger } from './log.js';
import type { SlidingWindow } from './ratelimit.js';
import type { Role, RoomStore } from './store.js';

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string> };
type Handler = (c: Ctx) => Promise<void>;

/** Express-style pattern from the protocol contract (`/rooms/:id/join`) to a regex. */
const compile = (p: string) => new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');

export function createRest(d: { store: RoomStore; log: Logger; cfg: Config; createLimiter: SlidingWindow }) {
  const { store, log, cfg } = d;
  const P = ROUTES.patterns;

  const parse = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
    const r = schema.safeParse(data);
    // field paths only: never echo the submitted values
    if (!r.success) throw new StoreError('bad_request', 'invalid request: ' + [...new Set(r.error.issues.map((i) => i.path.join('.') || '(body)'))].join(', '));
    return r.data;
  };
  const body = async (req: IncomingMessage) => (await readJson(req)) ?? {};

  /** Room must exist (404 otherwise); then one of the allowed secret headers must match (403). */
  async function auth(c: Ctx, allowed: Role[]): Promise<Role> {
    const info = await store.getRoom(c.params.id!);
    if (!info) throw new StoreError('room_not_found', 'room not found');
    for (const role of allowed) {
      const v = c.req.headers[HEADERS[role]];
      if (typeof v === 'string' && (await store.checkSecret(c.params.id!, role, v))) return role;
    }
    log.warn({ evt: 'bad_secret', roomId: c.params.id, route: c.url.pathname.split('/').at(-1) });
    throw new StoreError('bad_secret', 'missing or wrong secret');
  }

  const routes: [string, RegExp, Handler][] = [
    ['POST', compile(ROUTES.createRoom), async ({ req, res }) => {
      if (!d.createLimiter.hit(clientIp(req, cfg.trustProxy))) {
        log.warn({ evt: 'rate_limited', kind: 'room_create' });
        throw new StoreError('rate_limited', `room creation limit reached (${LIMITS.roomsPerIpPerHour} per hour)`);
      }
      const { topic } = parse(CreateRoomRequest, await body(req));
      send(res, 200, await store.createRoom(topic ?? ''));
    }],
    ['GET', compile(P.room), async (c) => {
      await auth(c, ['invite', 'view', 'admin']);
      send(c.res, 200, await store.getRoom(c.params.id!));
    }],
    ['POST', compile(P.join), async (c) => {
      const b = parse(JoinRequest, await body(c.req));
      const id = c.params.id!;
      if (!(await store.getRoom(id))) throw new StoreError('room_not_found', 'room not found');
      if (!(await store.checkSecret(id, 'invite', b.inviteSecret))) {
        log.warn({ evt: 'bad_secret', roomId: id, route: 'join' });
        throw new StoreError('bad_secret', 'missing or wrong secret');
      }
      const j = await store.join(id, { displayName: b.displayName, vendor: b.vendor });
      const out: JoinResponse = {
        participantId: j.participantId, token: j.token, displayName: j.displayName, vendor: j.vendor, cursorStartsAt: j.cursorStartsAt,
        ...buildSnippets(cfg.publicUrl, j.token),
      };
      send(c.res, 200, out);
    }],
    ['POST', compile(P.admin), async (c) => {
      await auth(c, ['admin']);
      const a = parse(AdminAction, await body(c.req));
      await store.admin(c.params.id!, a);
      log.info({ evt: 'admin', roomId: c.params.id, action: a.action });
      const out = { ok: true as const };
      send(c.res, 200, out);
    }],
    ['GET', compile(P.messages), async (c) => {
      const role = await auth(c, ['admin', 'view']);
      const q = parse(MessagesQuery, Object.fromEntries(c.url.searchParams));
      const page = await store.list(c.params.id!, { before: q.beforeSeq, limit: q.limit ?? LIMITS.historyLimitMax, maxBytes: 256 * 1024 });
      const owner = role === 'admin' ? page.adminOwnerId : ''; // a viewer owns nothing: every non-system message is 'other'
      const out: MessagesResponse = { messages: page.messages.map((m) => toDelivered(m, page.names, owner)).reverse(), hasMore: page.hasMore }; // newest first
      send(c.res, 200, out);
    }],
    ['POST', compile(P.wsTicket), async (c) => {
      const role = await auth(c, ['admin', 'view']);
      const t = await store.issueTicket(c.params.id!, role === 'admin' ? 'admin' : 'viewer');
      const out: WsTicketResponse = t;
      send(c.res, 200, out);
    }],
  ];

  /** Returns false when no route matches (caller falls through to static files). */
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (!m || method !== req.method) continue;
      const params = { ...m.groups };
      try {
        if (params.id !== undefined && !ROOM_ID.test(params.id)) throw new StoreError('room_not_found', 'room not found');
        await handler({ req, res, url, params });
      } catch (e) {
        if (e instanceof StoreError) fail(res, e.code, e.message);
        else {
          log.error({ evt: 'internal', err: (e as Error).message });
          if (!res.headersSent) fail(res, 'internal', 'internal error');
        }
      }
      return true;
    }
    return false;
  };
}
