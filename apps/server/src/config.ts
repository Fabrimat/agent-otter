import { statSync } from 'node:fs';
import { isIP } from 'node:net';
import * as z from 'zod/v4';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const Bool = z.enum(['0', '1', 'true', 'false']).optional();

const Env = z.object({
  // bind address: loopback unless told otherwise (containers set HOST=0.0.0.0 behind a proxy)
  HOST: z.string().refine((h) => isIP(h) > 0 || /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h), 'must be an IP address or hostname').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  // same charset buildSnippets accepts: the URL ends up inside shell snippets
  PUBLIC_URL: z.string().regex(/^https?:\/\/[A-Za-z0-9.:_/-]+$/, 'must be an http(s) origin without query or spaces').optional(),
  TRUST_PROXY: Bool,
  WEB_DIST: z.string().min(1).optional(),
  MAX_ROOMS: z.coerce.number().int().min(1).max(100_000).default(1000),
  LOG_LEVEL: z.enum(LEVELS).default('info'),
  MCP_CALLS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  MAX_TOTAL_BYTES: z.coerce.number().int().min(1).default(256 * 1024 * 1024),
  CREATE_ROOMS: Bool,
  CREATE_KEY: z.string().min(1).optional(),
  ROOMS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(5),
  CREATE_KEY_FAILS_PER_10MIN: z.coerce.number().int().min(1).max(10_000).default(10),
  // 1 hour is the hard cap (LIMITS.roomTtlMs): the env can only shorten it
  ROOM_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(3600),
  // inbound delivery policy per agent recipient; 0 disables
  DELIVERY_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(5),
  DELIVERIES_PER_DAY: z.coerce.number().int().min(0).max(1_000_000).default(2000),
  // permanent rooms; unset = anonymous rooms only. Set and unreachable at boot = the process exits (never silently memory-only)
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL').optional(),
});

export type Config = { host: string; port: number; publicUrl: string; trustProxy: boolean; webDist?: string; maxRooms: number; logLevel: (typeof LEVELS)[number];
  mcpCallsPerMinute: number; maxTotalBytes: number; createRooms: boolean; createKey?: string; createKeyFailsPer10Min: number; roomsPerIpPerHour: number; roomTtlSeconds: number;
  deliveryCooldownSeconds: number; deliveriesPerDay: number; databaseUrl?: string };

/** Validates env at startup; throws one readable error listing every bad variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const r = Env.safeParse(clean);
  if (!r.success) throw new Error('invalid configuration: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const e = r.data;
  if (e.WEB_DIST && !statSync(e.WEB_DIST, { throwIfNoEntry: false })?.isDirectory()) throw new Error('invalid configuration: WEB_DIST is not a directory');
  return {
    host: e.HOST,
    port: e.PORT,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    trustProxy: e.TRUST_PROXY === '1' || e.TRUST_PROXY === 'true',
    webDist: e.WEB_DIST,
    maxRooms: e.MAX_ROOMS,
    logLevel: e.LOG_LEVEL,
    mcpCallsPerMinute: e.MCP_CALLS_PER_MINUTE,
    maxTotalBytes: e.MAX_TOTAL_BYTES,
    createRooms: e.CREATE_ROOMS === undefined || e.CREATE_ROOMS === '1' || e.CREATE_ROOMS === 'true',
    createKey: e.CREATE_KEY,
    createKeyFailsPer10Min: e.CREATE_KEY_FAILS_PER_10MIN,
    roomsPerIpPerHour: e.ROOMS_PER_IP_PER_HOUR,
    roomTtlSeconds: e.ROOM_TTL_SECONDS,
    deliveryCooldownSeconds: e.DELIVERY_COOLDOWN_SECONDS,
    deliveriesPerDay: e.DELIVERIES_PER_DAY,
    databaseUrl: e.DATABASE_URL,
  };
}
