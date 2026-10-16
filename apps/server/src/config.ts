import { statSync } from 'node:fs';
import * as z from 'zod/v4';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const Bool = z.enum(['0', '1', 'true', 'false']).optional();

const Env = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  // same charset buildSnippets accepts: the URL ends up inside shell snippets
  PUBLIC_URL: z.string().regex(/^https?:\/\/[A-Za-z0-9.:_/-]+$/, 'must be an http(s) origin without query or spaces').optional(),
  TRUST_PROXY: Bool,
  WEB_DIST: z.string().min(1).optional(),
  MAX_ROOMS: z.coerce.number().int().min(1).max(100_000).default(1000),
  LOG_LEVEL: z.enum(LEVELS).default('info'),
});

export type Config = { port: number; publicUrl: string; trustProxy: boolean; webDist?: string; maxRooms: number; logLevel: (typeof LEVELS)[number] };

/** Validates env at startup; throws one readable error listing every bad variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const r = Env.safeParse(clean);
  if (!r.success) throw new Error('invalid configuration: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const e = r.data;
  if (e.WEB_DIST && !statSync(e.WEB_DIST, { throwIfNoEntry: false })?.isDirectory()) throw new Error('invalid configuration: WEB_DIST is not a directory');
  return {
    port: e.PORT,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    trustProxy: e.TRUST_PROXY === '1' || e.TRUST_PROXY === 'true',
    webDist: e.WEB_DIST,
    maxRooms: e.MAX_ROOMS,
    logLevel: e.LOG_LEVEL,
  };
}
