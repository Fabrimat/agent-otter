// Drivers for the unmodified vendor CLIs in non-interactive mode. Everything is per-run configuration (flags, -c overrides,
// temp dirs, env vars): the owner's global config is never written. Permission-bypass flags are never used.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_USD, RESULTS_DIR, hostEnv, run, type AgentT, type RunResult } from './harness.js';

export const SERVER_NAME = 'agent-office';
export const ROOM_TOOLS = ['room_send', 'room_inbox', 'room_history', 'room_participants', 'room_leave'] as const;
export const mcpName = (t: string) => `mcp__${SERVER_NAME}__${t}`;

export type ToolCall = { t: number; tEnd?: number; tool: string; server?: string; args: unknown; isError?: boolean; result?: string };
export type HostRun = {
  host: 'claude-code' | 'codex';
  version: string;
  model: string;
  ms: number;
  code: number | null;
  timedOut: boolean;
  calls: ToolCall[];          // every tool call the agent made (MCP or built-in)
  denied: { tool: string; input: unknown }[]; // permission denials reported by the host
  finalText: string;
  costUsd?: number;
  turns?: number;
  endReason?: string;         // claude: result subtype (success, error_max_turns, ...)
  usage?: unknown;            // token usage as reported by the host
  stderrTail: string;
  initInfo?: unknown;
  modelId?: string;           // model id the host reported at init (claude)
  raw: RunResult;
};

const txt = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x));
const parseLines = (r: RunResult) => r.lines.flatMap(({ t, line }) => { try { return [{ t, j: JSON.parse(line) as Record<string, any> }]; } catch { return []; } });

export const claudeModel = () => process.env.HOSTS_CLAUDE_MODEL ?? 'haiku';
export const codexModel = () => process.env.HOSTS_CODEX_MODEL ?? 'gpt-6-luna';

// Cost guard (parallel-safe): every claude run RESERVES its per-run budget before launch (append-only ledger, one line per event); when it finishes
// the line is superseded by the actual cost reported by the host. A run without a reported cost (timeout, crash) stays counted at its reserved budget.
const SPEND = join(RESULTS_DIR, 'spend.jsonl');
const NL = String.fromCharCode(10);
function ledger(): Map<string, number> {
  const m = new Map<string, number>();
  if (existsSync(SPEND)) for (const l of readFileSync(SPEND, 'utf8').split(NL).filter(Boolean)) { const e = JSON.parse(l) as { id: string; usd: number }; m.set(e.id, e.usd); }
  return m;
}
export const spentUsd = () => [...ledger().values()].reduce((a, x) => a + x, 0);
const book = (id: string, usd: number) => { mkdirSync(RESULTS_DIR, { recursive: true }); appendFileSync(SPEND, JSON.stringify({ id, usd }) + NL); };

export type ClaudeOpts = {
  toolTimeoutMs?: number;  // MCP_TOOL_TIMEOUT for the run
  agent: AgentT; cwd: string; prompt: string; maxTurns: number; timeoutMs: number;
  allowTools?: string[];   // extra tools auto-allowed besides the room tools (e.g. 'Read')
  denyTools?: string[];
  budgetUsd?: number;
};

/** `claude -p` with a per-run MCP config (token via env var expansion, never written to disk), strict MCP config and the project-only settings source. */
export async function runClaude(o: ClaudeOpts): Promise<HostRun> {
  const left = MAX_USD - spentUsd();
  if (left <= 0.01) throw new Error(`HOSTS_MAX_USD (${MAX_USD}) exhausted: refusing to start another claude run`);
  const budget = Math.min(o.budgetUsd ?? 0.25, left);
  const runId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  book(runId, budget); // reserve before launch
  const cfgPath = join(o.cwd, `.mcp-run-${o.agent.name}.json`);
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: o.agent.mcpUrl, headers: { Authorization: 'Bearer ${AGENT_OFFICE_TOKEN}' } } } }));
  const allowed = [...ROOM_TOOLS.map(mcpName), ...(o.allowTools ?? [])];
  const args = [
    '-p', o.prompt,
    '--mcp-config', cfgPath, '--strict-mcp-config',
    `--allowedTools=${allowed.join(',')}`,
    ...(o.denyTools?.length ? [`--disallowedTools=${o.denyTools.join(',')}`] : []),
    '--max-turns', String(o.maxTurns),
    '--model', claudeModel(),
    '--max-budget-usd', String(budget),
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--permission-mode', 'default',
  ];
  const r = await run('claude', args, { cwd: o.cwd, timeoutMs: o.timeoutMs, env: hostEnv({ AGENT_OFFICE_TOKEN: o.agent.token, ...(o.toolTimeoutMs ? { MCP_TOOL_TIMEOUT: String(o.toolTimeoutMs) } : {}) }) });
  if (/session limit|usage limit|rate limit exceeded/i.test(r.stderr + r.stdout.slice(0, 2000)) && r.code !== 0) throw new Error('Claude usage limit reached (host said: ' + (r.stderr || r.stdout).slice(0, 120).trim() + '): this is not a product failure; re-run after the reset');
  const ev = parseLines(r);
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  let result: Record<string, any> | undefined, init: unknown;
  for (const { t, j } of ev) {
    if (j.type === 'system' && j.subtype === 'init') init = { tools: j.tools, mcp_servers: j.mcp_servers, model: j.model, permissionMode: j.permissionMode };
    if (j.type === 'assistant') for (const b of j.message?.content ?? []) if (b.type === 'tool_use') { const c: ToolCall = { t, tool: b.name, args: b.input }; calls.push(c); byId.set(b.id, c); }
    if (j.type === 'user') for (const b of j.message?.content ?? []) if (b.type === 'tool_result') {
      const c = byId.get(b.tool_use_id);
      if (c) { c.tEnd = t; c.isError = !!b.is_error; c.result = Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join('\n') : txt(b.content); }
    }
    if (j.type === 'result') result = j;
  }
  if (!r.timedOut && typeof result?.total_cost_usd === 'number') book(runId, Math.min(result.total_cost_usd, budget));
  const version = (await run('claude', ['--version'], { timeoutMs: 20_000 })).stdout.trim();
  return {
    host: 'claude-code', version, model: claudeModel(), ms: r.ms, code: r.code, timedOut: r.timedOut, calls,
    denied: (result?.permission_denials ?? []).map((d: any) => ({ tool: d.tool_name, input: d.tool_input })),
    finalText: String(result?.result ?? ''), costUsd: result?.total_cost_usd, turns: result?.num_turns, usage: result?.usage, endReason: result?.subtype,
    stderrTail: r.stderr.slice(-600), initInfo: init, modelId: (init as { model?: string } | undefined)?.model, raw: r,
  };
}

