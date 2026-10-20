import { parseArgs } from 'node:util';
import { spawn as nodeSpawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { JoinResponse, ErrorResponse, ROUTES, type JoinRequest } from '@agent-otter/protocol';
import { buildConnectOutput, claudeAddArgs, claudeRemoveArgs, defaultName, disconnectOutput, parseInviteLink, VENDOR, type Host } from './core.js';

export type Io = {
  fetch: typeof fetch;
  /** Runs a command with an args array, shell:false; resolves with the exit code. */
  spawn: (cmd: string, args: string[]) => Promise<number>;
  out: (s: string) => void;
  err: (s: string) => void;
  platform: string;
  user: string;
};

export const realIo = (): Io => ({
  fetch,
  spawn: (cmd, args) => new Promise((res) => {
    const p = nodeSpawn(cmd, args, { shell: false, stdio: 'inherit' });
    p.on('error', (e) => { process.stderr.write(`could not run ${cmd}: ${e.message}\n`); res(1); });
    p.on('close', (c) => res(c ?? 1));
  }),
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  platform: process.platform,
  user: (() => { try { return userInfo().username; } catch { return process.env.USER ?? process.env.USERNAME ?? 'agent'; } })(),
});

const USAGE = `Usage:
  agent-otter connect <invite-link> --host claude|codex [--name <displayName>] [--run]
  agent-otter disconnect --host claude|codex [--run]

connect joins the room and prints the setup for your host. --run (claude only) executes "claude mcp add" for you (on Windows this needs a native claude.exe: a .cmd shim cannot be spawned without a shell).
`;

export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { io.out(USAGE); return 0; }
  if (cmd !== 'connect' && cmd !== 'disconnect') { io.err(`unknown command: ${cmd}\n\n${USAGE}`); return 1; }
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true,
      options: { host: { type: 'string' }, name: { type: 'string' }, run: { type: 'boolean', default: false } } });
    const host = values.host as Host;
    if (host !== 'claude' && host !== 'codex') throw new Error('--host claude|codex is required');
    if (values.run && host === 'codex') throw new Error('--run is not supported for codex: edit ~/.codex/config.toml by hand');

    if (cmd === 'disconnect') {
      if (values.run) return await io.spawn('claude', claudeRemoveArgs);
      io.out(disconnectOutput(host));
      return 0;
    }

    if (positionals.length !== 1) throw new Error('connect takes exactly one invite link');
    const { origin, roomId, secret } = parseInviteLink(positionals[0]!);
    const body: JoinRequest = { inviteSecret: secret, displayName: values.name ?? defaultName(io.user, host), vendor: VENDOR[host] };
    let r: Response;
    try {
      // redirect:'error': a 307/308 would otherwise re-POST the invite secret to wherever the server points
      r = await io.fetch(origin + ROUTES.join(roomId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch (e) {
      // never print the thrown error: its text can carry the URL
      const name = (e as Error | null)?.name;
      const cause = (e as { cause?: { message?: string } } | null)?.cause?.message ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new Error('join timed out');
      if (/redirect/i.test(cause)) throw new Error('the server tried to redirect the join request; refusing to send the invite secret elsewhere');
      throw new Error('could not reach server');
    }
    const json: unknown = await r.json().catch(() => null);
    if (!r.ok) {
      const e = ErrorResponse.safeParse(json);
      throw new Error(`join failed (${r.status}): ${e.success ? `${e.data.error.split(secret).join('[redacted]').replace(/[^\x20-\x7e]/g, '').slice(0, 200)}${e.data.code ? ` [${e.data.code}]` : ''}` : 'unexpected response'}`);
    }
    const res = JoinResponse.safeParse(json);
    if (!res.success) throw new Error('the server sent an unexpected join response');

    let text: string;
    try { text = buildConnectOutput(host, origin, res.data.token, io.platform, values.run); } catch { throw new Error('the server sent an invalid token'); }
    io.out(text);
    return values.run ? await io.spawn('claude', claudeAddArgs(origin)) : 0;
  } catch (e) {
    io.err(`agent-otter: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
