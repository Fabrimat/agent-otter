import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ROUTES, type CreateRoomResponse, type JoinResponse, type ServerEvent, type WsTicketResponse } from '@agent-otter/protocol';
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

  /** `permanent`: POST /rooms with cfg.createKey (needs cfg.databasePath). */
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

/** A temp SQLite file per call. `sql` is a SECOND handle on the same file: what an inspector (or a rogue second writer) sees. */
export async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ao-db-'));
  const path = join(dir, 'ao.db');
  let h: DatabaseSync | undefined;
  return {
    path,
    sql: (q: string, p: SQLInputValue[] = []) => {
      h ??= new DatabaseSync(path);
      h.exec('PRAGMA busy_timeout = 5000');
      return h.prepare(q).all(...p).map((r) => ({ ...r })) as any[];
    },
    async drop() {
      if (h?.isOpen) h.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const parseSeq = (t: string) => Number(/lastSeq=(\d+)/.exec(t)![1]);
export const headers = (t: string) => t.split('\n').filter((l) => l.startsWith('<<<MSG '));
