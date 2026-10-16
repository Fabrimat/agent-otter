import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LIMITS, type Rng } from '@agent-office/protocol';
import type { Config } from './config.js';
import { fail } from './http.js';
import { redactPath, type Logger } from './log.js';
import { createMcp } from './mcp.js';
import { SlidingWindow } from './ratelimit.js';
import { createRest } from './rest.js';
import { createStatic } from './static.js';
import { MemoryStore, type MemoryStoreOptions, type RoomStore } from './store.js';
import { attachWs } from './ws.js';

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export type AppOptions = { cfg: Config; log: Logger; store?: RoomStore; now?: () => number; rng?: Rng; storeOptions?: MemoryStoreOptions; createsPerHour?: number };

export async function createApp(o: AppOptions) {
  const { cfg, log } = o;
  const now = o.now ?? Date.now;
  const store = o.store ?? new MemoryStore({ now, rng: o.rng, maxRooms: cfg.maxRooms, ...o.storeOptions });
  const rest = createRest({ store, log, cfg, createLimiter: new SlidingWindow(o.createsPerHour ?? LIMITS.roomsPerIpPerHour, 3600_000, now) });
  const mcp = createMcp({ store, log });
  const serveStatic = cfg.webDist ? await createStatic(cfg.webDist) : undefined;

  const server: Server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://x');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // access log: method, redacted path (never the query, never a token), status, duration
    res.on('finish', () => log.info({ evt: 'http', method: req.method, path: redactPath(url.pathname), status: res.statusCode, ms: Date.now() - started }));
    try {
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return await mcp(req, res, url.pathname);
      if (await rest(req, res, url)) return;
      if (serveStatic && (await serveStatic(req, res, url.pathname))) return;
      fail(res, 'bad_request', 'not found', 404);
    } catch (e) {
      log.error({ evt: 'internal', err: (e as Error).message });
      if (!res.headersSent) fail(res, 'internal', 'internal error');
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000; // time to receive a request; does not limit long-poll responses
  server.headersTimeout = 10_000;

  const ws = attachWs(server, { store, log, now });
  const sweeper = setInterval(() => void store.sweep(), 5_000);
  sweeper.unref();

  return {
    server,
    store,
    async listen(): Promise<number> {
      await new Promise<void>((ok) => server.listen(cfg.port, ok));
      return (server.address() as AddressInfo).port;
    },
    async close() {
      clearInterval(sweeper);
      ws.close();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    },
  };
}
