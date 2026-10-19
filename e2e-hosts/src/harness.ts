// Harness for the real-host tests: real server (127.0.0.1 only), rooms, scripted participants, process supervision, config guard.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HEADERS, ROUTES, type CreateRoomResponse, type DeliveredMessage, type JoinResponse, type MessagesResponse, type RoomPublicInfo, type ServerEvent, type Vendor, type WsTicketResponse } from '@agent-office/protocol';
import { WebSocket } from 'ws';
import { createApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { createLogger } from '../../apps/server/src/log.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const MAX_USD = Number(process.env.HOSTS_MAX_USD ?? '2.00');
export const RUN_ID = process.env.HOSTS_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
export const RESULTS_DIR = join(import.meta.dirname, '..', 'results', RUN_ID);

export function record(name: string, data: unknown) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------- process supervision
const live = new Set<ChildProcess>();
export function killTree(p: ChildProcess) {
  if (p.pid === undefined || p.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-p.pid, 'SIGKILL'); } catch { p.kill('SIGKILL'); }
}
export const killAll = () => { for (const p of live) killTree(p); live.clear(); };
process.on('exit', killAll);

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number; t0: number; lines: { t: number; line: string }[] };

/** Runs a host binary with a hard timeout; the whole process tree is killed on timeout. stdin is closed. */
export function run(cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { env: o.env ?? hostEnv(), cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    live.add(p);
    let stdout = '', stderr = '', buf = '', timedOut = false;
    const lines: RunResult['lines'] = [];
    p.stdout!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s; buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push({ t: Date.now(), line: buf.slice(0, i) }); buf = buf.slice(i + 1); }
    });
    p.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => { timedOut = true; killTree(p); }, o.timeoutMs);
    const done = (code: number | null) => { clearTimeout(timer); live.delete(p); if (buf) lines.push({ t: Date.now(), line: buf }); resolve({ code, stdout, stderr, timedOut, ms: Date.now() - t0, t0, lines }); };
    p.on('error', (e) => { stderr += String(e); done(null); });
    p.on('close', (c) => done(c));
  });
}

/** Env for a host run: the owner's login is kept (HOME etc.), session-nesting variables and API-key billing are dropped. */
export function hostEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'ANTHROPIC_API_KEY' || k === 'OPENAI_API_KEY') delete e[k];
  return { ...e, ...extra };
}

