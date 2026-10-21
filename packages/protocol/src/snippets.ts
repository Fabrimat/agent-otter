import { AGENT_TOKEN } from './routes.js';

// Host setup snippets. Pure string builders; the token is only ever placed in an env var assignment or the fallback URL.
const NAME = 'lesscubicles';
const ENV = 'LESSCUBICLES_TOKEN';

export const SNIPPETS_NOTE =
  'Executed OK on Windows with Claude Code 2.1.301 and Codex CLI 0.163.0 (2026-10-16, see docs/hosts): claude mcp add in bash and PowerShell (run with project scope), and the Codex TOML block (applied as config overrides, not written to a real config.toml). ' +
  'NOT executed: the setx line, the path-fallback URL, the default and user scope of claude mcp add. UNTESTED on every other host (OpenCode, Hermes, ...), version and OS: check your host docs if one fails. ' +
  'Prefer the Authorization header over the path URL (URLs leak into logs and shell history). ' +
  'Claude Code keeps the ${LESSCUBICLES_TOKEN} reference in its config and reads the variable at runtime: set it in every shell that starts the agent. ' +
  'Do not run your agent in a permission-bypass mode while in a room with strangers.';

export type Snippets = {
  claudeCode: string; claudeCodePowerShell: string; codexConfigToml: string; codexEnv: string; codexPowerShell: string; pathFallbackUrl: string;
};

/** `baseUrl` is the public origin of the server (no path). Throws on values that could break out of a shell string. */
export function buildSnippets(baseUrl: string, token: string): { snippets: Snippets; note: string } {
  if (!/^https?:\/\/[A-Za-z0-9.:_/-]+$/.test(baseUrl)) throw new Error('invalid baseUrl');
  if (!AGENT_TOKEN.test(token)) throw new Error('invalid token');
  const url = `${baseUrl.replace(/\/+$/, '')}/mcp`;
  // --header is variadic in `claude mcp add`: name and URL must come BEFORE it.
  // single quotes: the shell must NOT expand the variable, so the config keeps the literal ${LESSCUBICLES_TOKEN} that Claude Code expands at runtime
  const add = () => `claude mcp add --transport http ${NAME} ${url} --header 'Authorization: Bearer \${${ENV}}'`;
  return {
    snippets: {
      claudeCode: `export ${ENV}=${token}\n${add()}`,
      claudeCodePowerShell: `$env:${ENV} = "${token}"\n${add()}`,
      codexConfigToml: `[mcp_servers.${NAME}]\nurl = "${url}"\nbearer_token_env_var = "${ENV}"`,
      codexEnv: `export ${ENV}=${token}\n# then add the config.toml block to ~/.codex/config.toml and restart Codex`,
      codexPowerShell: `setx ${ENV} "${token}"\n# then add the config.toml block to ~/.codex/config.toml and restart Codex`,
      pathFallbackUrl: `${url}/${token}`,
    },
    note: SNIPPETS_NOTE,
  };
}
