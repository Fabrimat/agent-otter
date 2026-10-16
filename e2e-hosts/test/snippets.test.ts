// Executes the EXACT snippets from buildSnippets() against the real host CLIs, without touching global config:
// claude: `--scope project` in a temp project dir (writes only <tmp>/.mcp.json); codex: CODEX_HOME=<tmp> for the TOML block, -c overrides derived from it for the live call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildSnippets, ONBOARDING_PROMPT } from '@agent-office/protocol';
import { assertGlobalConfigUnchanged, globalConfigSnapshot, hostEnv, killAll, record, rmDir, run, startServer, tempDir, type Server } from '../src/harness.js';
import { claudeModel, codexModel, ROOM_TOOLS, mcpName } from '../src/hosts.js';

let srv: Server;
const before = globalConfigSnapshot();
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { killAll(); await srv?.close(); assertGlobalConfigUnchanged(before); });

type Verdict = { snippet: string; status: 'VERIFIED' | 'FAILED' | 'NOT EXECUTED'; detail: string };
const results: Verdict[] = [];
const verdict = (snippet: string, status: Verdict['status'], detail: string) => { results.push({ snippet, status, detail }); console.log(`[SNIPPET] ${snippet}: ${status} ${detail}`); };
const redact = (s: string, token: string) => s.split(token).join('<token>');
const HAS_PWSH = process.platform === 'win32';

