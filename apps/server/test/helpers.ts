import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import pg from 'pg';
import { ROUTES, type CreateRoomResponse, type JoinResponse, type ServerEvent, type WsTicketResponse } from '@agent-office/protocol';
import { WebSocket } from 'ws';
import { createApp, type AppOptions } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/log.js';

export const T0 = 1_700_000_000_000;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function boot(o: { cfg?: Partial<Config>; app?: Partial<AppOptions>; storeOptions?: AppOptions['storeOptions']; createsPerHour?: number } = {}) {
  const clock = { t: T0 };
  const logs: string[] = [];
  const log = createLogger('debug', { write: (s: string) => void logs.push(s) });
  const cfg: Config = { host: '127.0.0.1', port: 0, publicUrl: 'http://localhost:3000', trustProxy: false, maxRooms: 1000, logLevel: 'debug',
    mcpCallsPerMinute: 120, maxTotalBytes: 256 * 1024 * 1024, createRooms: true, createKeyFailsPer10Min: 10, roomsPerIpPerHour: 5, roomTtlSeconds: 3600,
    deliveryCooldownSeconds: 0, deliveriesPerDay: 0, ...o.cfg };
  const app = await createApp({ cfg, log, now: () => clock.t, storeOptions: o.storeOptions, createsPerHour: o.createsPerHour ?? 1000, ...o.app });
  const port = await app.listen();
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const sockets: WebSocket[] = [];

  const api = async (method: string, path: string, o: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}) => {
    const r = await fetch(url + path, { method, headers: o.headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };

  /** MCP client for a token (bearer header or the /mcp/<token> path). */
  async function agent(token: string, via: 'bearer' | 'path' = 'bearer') {
    const transport = new StreamableHTTPClientTransport(
      new URL(via === 'path' ? url + ROUTES.mcpFallback(token) : url + ROUTES.mcp),
      via === 'bearer' ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
    );
    const client = new Client({ name: 'fake', version: '0' });
    await client.connect(transport);
    clients.push(client);
    const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const call = async (name: string, args: Record<string, unknown> = {}) => (await raw(name, args)).content[0]!.text;
    return { client, call, raw };
  }

  /** `permanent`: POST /rooms with cfg.createKey (needs cfg.databaseUrl). */
  async function mkRoom(topic = 'topic', kind: 'anonymous' | 'permanent' = 'anonymous') {
    const created = kind === 'permanent'
      ? await api('POST', ROUTES.createPermanentRoom, { body: { topic }, headers: { 'x-create-key': cfg.createKey ?? '' } })
      : await api('POST', ROUTES.createRoom, { body: { topic } });
    const room = created.json as CreateRoomResponse;
    const admin = { 'x-admin-secret': room.adminSecret };
    const view = { 'x-view-secret': room.viewSecret };
    const ticket = async (h: Record<string, string>) => ((await api('POST', ROUTES.wsTicket(room.roomId), { headers: h })).json as WsTicketResponse).ticket;

    const join = async (displayName: string, vendor = 'other', via: 'bearer' | 'path' = 'bearer') => {
      const r = await api('POST', ROUTES.join(room.roomId), { body: { inviteSecret: room.inviteSecret, displayName, vendor } });
      const j = r.json as JoinResponse;
      return { ...j, ...(await agent(j.token, via)) };
    };

    /** Opens a browser-like socket. Events are collected; `until` waits for one. */
    const ws = async (role: 'admin' | 'view', opts: { lastSeq?: number; origin?: string; ticket?: string } = {}) => {
      const t = opts.ticket ?? (await ticket(role === 'admin' ? admin : view));
      const w = new WebSocket(url.replace('http', 'ws') + ROUTES.ws(t, opts.lastSeq), { headers: opts.origin ? { origin: opts.origin } : {} });
      sockets.push(w);
      const events: ServerEvent[] = [];
      w.on('message', (d) => events.push(JSON.parse(String(d))));
      let closed = false;
      w.on('close', () => (closed = true));
      await new Promise<void>((res, rej) => { w.once('open', res); w.once('error', rej); });
      const until = async (pred: (e: ServerEvent) => boolean, ms = 3000) => {
        for (let i = 0; i < ms / 10; i++) { const hit = events.find(pred); if (hit) return hit; await sleep(10); }
        throw new Error('timed out waiting for event; got ' + events.map((e) => e.type).join(','));
      };
      const isClosed = async (ms = 3000) => { for (let i = 0; i < ms / 10 && !closed; i++) await sleep(10); return closed; };
      const send = (o: unknown) => w.send(JSON.stringify(o));
      return { w, events, until, isClosed, send };
    };
    /** Status of a refused WS upgrade, or 'open'. */
    const wsStatus = async (opts: { origin?: string; ticket?: string; role?: 'admin' | 'view' }) => {
      const t = opts.ticket ?? (await ticket(opts.role === 'view' ? view : admin));
      const w = new WebSocket(url.replace('http', 'ws') + `/ws?ticket=${t}`, { // raw: ROUTES.ws refuses malformed tickets
         headers: opts.origin ? { origin: opts.origin } : {} });
      sockets.push(w);
      return new Promise<number | 'open'>((res) => { w.once('open', () => res('open')); w.once('unexpected-response', (_q, r) => res(r.statusCode ?? 0)); w.once('error', () => {}); });
    };
    return { room, admin, view, join, ws, wsStatus, ticket };
  }

  return {
    url, clock, logs, app, api, mkRoom, agent,
    async close() {
      for (const w of sockets) w.terminate();
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await app.close();
    },
  };
}

/** Real Postgres for persistence tests (DATABASE_URL): a fresh schema per call via search_path, so parallel test files never share tables. */
export async function freshDb() {
  const base = process.env.DATABASE_URL!;
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const u = new URL(base);
  u.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  return {
    url: u.toString(),
    sql: async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows as any[],
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
      await pool.end();
    },
  };
}

export const parseSeq = (t: string) => Number(/lastSeq=(\d+)/.exec(t)![1]);
export const headers = (t: string) => t.split('\n').filter((l) => l.startsWith('<<<MSG '));
