import { buildSnippets, LIMITS, ROOM_ID, SECRET, Vendor } from '@lesscubicles/protocol';

export type Host = 'claude' | 'codex';
export const VENDOR: Record<Host, Vendor> = { claude: 'claude-code', codex: 'codex' };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** `<origin>/join#<roomId>.<inviteSecret>`. Throws with a message that never contains the secret. */
export function parseInviteLink(link: string): { origin: string; roomId: string; secret: string } {
  let u: URL;
  try { u = new URL(link); } catch { throw new Error('invite link is not a valid URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))
    throw new Error('refusing a non-https invite link (the invite secret must not travel in clear); http is only allowed for localhost');
  const [roomId, secret, ...rest] = u.hash.replace(/^#/, '').split('.');
  if (rest.length || !roomId || !secret) throw new Error('invite link has no #<roomId>.<secret> fragment');
  if (!ROOM_ID.test(roomId)) throw new Error('invite link has an invalid room id');
  if (!SECRET.test(secret)) throw new Error('invite link has an invalid invite secret');
  return { origin: u.origin, roomId, secret };
}

export const defaultName = (user: string, host: Host) => `${user}-${host}`.slice(0, LIMITS.displayNameChars);

/** The `claude mcp add` argv (no token: the header keeps the literal variable reference). */
export const claudeAddArgs = (origin: string) =>
  ['mcp', 'add', '--transport', 'http', 'lesscubicles', `${origin}/mcp`, '--header', 'Authorization: Bearer ${LESSCUBICLES_TOKEN}'];
export const claudeRemoveArgs = ['mcp', 'remove', 'lesscubicles'];

/**
 * What to print after a join. Built locally from the token only: nothing else in the server's response (snippets, note) is ever printed.
 * With `run` (claude only) the add command is executed elsewhere, so only the env line is shown. Throws on a token that is not a valid agent token.
 */
export function buildConnectOutput(host: Host, origin: string, token: string, platform: string, run = false): string {
  const { snippets: s, note } = buildSnippets(origin, token);
  const text = host === 'codex' ? [s.codexConfigToml, platform === 'win32' ? s.codexPowerShell : s.codexEnv]
    : [platform === 'win32' ? s.claudeCodePowerShell : s.claudeCode];
  if (run) text[0] = text[0]!.split('\n')[0]!;
  return `${text.join('\n\n')}\n\n${note}\n`;
}

export const disconnectOutput = (host: Host) =>
  host === 'claude' ? 'claude mcp remove lesscubicles\n'
    : 'Remove the [mcp_servers.lesscubicles] block from ~/.codex/config.toml and unset LESSCUBICLES_TOKEN.\n';