// ---------------------------------------------------------------- owner's global config must not change
// EXACT scope of the guard (sha256 before and after every test file): the mcpServers sections of ~/.claude.json (top level and per project),
// ~/.claude/settings.json, ~/.claude/CLAUDE.md and ~/.codex/config.toml. NOT guarded: the rest of ~/.claude.json (Claude rewrites it itself),
// the rest of ~/.claude/ (sessions, history, caches) and ~/.codex/ (auth.json, sessions, sandbox state).
const home = homedir();
function claudeJsonMcp(): string {
  const f = join(home, '.claude.json');
  if (!existsSync(f)) return 'absent';
  // Claude rewrites this file while it runs: a read can see a half-written file, so retry a few times before giving up
  let text = '';
  for (let i = 0; ; i++) {
    text = readFileSync(f, 'utf8');
    try { JSON.parse(text); break; } catch (e) { if (i >= 5) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
  }
  const j = JSON.parse(text) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
  // the file is rewritten by Claude itself (stats, counters): only the MCP sections are ours to protect
  return JSON.stringify([j.mcpServers ?? null, Object.entries(j.projects ?? {}).map(([k, v]) => [k, v.mcpServers ?? null]).filter(([, m]) => m && JSON.stringify(m) !== '{}')]);
}
const fileHash = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
export const globalConfigSnapshot = () => ({
  '~/.claude.json (mcpServers sections)': createHash('sha256').update(claudeJsonMcp()).digest('hex'),
  '~/.claude/settings.json': fileHash(join(home, '.claude', 'settings.json')),
  '~/.claude/CLAUDE.md': fileHash(join(home, '.claude', 'CLAUDE.md')),
  '~/.codex/config.toml': fileHash(join(home, '.codex', 'config.toml')),
});
export function assertGlobalConfigUnchanged(before: ReturnType<typeof globalConfigSnapshot>) {
  const after = globalConfigSnapshot();
  const changed = Object.keys(before).filter((k) => (before as Record<string, string>)[k] !== (after as Record<string, string>)[k]);
  if (changed.length) throw new Error('GLOBAL CONFIG CHANGED during the run: ' + changed.join(', '));
}

export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), `ao-${prefix}-`));
export const rmDir = (d: string) => { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

// ---------------------------------------------------------------- server under test
/**
 * With HOSTS_REMOTE_URL set (https only) the tests run against that deployed server instead of an in-process one; HOSTS_CREATE_KEY (env only, never
 * written to disk) is sent as the room-creation key. Only the scenarios that do not read server internals (logs) work in this mode.
 */
export async function startServer() {
  const remote = process.env.HOSTS_REMOTE_URL?.replace(/\/+$/, '');
  if (remote && !remote.startsWith('https://')) throw new Error('HOSTS_REMOTE_URL must be https://');
  const logs: string[] = [];
  const cfg = loadConfig({ PORT: '0', PUBLIC_URL: 'http://127.0.0.1', LOG_LEVEL: 'warn', MCP_CALLS_PER_MINUTE: '600', MAX_TOTAL_BYTES: String(64 * 1024 * 1024) });
  const app = remote ? undefined : await createApp({ cfg, log: createLogger('warn', { write: (s: string) => void logs.push(s) }), createsPerHour: 1000 });
  let url = remote ?? '';
  if (app) {
    // listen here, NOT app.listen(): that one binds every interface. Loopback only, asserted.
    await new Promise<void>((ok, bad) => { app.server.once('error', bad); app.server.listen(0, '127.0.0.1', ok); });
    const a = app.server.address() as AddressInfo;
    if (a.address !== '127.0.0.1') { await app.close(); throw new Error(`server bound to ${a.address}, expected 127.0.0.1`); }
    url = `http://127.0.0.1:${a.port}`;
  }
  const clients: Client[] = [];
  const sockets: WebSocket[] = [];

  const api = async (method: string, path: string, o: { headers?: Record<string, string>; body?: unknown } = {}) => {
    const r = await fetch(url + path, { method, headers: o.headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };

  class Agent {
    mcpUrl = url + ROUTES.mcp;
    cached?: Client;
    constructor(public room: Room, public j: JoinResponse) {}
    get name() { return this.j.displayName; }
    get token() { return this.j.token; }
    get participantId() { return this.j.participantId; }
    /** MCP client with the official SDK, as a scripted participant. */
    async client() {
      const c = new Client({ name: 'probe', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } }));
      clients.push(c);
      return c;
    }
    async call(name: string, args: Record<string, unknown> = {}) {
      const c = (this.cached ??= await this.client());
      const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join('\n'), isError: !!r.isError };
    }
    send(content: string) { return this.call('room_send', { content }); }
  }

  class Human {
    events: ServerEvent[] = [];
    constructor(public w: WebSocket) { w.on('message', (d) => this.events.push(JSON.parse(String(d)))); }
    send(content: string) { this.w.send(JSON.stringify({ type: 'send_message', content })); }
  }

  class Room {
    id: string; invite: string; adminSecret: string; viewSecret: string;
    constructor(r: CreateRoomResponse) { this.id = r.roomId; this.invite = r.inviteSecret; this.adminSecret = r.adminSecret; this.viewSecret = r.viewSecret; }
    adminH = () => ({ [HEADERS.admin]: this.adminSecret });
    async join(displayName: string, vendor: Vendor): Promise<Agent> {
      const r = await api('POST', ROUTES.join(this.id), { body: { inviteSecret: this.invite, displayName, vendor } });
      if (r.status !== 200 && r.status !== 201) throw new Error(`join ${displayName} failed: ${r.status} ${r.text}`);
      return new Agent(this, r.json as JoinResponse);
    }
    /** The room's human participant (browser admin role over WebSocket). */
    async human(): Promise<Human> {
      const t = ((await api('POST', ROUTES.wsTicket(this.id), { headers: this.adminH() })).json as WsTicketResponse).ticket;
      const w = new WebSocket(url.replace('http', 'ws') + ROUTES.ws(t));
      sockets.push(w);
      await new Promise<void>((ok, bad) => { w.once('open', ok); w.once('error', bad); });
      return new Human(w);
    }
    async info() { return (await api('GET', ROUTES.room(this.id), { headers: this.adminH() })).json as RoomPublicInfo; }
    /** Whole transcript, oldest first. */
    async transcript(): Promise<DeliveredMessage[]> {
      const out: DeliveredMessage[] = [];
      let before: number | undefined;
      for (;;) {
        const r = (await api('GET', ROUTES.messages(this.id, { beforeSeq: before, limit: 50 }), { headers: this.adminH() })).json as MessagesResponse;
        out.push(...r.messages);
        if (!r.hasMore || !r.messages.length) break;
        before = r.messages[r.messages.length - 1]!.seq;
      }
      return out.sort((x, y) => x.seq - y.seq);
    }
    async waitFor(pred: (m: DeliveredMessage) => boolean, ms: number, from = 0): Promise<DeliveredMessage | undefined> {
      const end = Date.now() + ms;
      while (Date.now() < end) { const hit = (await this.transcript()).find((m) => m.seq > from && pred(m)); if (hit) return hit; await sleep(500); }
      return undefined;
    }
  }

  async function createRoom(topic = 'e2e room') {
    const key = process.env.HOSTS_CREATE_KEY;
    const res = await api('POST', ROUTES.createRoom, { headers: key ? { [HEADERS.create]: key } : undefined, body: { topic } });
    if (res.status !== 200 && res.status !== 201) throw new Error(`create room failed: ${res.status} ${res.text}`);
    return new Room(res.json as CreateRoomResponse);
  }

  return {
    url, logs, createRoom,
    async close() {
      for (const w of sockets) w.terminate();
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await app?.close();
    },
  };
}
export type Server = Awaited<ReturnType<typeof startServer>>;
export type RoomT = Awaited<ReturnType<Server['createRoom']>>;
export type AgentT = Awaited<ReturnType<RoomT['join']>>;

export const rand = (n = 4) => randomBytes(n).toString('hex');
export const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);