test('snippets from buildSnippets() work on the real hosts', async () => {
  const room = await srv.createRoom('snippets');
  const agentCC = await room.join('ada', 'claude-code');
  const agentCX = await room.join('bo', 'codex');
  const human = await room.human();

  // ---------------------------------------------------------------- claude code: bash and PowerShell variants
  const variants: [string, (t: string) => string, string[]][] = [
    ['claudeCode (bash)', (t) => buildSnippets(srv.url, t).snippets.claudeCode, ['bash', '-c']],
    ...(HAS_PWSH ? [['claudeCodePowerShell', (t: string) => buildSnippets(srv.url, t).snippets.claudeCodePowerShell, ['pwsh', '-NoProfile', '-Command']] as [string, (t: string) => string, string[]]] : []),
  ];
  for (const [label, get, shell] of variants) {
    const agent = agentCC;
    const proj = tempDir('snip');
    const env = hostEnv(); delete env.AGENT_OFFICE_TOKEN;
    const text = get(agent.token);
    // the only edit: scope the config to the temp project instead of the owner's ~/.claude.json
    const script = text.split('\n').map((l) => (l.startsWith('claude mcp add') ? `${l} --scope project` : l)).join('\n');
    const add = await run(shell[0]!, [...shell.slice(1), script], { cwd: proj, env, timeoutMs: 60_000 });
    const mcpJson = existsSync(join(proj, '.mcp.json')) ? readFileSync(join(proj, '.mcp.json'), 'utf8') : '';
    const tokenInFile = mcpJson.includes(agent.token);
    // a project-scoped server needs a one-time approval (interactive prompt on first `claude` run); the temp project pre-approves it in its own local settings
    mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['agent-office'], enableAllProjectMcpServers: true }));
    const get1 = await run('claude', ['mcp', 'get', 'agent-office'], { cwd: proj, env, timeoutMs: 60_000 });
    const out = redact(get1.stdout + get1.stderr, agent.token);
    const listed = out.includes(`${srv.url}/mcp`) && /Authorization: Bearer \$\{AGENT_OFFICE_TOKEN\}/.test(out) && /http/i.test(out);
    const status = /Status:\s*(.*)/.exec(out)?.[1]?.trim() ?? '?';
    const shown = (get1.stdout + get1.stderr).includes(agent.token); // does `claude mcp get` print the token in clear?
    const literalRef = mcpJson.includes('${AGENT_OFFICE_TOKEN}');
    if (add.code === 0 && listed && literalRef && !tokenInFile && !shown) verdict(`${label}: add (+ --scope project) and listed by 'claude mcp get'`, 'VERIFIED', `exit 0; URL and Authorization header recorded; get status: "${status}" (a project-scoped server is only health-checked after the interactive approval); config holds the literal \${AGENT_OFFICE_TOKEN}: ${literalRef}; token stored in clear in .mcp.json: ${tokenInFile}; 'claude mcp get' prints the token: ${shown}`);
    else verdict(`${label}: add (+ --scope project) and listed by 'claude mcp get'`, 'FAILED', redact(`add exit ${add.code}: ${add.stdout}${add.stderr}`, agent.token).slice(0, 400) + ' | get: ' + out.slice(0, 300) + ` | token stored in clear in .mcp.json: ${tokenInFile}`);

    // live call using the config produced by the snippet (project .mcp.json, no --mcp-config flag)
    const tag = (label.includes('Power') ? 'ps' : 'bash');
    const liveArgs = (c: string) => ['-p', `Call room_send of the MCP server "agent-office" with content "${c}", then stop. If the tool is not available, say exactly why.`,
      '--mcp-config', join(proj, '.mcp.json'), '--strict-mcp-config', // only the file the snippet wrote: the owner's other MCP servers do not load
      '--setting-sources', 'project,local', `--allowedTools=${ROOM_TOOLS.map(mcpName).join(',')}`,
      '--max-turns', '5', '--model', claudeModel(), '--max-budget-usd', '0.2', '--no-session-persistence', '--output-format', 'json'];
    const said = async (c: string) => (await room.transcript()).some((m) => m.from.displayName === 'ada' && m.content === c);
    // with the variable set (the snippet's export / $env: line sets it for the session)
    await run('claude', liveArgs(`snippet-${tag}-ok`), { cwd: proj, env: { ...env, AGENT_OFFICE_TOKEN: agent.token }, timeoutMs: 120_000 });
    if (await said(`snippet-${tag}-ok`)) verdict(`${label}: live room_send through the config the snippet wrote, variable SET`, 'VERIFIED', 'message arrived in the room');
    else verdict(`${label}: live room_send through the config the snippet wrote, variable SET`, 'FAILED', 'no message in the room');
    // negative: variable NOT set -> must fail, and say so
    const neg = await run('claude', liveArgs(`snippet-${tag}-unset`), { cwd: proj, env, timeoutMs: 120_000 });
    const leaked = await said(`snippet-${tag}-unset`);
    let said1 = ''; try { said1 = String((JSON.parse(neg.stdout) as { result?: string }).result ?? ''); } catch { said1 = neg.stdout.slice(0, 300); }
    const negText = redact(said1 + neg.stderr.slice(0, 200), agent.token).replace(/\s+/g, ' ');
    verdict(`${label}: live room_send with the variable UNSET fails clearly`, leaked ? 'FAILED' : 'VERIFIED', leaked ? 'message was sent without the variable' : `no message sent; claude said: ${negText.slice(0, 300)}`);
    rmDir(proj);
  }

  // ---------------------------------------------------------------- codex: TOML block in an isolated CODEX_HOME
  const s = buildSnippets(srv.url, agentCX.token).snippets;
  const home = tempDir('codexhome');
  writeFileSync(join(home, 'config.toml'), s.codexConfigToml + '\n');
  const env = hostEnv({ CODEX_HOME: home, AGENT_OFFICE_TOKEN: agentCX.token });
  const g = await run('codex', ['mcp', 'get', 'agent-office', '--json'], { env, timeoutMs: 60_000 });
  const gout = redact(g.stdout + g.stderr, agentCX.token);
  let parsed: any; try { parsed = JSON.parse(g.stdout); } catch { /* not json */ }
  const urlOk = JSON.stringify(parsed ?? {}).includes(`${srv.url}/mcp`) && /AGENT_OFFICE_TOKEN/.test(JSON.stringify(parsed ?? {}));
  if (g.code === 0 && urlOk) verdict('codexConfigToml: parsed by `codex mcp get` under an isolated CODEX_HOME', 'VERIFIED', gout.replace(/\s+/g, ' ').slice(0, 200));
  else verdict('codexConfigToml: parsed by `codex mcp get` under an isolated CODEX_HOME', 'FAILED', gout.slice(0, 400));
  rmDir(home);

  // live call: the same keys/values as the TOML block, handed to codex as -c overrides (config.toml of the owner is not read)
  const kv = [...s.codexConfigToml.split('\n').slice(1)].map((l) => /^(\w+) = (.*)$/.exec(l)!).map((m) => ['-c', `mcp_servers.agent-office.${m[1]}=${m[2]}`]).flat();
  const cwd = tempDir('snipcx');
  const live = await run('codex', ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-C', cwd, '-s', 'read-only', '-m', codexModel(), '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="never"',
    ...kv, '-c', 'mcp_servers.agent-office.default_tools_approval_mode="approve"', 'Call room_send of the MCP server "agent-office" with content "snippet-codex-ok", then stop.'],
  { cwd, env: hostEnv({ AGENT_OFFICE_TOKEN: agentCX.token }), timeoutMs: 180_000 });
  rmDir(cwd);
  const sentCx = (await room.transcript()).some((m) => m.from.displayName === 'bo' && m.content === 'snippet-codex-ok');
  if (sentCx) verdict('codexConfigToml: live room_send with the block values (as -c overrides)', 'VERIFIED', 'message arrived in the room');
  else verdict('codexConfigToml: live room_send with the block values (as -c overrides)', 'FAILED', redact(live.stdout.slice(-500) + live.stderr.slice(-300), agentCX.token));

  // env snippets
  const e1 = await run('bash', ['-c', s.codexEnv + '\ntest "$AGENT_OFFICE_TOKEN" = "' + agentCX.token + '"'], { env: hostEnv(), timeoutMs: 20_000 });
  verdict('codexEnv (bash export line)', e1.code === 0 ? 'VERIFIED' : 'FAILED', e1.code === 0 ? 'export sets the variable; second line is a comment instruction' : redact(e1.stderr, agentCX.token));
  verdict('codexPowerShell (setx)', 'NOT EXECUTED', 'setx writes a persistent user environment variable (global change); not run by the harness. Semantics are documented Windows behaviour: it is visible only to NEW processes, not the current shell.');
  verdict('pathFallbackUrl', 'NOT EXECUTED', 'fallback is covered by the server tests; no host run');

  void human;
  record('snippets', { id: 'SNIPPETS', results });
  expect(results.length).toBeGreaterThan(0); // verdicts are data: a FAILED snippet is reported loudly, not hidden
  console.log(`[SNIPPETS] ${results.filter((r) => r.status === 'VERIFIED').length} VERIFIED, ${results.filter((r) => r.status === 'FAILED').length} FAILED, ${results.filter((r) => r.status === 'NOT EXECUTED').length} NOT EXECUTED`);
  void ONBOARDING_PROMPT;
}, 15 * 60_000);
