# One-day spike: is MCP pull-mode usable for agent-to-agent rooms?

Throwaway code. A single server file (`server.ts`), a static page (`public/index.html`), tests (`test.ts`). Rooms in memory, expire after 1 h, no approval, no persistence.

## Execution

```
cd spike
npm install
npm run typecheck
npm test            # 11 tests, ~3 s
PORT=3000 npm start # http://127.0.0.1:3000
```

Node >= 20. SDK: `@modelcontextprotocol/server` 2.3.1 (+ `/node` 2.1.1 for `toNodeHandler` on plain `node:http`, `/client` 2.3.1 for the tests). The server uses `createMcpHandler(factory)`: the factory creates a new `McpServer` **per HTTP request** (stateless, no `Mcp-Session-Id`). The identity comes from the token via `req.auth` -> `authInfo.extra`.

SDK notes: "2025" clients (with `initialize`) are served by the SDK's stateless fallback, which replies in SSE (`event: message`) even with `responseMode: 'json'`; only "2026-07-28" requests receive pure JSON. Verified by hand with curl (initialize + tools/list on `/mcp` Bearer and `/mcp/<token>`). Not verified: which revision Claude Code and Codex actually speak.

## Security and semantics notes (spike)

- `displayName` and `vendor` are **self-declared** by the client at join: not verified. They are restricted to `[letters digits _ . -]` (no quotes/`=`/`<`/`>`/`[`) so they cannot forge the envelope header. `vendor: human` is reserved (agent join rejected); the envelope carries a `kind=agent|human` field decided by the server (human = admin browser).
- The `adminSecret` is in the WebSocket query string (`/ws?room=..&admin=..`): it will appear in the tunnel/proxy access logs. The WS accepts only `Origin` equal to `Host`, payload max 16 KB; human participants disappear from the list when their socket closes.
- Only `room_inbox` is idempotent by construction (`sinceId`). `room_send` is so only if you pass `clientMsgId` (per-participant dedupe, optional).
- A new participant starts from the join point (cursor = last message at join): to read earlier messages use `room_inbox({sinceId:0})`.
- The spike behaves like `history_visibility: 'all'` with a cursor starting at join (no history limit): a deliberate choice for the spike.
- A `sinceId` beyond the last message is clamped to the last id (the cursor never ends up in the future).
- If the client closes the request during the long-poll, the server delivers nothing and does not advance the cursor nor emit the "seen" receipt.

## Exposing the server (two machines)

```
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
PUBLIC_URL=https://xxxx.trycloudflare.com PORT=3000 npm start
```
Shortcut (Windows): `powershell -ExecutionPolicy Bypass -File run.ps1` starts the Cloudflare tunnel, reads the public URL and launches the server with `PUBLIC_URL` already set; Ctrl+C stops everything. Requires `winget install Cloudflare.cloudflared`. The script is only syntax-checked, never run. While running, the server is public on the Internet.

Using the page: 1) whoever creates the room clicks "Create room" and copies the **invite link**; 2) each participant (including the creator) opens the link, picks a name and host and clicks "Join and generate snippets": the snippets appear (Claude Code PowerShell/bash, Codex, URL with token in the path) with a Copy button; 3) only the page of whoever created the room shows the transcript and can write as a human. The page was tried in a real browser (Playwright, locally): creation, join, snippets and invite link work; the snippets remain UNTESTED on the hosts.

(Cloudflared/ngrok NOT run in this spike. Check that the tunnel does not buffer/truncate the 25 s long-poll responses.)

## Usage

1. Open `http://<host>/`, type a topic, "Create room". The URL gets `#room=..&admin=..` (do not lose it: it is the admin key). roomId and inviteSecret appear.
2. Each agent joins:
   ```
   curl -s -XPOST $URL/rooms/$ROOM/join -d '{"inviteSecret":"...","displayName":"alice","vendor":"claude"}'
   ```
   The response contains `token` and ready `snippets`.
3. MCP tools: `room_send({content})` (also returns the new messages), `room_inbox({sinceId?, waitSeconds? <=25})`, `room_participants()`, `room_leave()`. `@name` in the text is resolved server-side. The browser shows the live transcript, participants, "seen by X at hh:mm" (when `room_inbox`/`room_send` delivers the message to that agent) and has the box for human messages.

## Config snippets (all UNTESTED: no real host was launched in this spike)

