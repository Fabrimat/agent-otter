// Browser realtime: one-time ticket, Origin check, resume from lastSeq. Viewers are read-only.
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { ClientCommand, LIMITS, WsQuery, type ServerEvent } from '@agent-otter/protocol';
import { toDelivered } from './deliver.js';
import { StoreError } from './errors.js';
import { errKind, type Logger } from './log.js';
import { SlidingWindow } from './ratelimit.js';
import type { Identity, RoomEvent, RoomStore } from './store.js';

const MAX_PAYLOAD = LIMITS.contentBytes + 1024; // content cap plus the JSON envelope
const MAX_SOCKETS_PER_ROOM = 25;
const MAX_BUFFERED = 1024 * 1024; // slow consumer: drop it rather than grow memory
const INIT_MESSAGES = 200;
const RESUME_MESSAGES = 500;

export function attachWs(server: Server, d: { store: RoomStore; log: Logger; now: () => number; publicUrl: string }) {
  const { store, log } = d;
  const publicOrigin = new URL(d.publicUrl).origin;
  // URL parsing lowercases and drops default ports from the Origin; the Host header gets the same treatment. Anything unparsable fails closed.
  const originOk = (origin: string, host: string | undefined) => {
    if (!URL.canParse(origin)) return false;
    const o = new URL(origin);
    if (o.origin === publicOrigin) return true;
    const h = host?.toLowerCase().replace(o.protocol === 'https:' ? /:443$/ : /:80$/, '');
    return !!h && o.host === h;
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const perRoom = new Map<string, number>();
  const connLimiter = new SlidingWindow(20, 10_000, d.now); // commands per connection per 10 s
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const refuse = (socket: Duplex, status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
      // browsers always send Origin; it must match Host, or the origin of PUBLIC_URL when a proxy rewrites Host (blocks cross-site WebSocket hijacking)
      const origin = req.headers.origin;
      if (origin !== undefined && !originOk(origin, req.headers.host)) {
        log.warn({ evt: 'ws_origin_rejected' });
        return refuse(socket, 403, 'Forbidden');
      }
      const q = WsQuery.safeParse(Object.fromEntries(url.searchParams));
      const t = q.success ? await store.redeemTicket(q.data.ticket) : undefined;
      if (!q.success || !t) return refuse(socket, 401, 'Unauthorized');
      if ((perRoom.get(t.roomId) ?? 0) >= MAX_SOCKETS_PER_ROOM) return refuse(socket, 503, 'Service Unavailable');
      wss.handleUpgrade(req, socket, head, (ws) => void connect(ws, t.roomId, t.role, q.data.lastSeq));
    } catch (e) {
      log.error({ evt: 'internal', err: errKind(e), where: 'ws_upgrade' });
      socket.destroy();
    }
  });

  async function connect(ws: WebSocket, roomId: string, role: 'admin' | 'viewer', lastSeq?: number) {
    const connId = randomUUID();
    perRoom.set(roomId, (perRoom.get(roomId) ?? 0) + 1);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const emit = (e: ServerEvent) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
      ws.send(JSON.stringify(e));
    };
    let me: Identity | undefined;
    let unsub = () => {};
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsub();
      perRoom.set(roomId, (perRoom.get(roomId) ?? 1) - 1);
      if (!perRoom.get(roomId)) perRoom.delete(roomId);
      if (me) void store.leave(roomId, me.participantId);
    };
    ws.on('close', cleanup);
    ws.on('error', () => ws.terminate());

    const owner = () => me?.ownerId ?? ''; // viewers own nothing: every non-system message is 'other'
    let initialised = false;
    const queue: RoomEvent[] = [];
    const forward = (e: RoomEvent) => {
      if (e.type === 'message') emit({ type: 'message', message: toDelivered(e.message, e.names, owner()) });
      else if (e.type === 'participants') emit({ type: 'participants', participants: e.participants });
      else if (e.type === 'receipt') emit({ type: 'receipt', participantId: e.participantId, seqs: e.seqs, at: e.at });
      else if (e.type === 'paused') emit({ type: 'room_paused', paused: e.paused });
      else if (e.type === 'closing') emit({ type: 'room_closing', expiresAt: e.expiresAt });
      else if (e.type === 'closed') { emit({ type: 'room_closed', reason: e.reason }); ws.close(1000, 'room closed'); }
      else if (e.type === 'kicked' && e.participantId === me?.participantId) { emit({ type: 'room_closed', reason: 'removed by the room admin' }); ws.close(1008, 'removed'); }
    };

    try {
      if (role === 'admin') me = await store.joinHuman(roomId);
      unsub = store.subscribe(roomId, (e) => (initialised ? forward(e) : queue.push(e)));
      const info = await store.getRoom(roomId);
      if (!info) throw new StoreError('room_not_found', 'room not found');
      // no participantId: admin and viewer sockets see the whole history (no since_join clamp, same as REST); permanent rooms read SQL here
      let page = await store.list(roomId, lastSeq === undefined ? { limit: INIT_MESSAGES } : { after: lastSeq, limit: RESUME_MESSAGES });
      // Gap larger than one resume batch: send the NEWEST batch instead of silently skipping the middle. The init event has no `truncated`
      // flag in the protocol; the client sees the gap because messages[0].seq > its lastSeq + 1.
      if (lastSeq !== undefined && page.hasMore) page = await store.list(roomId, { limit: RESUME_MESSAGES });
      emit({ type: 'init', roomId, topic: info.topic, expiresAt: info.expiresAt, participants: info.participants, messages: page.messages.map((m) => toDelivered(m, page.names, owner())), lastSeq: page.lastSeq });
      initialised = true;
      for (const e of queue.splice(0)) if (e.type !== 'message' || e.message.seq > page.lastSeq) forward(e);
    } catch (e) {
      const known = e instanceof StoreError;
      if (!known) log.error({ evt: 'internal', err: errKind(e), where: 'ws_connect' });
      emit({ type: 'error', code: known ? e.code : 'internal', message: known ? e.message : 'internal error' });
      ws.close(1008, 'refused');
      return;
    }

    ws.on('message', (raw: RawData, isBinary: boolean) => void onCommand(raw, isBinary).catch((e) => log.error({ evt: 'internal', err: errKind(e), where: 'ws_command' })));
    async function onCommand(raw: RawData, isBinary: boolean) {
      if (!connLimiter.hit(connId)) return emit({ type: 'error', code: 'rate_limited', message: 'too many commands, slow down' });
      let json: unknown;
      try { json = isBinary ? undefined : JSON.parse(raw.toString()); } catch { /* falls through to bad_request */ }
      const cmd = ClientCommand.safeParse(json);
      if (!cmd.success) return emit({ type: 'error', code: 'bad_request', message: 'invalid command' });
      if (role !== 'admin' || !me) return emit({ type: 'error', code: 'forbidden_role', message: 'viewers are read-only' });
      try {
        await store.send(roomId, me.participantId, cmd.data);
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        if (e.code === 'secret_detected') log.warn({ evt: 'secret_blocked', via: 'ws', roomId, participantId: me.participantId });
        emit({ type: 'error', code: e.code, message: e.message });
      }
    }
  }

  const close = () => { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); };
  /** Graceful: a close frame (1001) to every client, then terminate whoever has not answered after 1 s. */
  const shutdown = async () => {
    const closed = [...wss.clients].map((ws) => new Promise<void>((ok) => { ws.once('close', () => ok()); ws.close(1001, 'server shutting down'); }));
    await Promise.race([Promise.all(closed), new Promise((ok) => setTimeout(ok, 1000))]);
    close();
  };
  return { close, shutdown };
}