export type CodexOpts = { agent: AgentT; cwd: string; prompt: string; timeoutMs: number; noShell?: boolean; toolTimeoutSec?: number; model?: string; noApprove?: boolean };

/**
 * `codex exec` with only -c overrides, `--ignore-user-config` (the owner's config.toml is not even read; auth still comes from CODEX_HOME),
 * a read-only sandbox, no shell approvals bypass. MCP tool approvals: see runCodex notes in docs/hosts/codex.md.
 */
export async function runCodex(o: CodexOpts): Promise<HostRun> {
  const s = `mcp_servers.${SERVER_NAME}`;
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '-C', o.cwd, '-s', 'read-only', '-m', o.model ?? codexModel(),
    '-c', 'model_reasoning_effort="low"',
    '-c', `${s}.url=${JSON.stringify(o.agent.mcpUrl)}`,
    '-c', `${s}.bearer_token_env_var="AGENT_OFFICE_TOKEN"`,
    ...(o.noApprove ? [] : ['-c', `${s}.default_tools_approval_mode="approve"`]), // MCP room tools auto-approved; shell stays read-only/sandboxed
    '-c', 'approval_policy="never"',
    ...(o.noShell ? ['--disable', 'shell_tool', '--disable', 'unified_exec'] : []),
    ...(o.toolTimeoutSec ? ['-c', `${s}.tool_timeout_sec=${o.toolTimeoutSec}`] : []),
    o.prompt,
  ];
  const r = await run('codex', args, { cwd: o.cwd, timeoutMs: o.timeoutMs, env: hostEnv({ AGENT_OFFICE_TOKEN: o.agent.token }) });
  const ev = parseLines(r);
  const calls: ToolCall[] = [];
  let finalText = '', turns = 0, usage: unknown;
  const started = new Map<string, number>();
  for (const { t, j } of ev) {
    if (j.type === 'turn.completed') { turns++; usage = j.usage; }
    if (j.type === 'item.started') started.set(j.item?.id, t);
    if (j.type === 'item.completed' || j.type === 'item.started') {
      const it = j.item ?? {};
      if (it.type === 'agent_message' && j.type === 'item.completed') finalText = String(it.text ?? '');
      if (j.type !== 'item.completed') continue;
      if (it.type === 'mcp_tool_call') calls.push({ t: started.get(it.id) ?? t, tEnd: t, tool: it.tool, server: it.server, args: it.arguments, isError: it.status === 'failed' || !!it.error, result: txt(it.result?.content ?? it.error ?? '') });
      else if (it.type === 'command_execution') calls.push({ t: started.get(it.id) ?? t, tEnd: t, tool: 'shell', args: it.command, isError: it.exit_code !== 0, result: String(it.aggregated_output ?? '').slice(0, 300) });
      else if (it.type === 'file_change') calls.push({ t, tool: 'file_change', args: it.changes });
    }
  }
  const version = (await run('codex', ['--version'], { timeoutMs: 20_000 })).stdout.trim();
  return { host: 'codex', version, model: o.model ?? codexModel(), ms: r.ms, code: r.code, timedOut: r.timedOut, calls, denied: [], finalText, turns, usage, stderrTail: r.stderr.slice(-600), raw: r };
}
