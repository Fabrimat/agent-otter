# Claude Code (tested: 2.1.301, Windows; run id and date: see measured.md)

## Setup (the exact snippets from `buildSnippets()`)

bash:
```bash
export AGENT_OFFICE_TOKEN=<token>
claude mcp add --transport http agent-office http://127.0.0.1:<port>/mcp --header 'Authorization: Bearer ${AGENT_OFFICE_TOKEN}'
```
PowerShell:
```powershell
$env:AGENT_OFFICE_TOKEN = "<token>"
claude mcp add --transport http agent-office http://127.0.0.1:<port>/mcp --header 'Authorization: Bearer ${AGENT_OFFICE_TOKEN}'
```
The header is single-quoted on purpose: the shell does not expand it, so the config keeps the literal `${AGENT_OFFICE_TOKEN}` and Claude Code expands it when it connects (documented `.mcp.json` env expansion). The token never lands on disk. Set the variable in every shell that starts `claude`.

VERIFIED (both variants; evidence in the snippet section of [measured.md](measured.md)): the harness ran them verbatim in a temp project directory with `--scope project` appended, so the owner's `~/.claude.json` was never touched (the default scope is `local`, which writes `~/.claude.json`, and was not executed). Results: the stored `.mcp.json` contains the literal `${AGENT_OFFICE_TOKEN}` and not the token; `claude mcp get agent-office` does not print the token; a `claude -p` call through that `.mcp.json` sent a message into the room when the variable was set (the live calls use `--mcp-config <that .mcp.json> --strict-mcp-config`, so none of the owner's other MCP servers load); with the variable unset nothing was sent and Claude's own explanation is quoted in the results.

UNVERIFIED: the default `local`/`user` scope (same command, different file), the interactive approval flow, other versions.

Quirks observed:
- `--header` is variadic: put the name and URL **before** it (the generated snippet does).
- A project-scoped server shows `Pending approval` in `claude mcp get` until approved interactively. In `claude -p` it loads without a prompt (official docs).
- Previous snippet (superseded): `--header "Authorization: Bearer $AGENT_OFFICE_TOKEN"` with double quotes made the shell expand the token, which was then stored in clear in the config and printed by `claude mcp get`.
- If the variable is not set when `claude` starts, the server fails with HTTP 401 and its tools are missing; this is the failure mode of the new snippet after opening a new terminal.

## Non-interactive run used by the tests

```bash
claude -p "<ONBOARDING_PROMPT ...>" --mcp-config run.json --strict-mcp-config   --allowedTools=mcp__agent-office__room_send,mcp__agent-office__room_inbox,mcp__agent-office__room_history,mcp__agent-office__room_participants,mcp__agent-office__room_leave   --max-turns 12 --model haiku --max-budget-usd 0.25 --output-format stream-json --verbose   --no-session-persistence --setting-sources project --permission-mode default
```
`--allowedTools` is variadic, hence the `=` form; `AGENT_OFFICE_TOKEN` is in the environment. No permission-bypass flag is used. The model id the host reported (claude-haiku-5-5 for the `haiku` alias) and the cost per run are in the recorded results.

## What was observed (numbers: see measured.md)

- H1: the agent joined (lastSeen set), called `room_participants`, `room_inbox`, `room_send` and answered the question. The only other tool used was the host-internal `ToolSearch` (MCP tools are loaded on demand before the first call).
- Server instructions: when asked, the model quoted the first line of `AGENT_INSTRUCTIONS` (model self-report, recorded). Tool descriptions were not quoted until the model looked the tool up with `ToolSearch`; afterwards it quoted the `room_inbox` description (recorded).
- Timeouts: the documented default MCP tool timeout is about 28 hours, so the 25 s long-poll is fine (recorded: empty polls return after about 25 s, no errors). With `MCP_TOOL_TIMEOUT=10000` the call failed with a timeout error whose text is recorded in measured.md.
- Pull-only: see the loop row in measured.md (whether the agent kept polling by itself in the recorded window).
- Injection (H4): see measured.md and the warning in [README.md](README.md): this is NOT a resistance test (the victim had no usable shell). The Claude rows that mean something are the exfiltration ones: the detector check (owner asks plainly) leaked, the Read-denied control did not. No attempt to use the shell was observed, so the denial path itself was not exercised.
- NOT tested: a public tunnel.
