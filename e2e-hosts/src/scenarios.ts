// Shared helpers for the host scenarios (H1..H4).
import { ONBOARDING_PROMPT, TOOL_DESCRIPTIONS, AGENT_INSTRUCTIONS } from '@agent-office/protocol';
import { runClaude, runCodex, SERVER_NAME, type HostRun, type ToolCall } from './hosts.js';
import { sleep, type AgentT, type RoomT } from './harness.js';

export type HostId = 'claude-code' | 'codex';
export const HOSTS: HostId[] = ['claude-code', 'codex'];
export const NAME: Record<HostId, string> = { 'claude-code': 'ada', codex: 'bo' };

export const isRoomCall = (c: ToolCall) => c.tool.startsWith(`mcp__${SERVER_NAME}__`) || c.server === SERVER_NAME || c.tool.startsWith('room_');
export const roomTool = (c: ToolCall) => c.tool.replace(`mcp__${SERVER_NAME}__`, '');

/** The product's onboarding prompt, verbatim, plus a clearly separated harness note that bounds the test run. */
export const prompt = (note: string) => `${ONBOARDING_PROMPT}\n\n--- test harness note (not part of the product prompt) ---\n${note}`;

export type Opts = { cwd: string; timeoutMs: number; maxTurns?: number; allowRead?: boolean; denyRead?: boolean; toolTimeout?: number; shell?: boolean };

/** Starts the host; one retry (recorded as `retried`) when the run ended with no successful tool call and a connection-type error (seen once with codex when two hosts start together). */
export async function startHost(host: HostId, agent: AgentT, p: string, o: Opts): Promise<HostRun & { retried?: boolean }> {
  const r = await startOnce(host, agent, p, o);
  const failedConnect = !r.timedOut && r.calls.length > 0 && r.calls.every((c) => c.isError) && r.calls.some((c) => /connect|transport|refused|reset|closed/i.test(c.result ?? '')) || (r.code !== 0 && r.calls.length === 0 && !r.timedOut && /connect|transport|refused|reset/i.test(r.stderrTail));
  if (!failedConnect) return r;
  console.log(`[retry] ${host}: connection-type failure, retrying once: ${(r.calls[0]?.result ?? r.stderrTail).slice(0, 160)}`);
  return { ...(await startOnce(host, agent, p, o)), retried: true };
}

// Codex victims run WITHOUT the shell tool by default (--disable shell_tool): on Windows the shell path starts Codex's sandbox machinery, and forcing
// its elevated mode once spawned codex-windows-sandbox-setup.exe, which burned minutes of CPU on a profile-wide ACL refresh. `shell: true` is only for the
// explicit codexShellProbe in h4.test.ts (read-only sandbox, never the elevated option).
function startOnce(host: HostId, agent: AgentT, p: string, o: Opts): Promise<HostRun> {
  if (host === 'claude-code') {
    return runClaude({
      agent, cwd: o.cwd, prompt: p, maxTurns: o.maxTurns ?? 12, timeoutMs: o.timeoutMs,
      allowTools: o.allowRead ? ['Read'] : [],
      denyTools: o.denyRead ? ['Read', 'Grep', 'Glob'] : [],
      toolTimeoutMs: o.toolTimeout ? o.toolTimeout * 1000 : undefined,
    });
  }
  return runCodex({ agent, cwd: o.cwd, prompt: p, timeoutMs: o.timeoutMs, noShell: !o.shell, toolTimeoutSec: o.toolTimeout });
}

export function inboxStats(calls: ToolCall[]) {
  const inbox = calls.filter((c) => isRoomCall(c) && roomTool(c) === 'room_inbox');
  const empty = inbox.filter((c) => !c.isError && /\(no messages\)/.test(c.result ?? ''));
  const ms = (c: ToolCall) => (c.tEnd ?? c.t) - c.t;
  return {
    calls: inbox.length,
    empty: empty.length,
    errors: inbox.filter((c) => c.isError).length,
    emptyDurationsMs: empty.map(ms),
    waitArgs: inbox.map((c) => (c.args as { waitSeconds?: number } | undefined)?.waitSeconds ?? null),
  };
}

/** Waits until the participant has touched the server (lastSeen set), then a few seconds so the agent is parked in a long-poll. */
export async function waitInRoom(room: RoomT, names: string[], ms: number, settleMs = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const info = await room.info();
    if (names.every((n) => info.participants.find((p) => p.displayName === n)?.lastSeen)) { await sleep(settleMs); return true; }
    await sleep(500);
  }
  return false;
}

export const keyPhrases = {
  instructions: AGENT_INSTRUCTIONS.split('\n')[0]!.slice(0, 40),
  description: TOOL_DESCRIPTIONS.room_inbox.slice(0, 40),
};
export const strip = ({ raw, ...r }: HostRun) => ({ ...r, rawLines: raw.lines.length, stdoutTail: raw.stdout.slice(-300) });
export { runClaude, runCodex };
