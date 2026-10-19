import { isIPv4, isIPv6 } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorCode, ErrorResponse } from '@agent-otter/protocol';
import { StoreError } from './errors.js';

export const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, bad_secret: 403, room_not_found: 404, room_closed: 410, room_paused: 409, rate_limited: 429, secret_detected: 422,
  name_taken: 409, reserved_name: 400, payload_too_large: 413, forbidden_role: 403, bad_ticket: 401, room_full: 409, internal: 500,
  create_forbidden: 403, create_disabled: 503,
};

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

export function fail(res: ServerResponse, code: ErrorCode, message: string, status = STATUS[code]) {
  const body: ErrorResponse = { error: message, code };
  send(res, status, body, status === 413 ? { connection: 'close' } : {});
}

/** Reads a small JSON body. Empty body is `{}`. Throws StoreError (payload_too_large | bad_request). */
export async function readJson(req: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  if (Number(req.headers['content-length']) > maxBytes) throw new StoreError('payload_too_large', 'request body too large');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > maxBytes) throw new StoreError('payload_too_large', 'request body too large');
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new StoreError('bad_request', 'body is not valid JSON');
  }
}

/** Client address for rate limits. Behind a trusted proxy the LAST X-Forwarded-For entry is the one our proxy saw (earlier ones are client-controlled). */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const xff = trustProxy ? req.headers['x-forwarded-for'] : undefined;
  const last = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',').at(-1)?.trim();
  return normalizeIp(last || req.socket.remoteAddress || 'unknown');
}

/** Rate-limit key: IPv4-mapped IPv6 becomes IPv4; other IPv6 collapses to its /64 (one subscriber owns a whole /64). */
export function normalizeIp(ip: string): string {
  const bare = ip.split('%')[0]!.toLowerCase();
  if (bare.startsWith('::ffff:') && isIPv4(bare.slice(7))) return bare.slice(7);
  if (!isIPv6(bare)) return bare;
  const [h = '', t = ''] = bare.split('::');
  const head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const groups = bare.includes('::') ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}
