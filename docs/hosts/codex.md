# Codex CLI (tested: codex-cli 0.163.0, Windows; run id and date: see measured.md)

## Setup (the exact snippets from `buildSnippets()`)

`~/.codex/config.toml`:
```toml
[mcp_servers.agent-office]
url = "http://127.0.0.1:<port>/mcp"
bearer_token_env_var = "AGENT_OFFICE_TOKEN"
```
bash: `export AGENT_OFFICE_TOKEN=<token>`. PowerShell: `setx AGENT_OFFICE_TOKEN "<token>"` (visible to new terminals only). Then restart Codex.

**`setx` stores the token persistently in the user's registry (`HKCU\Environment`): it is on disk and outlives the 1-hour room.** Remove it when done (standard Windows syntax; neither command was run, so they are untested here):
```powershell
reg delete HKCU\Environment /v AGENT_OFFICE_TOKEN /f
# or
[Environment]::SetEnvironmentVariable('AGENT_OFFICE_TOKEN', $null, 'User')
```
Prefer setting the variable only for the session (`$env:AGENT_OFFICE_TOKEN = "<token>"` in PowerShell) when you can.

VERIFIED: the block parses under an isolated `CODEX_HOME` (`codex mcp get agent-office --json` shows `streamable_http`, the URL and `bearer_token_env_var`), and a live `codex exec` run using exactly those keys and values, passed as `-c mcp_servers.agent-office.url=...` and `-c ...bearer_token_env_var=...` (so `~/.codex/config.toml` was never read or written), sent a message into the room. The `export` line works in bash.
NOT executed: `setx` (persistent user environment change) and the path-fallback URL. UNVERIFIED: editing the real `~/.codex/config.toml`.

## Non-interactive run used by the tests

```bash
codex exec --json --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules -C <tmp> -s read-only -m gpt-6-luna \
  -c model_reasoning_effort="low" \
  -c 'mcp_servers.agent-office.url="http://127.0.0.1:<port>/mcp"' \
  -c 'mcp_servers.agent-office.bearer_token_env_var="AGENT_OFFICE_TOKEN"' \
  -c 'mcp_servers.agent-office.default_tools_approval_mode="approve"' \
  -c 'approval_policy="never"' "<ONBOARDING_PROMPT ...>"
```
`--ignore-user-config` skips `config.toml` (auth still comes from `CODEX_HOME`). No `--dangerously-bypass-*` and no `danger-full-access`.

Approvals (the generated TOML block deliberately has no auto-approval): non-interactive `codex exec` has no one to ask, so the room tools need `default_tools_approval_mode="approve"` (added by the test harness as a `-c` override, not part of the snippet). An interactive session asks the user before the first room tool call. Recommendation: keep approvals ON for rooms with strangers or unknown participants; only auto-approve in a throwaway automation like this test suite. (Interactive prompting itself was not tested; it follows from the docs and the exec behaviour below.)

Quirks observed:
- **Approval** (recorded, see "Recorded findings" in [measured.md](measured.md)): without `default_tools_approval_mode="approve"` the room tool call failed with `MCP tool call requires approval, but approval policy is never`.
- **Model choice** (recorded: a small comparison of `gpt-5.6-luna`, `gpt-6-luna`, `gpt-6.1-sol` on the same question, results in measured.md). Observed during development, not in recorded results: one earlier run of `gpt-5.6-luna` answered the question with a greeting; model behaviour varies between runs, so treat "answers when asked" as probabilistic.
- **Windows sandbox** (recorded: the shell probe in measured.md shows that no shell command ran and what the model said). Observed during development, not in recorded results: with `windows.sandbox="unelevated"` the error was `CreateProcessAsUserW failed: 5 (Access is denied.)`; forcing `windows.sandbox="elevated"` started `codex-windows-sandbox-setup.exe`, which burned minutes of CPU on a profile-wide ACL refresh and was killed by hand (Codex's own sandbox accounts may have been granted some read ACLs). Do not set it from automation.

## What was observed (numbers: see measured.md)

- H2: joined, `room_participants` -> `room_inbox` -> `room_send`, replied correctly; only room tools were used.
- Cross-vendor H3: the human asked @ada, ada answered and mentioned @bo, bo (codex) answered; latencies and the "seen by" receipt events are in measured.md.
- Server instructions and tool descriptions: the model self-report was inconsistent (see the observe lines in measured.md), so what Codex shows the model is **UNVERIFIED**; `codex debug prompt-input` does not render MCP tool schemas or server instructions (observed during development, not in recorded results).
- Timeouts: the documented default `tool_timeout_sec` is 60 s, so the 25 s poll fits (recorded: empty polls return after about 25 s). With `tool_timeout_sec=10` the call failed with the recorded timeout text.
- Pull-only: see the loop row in measured.md.
- Injection (H4): NOT a resistance test: the shell never ran, so the Read-allowed rows are vacuous for Codex (no Read tool, no working shell). See [README.md](README.md).
- NOT tested: a public tunnel.
