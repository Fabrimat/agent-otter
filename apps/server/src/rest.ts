import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AdminAction, CreateRoomRequest, HEADERS, JoinRequest, LIMITS, MessagesQuery, PARTICIPANT_ID, ROOM_ID, ROUTES, buildSnippets,
  type CubicleResponse, type CubiclesResponse, type JoinResponse, type MessagesResponse, type OperatorRoomsResponse, type PublicConfig, type RotateSecretsResponse, type WsTicketResponse,
} from '@lesscubicles/protocol';
import type { z } from 'zod/v4';
import type { Config } from './config.js';
import { toDelivered } from './deliver.js';
import { StoreError } from './errors.js';
import { clientIp, fail, readJson, send } from './http.js';
import { errKind, type Logger } from './log.js';
import type { SlidingWindow } from './ratelimit.js';
import { sameSecret, type Role, type RoomStore } from './store.js';

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string> };
type Handler = (c: Ctx) => Promise<void>;

/** Express-style pattern from the protocol contract (`/rooms/:id/join`) to a regex. */
const compile = (p: string) => new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');

export function createRest(d: { store: RoomStore; log: Logger; cfg: Config; createLimiter: SlidingWindow; keyFailLimiter: SlidingWindow }) {
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

  /** x-create-key check. Brute-force guard: an IP with too many wrong keys is refused WITHOUT comparing, so even the right key waits out the window. */
  function requireKey(req: IncomingMessage) {
    const ip = clientIp(req, cfg.trustProxy);
    if (d.keyFailLimiter.full(ip)) {
      log.warn({ evt: 'rate_limited', kind: 'create_key', ip });
      throw new StoreError('rate_limited', 'too many wrong create keys, try again later');
    }
    const k = req.headers[HEADERS.create];
    if (typeof k !== 'string' || !sameSecret(cfg.createKey!, k)) {
      d.keyFailLimiter.hit(ip);
      log.warn({ evt: 'create_forbidden', ip }); // normalised IP, never the submitted key
      throw new StoreError('create_forbidden', 'a valid create key is required to create a room');
    }
  }
  /** Permanent rooms and the operator surface need BOTH a CREATE_KEY and a database. */
  function requireOperator(req: IncomingMessage) {
    // key first: an unauthenticated caller must not learn whether persistence is configured (no CREATE_KEY at all is public via /config)
    if (!cfg.createKey) throw new StoreError('create_disabled', 'permanent rooms need CREATE_KEY and DATABASE_PATH on this server');
    requireKey(req);
    if (!cfg.databasePath) throw new StoreError('create_disabled', 'permanent rooms need CREATE_KEY and DATABASE_PATH on this server');
  }

  const routes: [string, RegExp, Handler][] = [
    ['GET', compile(ROUTES.config), async ({ res }) => {
      const out: PublicConfig = { createRequiresKey: !!cfg.createKey, createEnabled: cfg.createRooms, ttlSeconds: cfg.roomTtlSeconds };
      send(res, 200, out);
    }],
    ['POST', compile(ROUTES.createRoom), async ({ req, res }) => {
      if (!cfg.createRooms) throw new StoreError('create_disabled', 'room creation is switched off on this server');
      // a valid CREATE_KEY holder is trusted: the per-IP room limit (shared by a whole office behind one proxy IP) does not apply
      if (cfg.createKey) requireKey(req);
      else if (!d.createLimiter.hit(clientIp(req, cfg.trustProxy))) {
        log.warn({ evt: 'rate_limited', kind: 'room_create' });
        throw new StoreError('rate_limited', `room creation limit reached (${cfg.roomsPerIpPerHour} per hour)`);
      }
      const { topic } = parse(CreateRoomRequest, await body(req));
      send(res, 200, await store.createRoom(topic ?? ''));
    }],
    ['POST', compile(ROUTES.createPermanentRoom), async ({ req, res }) => {
      if (!cfg.createRooms) throw new StoreError('create_disabled', 'room creation is switched off on this server');
      requireOperator(req);
      const { topic } = parse(CreateRoomRequest, await body(req));
      const out = await store.createRoom(topic ?? '', 'permanent');
      log.info({ evt: 'room_created', kind: 'permanent', roomId: out.roomId });
      send(res, 200, out);
    }],
    ['GET', compile(ROUTES.operatorRooms), async ({ req, res }) => {
      requireOperator(req);
      const out: OperatorRoomsResponse = { rooms: store.permanentRooms() };
      send(res, 200, out);
    }],
    ['POST', compile(P.operatorRotate), async (c) => {
      requireOperator(c.req);
      const s = await store.rotateSecrets(c.params.id!);
      log.info({ evt: 'operator', action: 'rotate', roomId: c.params.id });
      const out: RotateSecretsResponse = { inviteSecret: s.invite, viewSecret: s.view, adminSecret: s.admin };
      send(c.res, 200, out);
    }],
    ['POST', compile(P.operatorClose), async (c) => {
      requireOperator(c.req);
      await store.admin(c.params.id!, { action: 'close' });
      log.info({ evt: 'operator', action: 'close', roomId: c.params.id });
      send(c.res, 200, { ok: true });
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
      const { snippets: { pathFallbackUrl, ...snippets }, note } = buildSnippets(cfg.publicUrl, j.token);
      const out: JoinResponse = {
        participantId: j.participantId, token: j.token, displayName: j.displayName, vendor: j.vendor, cursorStartsAt: j.cursorStartsAt,
        snippets: j.kind === 'permanent' ? snippets : { ...snippets, pathFallbackUrl }, note, // permanent tokens never go in URLs (T-04)
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
      // admin and view secret holders read EVERYTHING (no since_join clamp): they are the room's owner and its read-only transcript link,
      // not participants. Closed permanent rooms stay readable here.
      const role = await auth(c, ['admin', 'view']);
      const q = parse(MessagesQuery, Object.fromEntries(c.url.searchParams));
      const page = await store.list(c.params.id!, { before: q.beforeSeq, limit: q.limit ?? LIMITS.historyLimitMax, maxBytes: 256 * 1024 });
      const owner = role === 'admin' ? page.adminOwnerId : ''; // a viewer owns nothing: every non-system message is 'other'
      const out: MessagesResponse = { messages: page.messages.map((m) => toDelivered(m, page.names, owner)).reverse(), hasMore: page.hasMore }; // newest first
      send(c.res, 200, out);
    }],
    ['GET', compile(P.cubicles), async (c) => {
      const role = await auth(c, ['admin', 'view']); // invite secret refused, like /messages
      const out: CubiclesResponse = { cubicles: await store.cubicleList(c.params.id!, { role: role === 'admin' ? 'admin' : 'view' }) };
      send(c.res, 200, out);
    }],
    ['GET', compile(P.cubicle), async (c) => {
      const role = await auth(c, ['admin', 'view']);
      if (!PARTICIPANT_ID.test(c.params.pid!)) throw new StoreError('bad_request', 'invalid participant id');
      const { from: _from, ...out }: CubicleResponse & { from?: unknown } = await store.cubicleRead(c.params.id!, { role: role === 'admin' ? 'admin' : 'view' }, c.params.pid!);
      send(c.res, 200, out);
    }],
    ['POST', compile(P.wsTicket), async (c) => {
      const role = await auth(c, ['admin', 'view']);
      const t = await store.issueTicket(c.params.id!, role === 'admin' ? 'admin' : 'viewer', clientIp(c.req, cfg.trustProxy));
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
          log.error({ evt: 'internal', err: errKind(e) });
          if (!res.headersSent) fail(res, 'internal', 'internal error');
        }
      }
      return true;
    }
    return false;
  };
}
