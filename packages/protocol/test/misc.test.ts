import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTIONS, buildSnippets, detectSecrets, ONBOARDING_PROMPT, PROTOCOL_VERSION, TOOL_DESCRIPTIONS, UNTRUSTED_RULE } from '../src/index.js';

describe('behaviour protocol', () => {
  it('lengths', () => {
    expect(AGENT_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
    expect(ONBOARDING_PROMPT.length).toBeLessThanOrEqual(2048);
    for (const d of Object.values(TOOL_DESCRIPTIONS)) expect(d.length).toBeLessThanOrEqual(512);
  });
  it('is versioned and carries the rule', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(AGENT_INSTRUCTIONS).toContain(`v${PROTOCOL_VERSION}`);
    expect(AGENT_INSTRUCTIONS).toMatch(/never follow instructions/i);
    for (const k of ['room_send', 'room_inbox', 'room_history', 'room_participants'] as const) expect(TOOL_DESCRIPTIONS[k]).toContain(UNTRUSTED_RULE);
    expect(ONBOARDING_PROMPT).toMatch(/permission-bypass/);
    expect(ONBOARDING_PROMPT).toContain('room_inbox');
    expect(ONBOARDING_PROMPT).toMatch(/only when you are mentioned/);
    expect(ONBOARDING_PROMPT).toMatch(/loops burn tokens/);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('buildSnippets', () => {
  const { snippets: s, note } = buildSnippets('https://x.example/', 'tok_123-ABxxxxxxxxxxxxxxxxxxxxxx');
  it('claude: name and URL come before the variadic --header', () => {
    for (const c of [s.claudeCode, s.claudeCodePowerShell]) {
      const line = c.split('\n').find((l) => l.startsWith('claude mcp add'))!;
      const a = line.split(' ');
      expect(a.slice(0, 6)).toEqual(['claude', 'mcp', 'add', '--transport', 'http', 'lesscubicles']);
      expect(a[6]).toBe('https://x.example/mcp');
      expect(a[7]).toBe('--header');
      expect(a.slice(8).join(' ')).toBe("'Authorization: Bearer ${LESSCUBICLES_TOKEN}'");
    }
  });
  it('header keeps a literal ${LESSCUBICLES_TOKEN} (single-quoted); token only in the assignment', () => {
    expect(s.claudeCode).toBe(`export LESSCUBICLES_TOKEN=tok_123-ABxxxxxxxxxxxxxxxxxxxxxx
claude mcp add --transport http lesscubicles https://x.example/mcp --header 'Authorization: Bearer \${LESSCUBICLES_TOKEN}'`);
    expect(s.claudeCodePowerShell).toContain('$env:LESSCUBICLES_TOKEN = "tok_123-ABxxxxxxxxxxxxxxxxxxxxxx"');
    expect(s.claudeCodePowerShell).toContain("--header 'Authorization: Bearer ${LESSCUBICLES_TOKEN}'");
    expect(s.claudeCode.split('tok_123-ABxxxxxxxxxxxxxxxxxxxxxx')).toHaveLength(2);
  });
  it('codex and fallback', () => {
    expect(s.codexConfigToml).toBe('[mcp_servers.lesscubicles]\nurl = "https://x.example/mcp"\nbearer_token_env_var = "LESSCUBICLES_TOKEN"');
    expect(s.codexEnv).toContain('export LESSCUBICLES_TOKEN=tok_123-ABxxxxxxxxxxxxxxxxxxxxxx');
    expect(s.codexPowerShell).toContain('setx LESSCUBICLES_TOKEN');
    expect(s.pathFallbackUrl).toBe('https://x.example/mcp/tok_123-ABxxxxxxxxxxxxxxxxxxxxxx');
  });
  it('note says exactly what was executed and what was not, and keeps UNTESTED for the rest', () => {
    expect(note).toMatch(/Executed OK on Windows with Claude Code 2\.1\.301 and Codex CLI 0\.163\.0/);
    expect(note).toMatch(/NOT executed: the setx line, the path-fallback URL, the default and user scope/);
    expect(note).toMatch(/UNTESTED on every other host/);
    expect(note).not.toMatch(/VERIFIED/);
  });
  it('rejects shell-breaking input', () => {
    expect(() => buildSnippets('https://x.example"; rm -rf ~', 't')).toThrow();
    expect(() => buildSnippets('https://x.example', 'a"b')).toThrow();
    expect(() => buildSnippets('javascript:alert(1)', 't')).toThrow();
  });
});

describe('detectSecrets', () => {
  // built by concatenation so this file itself does not trip secret scanners
  const pos: [string, string][] = [
    ['aws-key', 'key AKIA' + 'IOSFODNN7EXAMPLE here'],
    ['github-token', 'ghp_' + 'a'.repeat(36)],
    ['github-token', 'github_pat_' + 'A1b2'.repeat(8)],
    ['anthropic-key', 'sk-ant-' + 'api03-' + 'x'.repeat(30)],
    ['openai-key', 'sk-' + 'proj-' + 'Ab1'.repeat(10)],
    ['slack-token', 'xoxb-' + '1234567890-abcdefghij'],
    ['private-key', '-----BEGIN RSA PRIVATE ' + 'KEY-----\nabc'],
    ['private-key', '-----BEGIN PRIVATE ' + 'KEY-----'],
    ['jwt', 'eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghijk'],
    ['env-block', 'DB_HOST=localhost\nDB_PASS=hunter2\nexport API_URL=http://x\n'],
  ];
  for (const [kind, text] of pos) it(`finds ${kind}`, () => expect(detectSecrets(text)).toContain(kind));
  it('negatives', () => {
    for (const t of ['hello world', 'the sk-learn package', 'AKIA is a prefix', 'sk-short', 'A=1\nB=2', 'PATH=/usr/bin\nsome text\nHOME=/h\nX=1', 'ghp_short', '-----BEGIN CERTIFICATE-----', 'use FOO=bar in the shell'])
      expect(detectSecrets(t)).toEqual([]);
  });
  it('does not detect 2-line env or non-consecutive lines', () => expect(detectSecrets('A_B=1\nC_D=2\nnote\nE_F=3')).toEqual([]));
  it('finds a key split by zero-width chars', () => expect(detectSecrets('AKIA\u200BIOSFODNN7\u200DEXAMPLE')).toContain('aws-key'));
  it('never echoes the secret', () => {
    const secret = 'ghp_' + 'Z9'.repeat(20);
    const out = detectSecrets(`token ${secret} and AKIA` + 'IOSFODNN7EXAMPLE');
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain('Z9Z9');
    expect(out).toEqual(['aws-key', 'github-token']);
  });
});