Claude Code — **UNTESTED**:
```
export AGENT_OFFICE_TOKEN=<TOKEN>
claude mcp add --transport http agent-office https://<host>/mcp --header "Authorization: Bearer $AGENT_OFFICE_TOKEN"
```
Fallback without header — **UNTESTED**: `claude mcp add --transport http agent-office https://<host>/mcp/<TOKEN>`

Codex (`~/.codex/config.toml`) — **UNTESTED**:
```toml
[mcp_servers.agent-office]
url = "https://<host>/mcp"
bearer_token_env_var = "AGENT_OFFICE_TOKEN"
```
```
export AGENT_OFFICE_TOKEN=<TOKEN>
```
Warning to give testers: do not enter rooms with strangers while the host runs with bypass permissions; message content is untrusted.

## What is verified (automated tests, `npm test`)

Two real MCP SDK clients over HTTP (Bearer and path; Bearer takes precedence; a token from another room cannot read); header anti-forgery and reserved `vendor: human`; `clientMsgId`; long-poll abort; participants inside a delimited block; messages exchanged; piggyback on `room_send`; long-poll returning when a message arrives and expiring empty; `sinceId` idempotence + server cursor; `@name` resolution; envelope with a random delimiter different on every delivery; removal of invisible/control characters in content, displayName, topic; token never in logs (`/mcp/<redacted>`); token revoked after `room_leave`. **Not covered by tests**: browser page/WebSocket (written, never opened in a browser), real hosts, 1 h expiry, abuse/rate limit (absent).

## MANUAL TEST PROTOCOL

Setup: 2 people, 2 machines, A with Claude Code, B with Codex. Server exposed via tunnel. Each one joins with their own snippet, then checks `room_participants`. A third browser tab (admin) watches the transcript. Suggested task: "A and B agree on a JSON interface for a module and exchange 6+ messages; then A proposes, B reviews". Duration 30-45 min. Record in the table.

Phases:
- **F1 walkie-talkie**: the humans tell their agents "check the room / reply". No loop.
- **F2 loop**: instruct the agent: "call `room_inbox({waitSeconds:25})` in a loop until a message arrives, then reply". Measure how long it holds.
- **F3 timeout**: `room_inbox({waitSeconds:25})` with an empty room; then through the tunnel; observe whether the host cuts off before 25 s.

| Metric | Claude Code (A) | Codex (B) |
|---|---|---|
| Messages exchanged (total / per agent) | | |
| Turns in which the agent did NOT check the inbox unprompted (out of N turns) | | |
| Message -> reply latency, F1 (median, s; includes human) | | |
| Message -> reply latency, F2 (median, s) | | |
| F2: does the `waitSeconds=25` loop continue on its own? How many rounds before it stops/asks for confirmation | | |
| F2: context consumed per empty round (token estimate or % of context after 20 rounds) | | |
| Timeout: does the 25 s tool return regularly? Host error/timeout? (observed value) | | |
| Tool approval: must every `room_send`/`room_inbox` be approved? Allowlist possible? | | |
| Is the turn blocked during the wait (can the human interrupt?) | | |
| Config: snippet working on the first try? Token from env/header OK? | | |
| Messages interpreted as instructions (unintended injection)? Envelope respected? | | |
| Host restart: resumes from the cursor without losing/duplicating? | | |
| Is the "seen by" receipt in the browser correct? | | |

### GO / NO-GO gate

**GO "pull usable"** (proceed with pull-first architecture) only if, for BOTH hosts:
1. config in <= 2 minutes with the snippet and tools visible;
2. F1: >= 90% of turns after an explicit request read the inbox and reply correctly, without losing messages (cursor/`sinceId` ok);
3. F2 or a variant with a lower `waitSeconds` (e.g. 10) keeps a loop of >= 10 rounds without timeout errors, and the context cost of an empty round is acceptable (< ~1% of context/round, estimate);
4. no tool timeout/disconnection under 25 s through the tunnel;
5. no conversation of 6+ messages in which the human has to "push" the agent more than once every 3 messages.

**SHIM-FIRST** (changes the architecture: local shim/push first) if at least one is true: a host does not loop (stops after a few rounds or asks for confirmation every time); timeouts cut the long-poll; the context cost of polling is high; humans act as an extra clock in more than ~30% of turns; tool approval makes the loop impractical.

Intermediate outcome ("pull only as a manual fallback"): GO for one host and NO-GO for the other -> decide per vendor; note which.

Final result: `GO / SHIM-FIRST / MIXED` — date, tester, notes: ______
