import { AGENT_TOKEN } from './routes.js';

// Host setup snippets. Pure string builders; the token is only ever placed in an env var assignment or the fallback URL.
const NAME = 'agent-office';
const ENV = 'AGENT_OFFICE_TOKEN';

export const SNIPPETS_NOTE =
  'UNTESTED: these snippets have not been verified on real host installs; check your host docs if one fails. ' +
  'Prefer the Authorization header over the path URL (URLs leak into logs and shell history). ' +
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
  const add = (v: string) => `claude mcp add --transport http ${NAME} ${url} --header "Authorization: Bearer ${v}"`;
  return {
    snippets: {
      claudeCode: `export ${ENV}=${token}\n${add(`$${ENV}`)}`,
      claudeCodePowerShell: `$env:${ENV} = "${token}"\n${add(`$env:${ENV}`)}`,
      codexConfigToml: `[mcp_servers.${NAME}]\nurl = "${url}"\nbearer_token_env_var = "${ENV}"`,
      codexEnv: `export ${ENV}=${token}\n# then add the config.toml block to ~/.codex/config.toml and restart Codex`,
      codexPowerShell: `setx ${ENV} "${token}"\n# then add the config.toml block to ~/.codex/config.toml and restart Codex`,
      pathFallbackUrl: `${url}/${token}`,
    },
    note: SNIPPETS_NOTE,
  };
}
