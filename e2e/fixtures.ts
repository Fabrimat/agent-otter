// Per-test real server (built output, real strict CSP), browser guard (CSP violations, console errors, stray dialogs fail the test), MCP agent helper.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HEADERS, ROUTES, type CreateRoomResponse, type JoinResponse } from '@agent-otter/protocol';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { SERVER_MAIN, WEB_DIST } from './paths';

export type Server = { url: string; port: number; logs: string[] };

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer().once('error', rej).listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

async function startServer(env: Record<string, string>): Promise<{ server: Server; stop: () => Promise<void> }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const inherited = { ...process.env } as Record<string, string | undefined>;
  for (const k of ['CREATE_KEY', 'CREATE_ROOMS', 'ROOM_TTL_SECONDS', 'TRUST_PROXY', 'MAX_ROOMS']) delete inherited[k];
  const logs: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [SERVER_MAIN], {
    env: { ...inherited, PORT: String(port), PUBLIC_URL: url, WEB_DIST, LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => logs.push(String(d)));
  const exited = new Promise<void>((res) => child.once('exit', () => res()));
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 6000);
      await exited;
      clearTimeout(t);
    }
  };
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error('server exited at startup: ' + logs.join(''));
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch { /* not up yet */ }
    if (i > 200) { await stop(); throw new Error('server did not start: ' + logs.join('')); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { server: { url, port, logs }, stop };
}

/** TCP pass-through in front of the server; `drop()` kills every live connection (a real network drop, seen by the server too). */
export async function startProxy(targetPort: number) {
  const conns = new Set<Socket>();
  const srv = createServer((c) => {
    const up = connect(targetPort, '127.0.0.1');
    for (const s of [c, up]) { conns.add(s); s.on('close', () => { conns.delete(s); (s === c ? up : c).destroy(); }); s.on('error', () => {}); }
    c.pipe(up).pipe(c);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    drop: () => conns.forEach((s) => s.destroy()),
    close: () => { conns.forEach((s) => s.destroy()); srv.close(); },
  };
}

type Issues = { list: string[]; allow: RegExp[] };

async function guard(ctx: BrowserContext, g: Issues) {
  await ctx.exposeFunction('__aoReport', (m: string) => void g.list.push(m));
  await ctx.addInitScript(() => {
    addEventListener('securitypolicyviolation', (e) => void (window as unknown as { __aoReport(m: string): void }).__aoReport(`csp violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  const note = (m: string) => { if (!g.allow.some((re) => re.test(m))) g.list.push(m); };
  ctx.on('page', (p) => {
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) note('console error: ' + m.text()); });
    p.on('pageerror', (e) => note('page error: ' + e.message));
    p.on('dialog', (d) => {
      if (d.type() === 'confirm') return void d.accept(); // our own admin confirmations
      note(`unexpected ${d.type()} dialog: ${d.message()}`);
      void d.dismiss();
    });
  });
}

export type Agent = {
  client: Client; token: string;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
};

type Fx = {
  server: Server;
  issues: Issues;
  guardCheck: void;
  newContext: () => Promise<BrowserContext>;
  /** REST helpers for rooms created without the UI. */
  rest: {
    createRoom(topic?: string): Promise<CreateRoomResponse>;
    join(room: { roomId: string; inviteSecret: string }, displayName: string): Promise<JoinResponse>;
    post(path: string, init?: { headers?: Record<string, string>; body?: unknown }): Promise<Response>;
  };
  connectAgent: (token: string) => Promise<Agent>;
};

export const test = base.extend<Fx & { serverEnv: Record<string, string> }>({
  serverEnv: [{}, { option: true }],
  server: async ({ serverEnv }, use) => {
    const { server, stop } = await startServer(serverEnv);
    try { await use(server); } finally { await stop(); }
  },
  issues: async ({}, use) => use({ list: [], allow: [] }),
  context: async ({ context, issues }, use) => {
    await guard(context, issues);
    await use(context);
  },
  guardCheck: [async ({ issues }, use) => {
    await use();
    expect(issues.list, 'browser issues (CSP violations, console errors, dialogs)').toEqual([]);
  }, { auto: true }],
  newContext: async ({ browser, issues }, use) => {
    const made: BrowserContext[] = [];
    await use(async () => {
      const c = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      await guard(c, issues);
      made.push(c);
      return c;
    });
    await Promise.all(made.map((c) => c.close()));
  },
  rest: async ({ server }, use) => {
    const post = (path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
      fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...init.headers }, body: JSON.stringify(init.body ?? {}) });
    await use({
      post,
      createRoom: async (topic = 'e2e') => (await (await post(ROUTES.createRoom, { body: { topic } })).json()) as CreateRoomResponse,
      join: async (room, displayName) =>
        (await (await post(ROUTES.join(room.roomId), { body: { inviteSecret: room.inviteSecret, displayName, vendor: 'other' } })).json()) as JoinResponse,
    });
  },
  connectAgent: async ({ server }, use) => {
    const clients: Client[] = [];
    await use(async (token) => {
      const client = new Client({ name: 'e2e-agent', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url + ROUTES.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      clients.push(client);
      return {
        client, token,
        call: async (name, args = {}) => {
          const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
          return { text: r.content[0]!.text, isError: r.isError === true };
        },
      };
    });
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  },
});

export { expect };

export type UiRoom = { roomId: string; adminSecret: string; inviteSecret: string; viewSecret: string; inviteLink: string; viewLink: string };

/** Creates a room through the home page and reads the stored secrets back (the same data the Copy buttons use). */
export async function createRoomUi(page: Page, server: Server, topic = 'e2e topic'): Promise<UiRoom> {
  await page.goto(server.url + '/');
  await page.getByLabel(/Topic/).fill(topic);
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.waitForURL(/\/r#[0-9a-f]{12}$/);
  return await roomFromStorage(page);
}

export async function roomFromStorage(page: Page): Promise<UiRoom> {
  const r = await page.evaluate(() => {
    const id = localStorage.getItem('ao:lastRoom')!;
    return JSON.parse(localStorage.getItem(`ao:room:${id}`)!) as { roomId: string; adminSecret: string; inviteSecret: string; viewSecret: string };
  });
  const origin = new URL(page.url()).origin;
  return { ...r, inviteLink: `${origin}/join#${r.roomId}.${r.inviteSecret}`, viewLink: `${origin}/view#${r.roomId}.${r.viewSecret}` };
}

export const adminHeaders = (r: { adminSecret: string }) => ({ [HEADERS.admin]: r.adminSecret });

/** Joins through the invite page (second browser context in the tests) and returns the token read from the rendered fallback URL. */
export async function joinViaUi(page: Page, inviteLink: string, name: string): Promise<{ token: string }> {
  await page.goto(inviteLink);
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  const url = await page.getByRole('region', { name: /Fallback MCP URL/ }).locator('pre').innerText();
  return { token: url.trim().split('/').at(-1)! };
}

export const transcript = (page: Page) => page.getByRole('list', { name: 'Transcript' });
