import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Rng } from '@agent-office/protocol';
import type { Config } from './config.js';
import { fail, send } from './http.js';
import { errKind, redactPath, type Logger } from './log.js';
import { createMcp } from './mcp.js';
import { SlidingWindow } from './ratelimit.js';
import { createRest } from './rest.js';
import { createStatic } from './static.js';
import { MemoryStore, type MemoryStoreOptions, type RoomStore } from './store.js';
import { attachWs } from './ws.js';

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export type AppOptions = { cfg: Config; log: Logger; store?: RoomStore; now?: () => number; rng?: Rng; storeOptions?: MemoryStoreOptions; createsPerHour?: number };

export async function createApp(o: AppOptions) {
  const { cfg, log } = o;
  const now = o.now ?? Date.now;
  const store = o.store ?? new MemoryStore({ now, rng: o.rng, maxRooms: cfg.maxRooms, ttlMs: cfg.roomTtlSeconds * 1000, maxTotalBytes: cfg.maxTotalBytes, ...o.storeOptions });
  const rest = createRest({ store, log, cfg, createLimiter: new SlidingWindow(o.createsPerHour ?? cfg.roomsPerIpPerHour, 3600_000, now), keyFailLimiter: new SlidingWindow(cfg.createKeyFailsPer10Min, 600_000, now) });
  const mcp = createMcp({ store, log, now, callsPerMinute: cfg.mcpCallsPerMinute });
  const serveStatic = cfg.webDist ? await createStatic(cfg.webDist) : undefined;

  const server: Server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://x');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // access log: method, redacted path (never the query, never a token), status, duration
    res.on('finish', () => log.info({ evt: 'http', method: req.method, path: redactPath(url.pathname), status: res.statusCode, ms: Date.now() - started }));
    try {
      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, { ok: true });
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return await mcp(req, res, url.pathname);
      if (await rest(req, res, url)) return;
      if (serveStatic && (await serveStatic(req, res, url.pathname))) return;
      fail(res, 'bad_request', 'not found', 404);
    } catch (e) {
      log.error({ evt: 'internal', err: errKind(e) });
      if (!res.headersSent) fail(res, 'internal', 'internal error');
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000; // time to receive a request; does not limit long-poll responses
  server.headersTimeout = 10_000;

  const ws = attachWs(server, { store, log, now, publicUrl: cfg.publicUrl });
  const sweeper = setInterval(() => void store.sweep(), 5_000);
  sweeper.unref();

  return {
    server,
    store,
    /** Resolves with the bound port; the bound address is `server.address()`. */
    async listen(): Promise<number> {
      await new Promise<void>((ok) => server.listen(cfg.port, cfg.host, ok));
      return (server.address() as AddressInfo).port;
    },
    /** SIGTERM path: stop accepting, close frames to sockets, then drop what is left (long-polls included) after a short grace. */
    async shutdown() {
      clearInterval(sweeper);
      const stopped = new Promise((ok) => server.close(ok));
      server.closeIdleConnections();
      await ws.shutdown();
      server.closeAllConnections();
      await stopped;
    },
    async close() {
      clearInterval(sweeper);
      ws.close();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    },
  };
}
