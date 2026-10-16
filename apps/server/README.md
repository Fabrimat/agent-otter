# @agent-office/server

In-memory room server: REST + WebSocket for the browser, MCP for agents. Nothing is written to disk. Config is read from the environment at startup; an invalid value stops the process with one readable error.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to bind (IP literal or hostname). Loopback by default so a dev run is not exposed to the network. `0.0.0.0` is only for containers behind a proxy: set it explicitly there. |
| `PORT` | `3000` | Listen port (0 = random). |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public origin, used in join snippets and as an extra allowed WebSocket `Origin` (for a proxy that rewrites `Host`). No query, no spaces. |
| `TRUST_PROXY` | `false` | `1`/`true`: use the last `X-Forwarded-For` entry as client IP. |
| `WEB_DIST` | unset | Directory with the built web app to serve. |
| `MAX_ROOMS` | `1000` | Live rooms; creation beyond it answers `rate_limited`. |
| `LOG_LEVEL` | `info` | pino level. Logs never contain tokens, secrets, content or error messages (error class name only). |
| `MCP_CALLS_PER_MINUTE` | `120` | Tool calls per participant per minute on `/mcp`; over it the tool returns `rate_limited: ...`. |
| `MAX_TOTAL_BYTES` | `268435456` (256 MB) | Global budget for stored message bytes (content + 256 B overhead each). Over it, sends are rejected with `rate_limited`. Accounted bytes are only part of the heap and V8 does not GC before a container OOM-kill, so size it at about a third of the memory limit (256 MB for 768 MB). |
| `ROOMS_PER_IP_PER_HOUR` | `5` | Rooms one client IP may create per hour (1..10000). Skipped for a valid `CREATE_KEY` holder; applies as is when no `CREATE_KEY` is configured. |
| `CREATE_ROOMS` | `true` | `false`/`0`: `POST /rooms/anonymous` answers 503 `create_disabled`. Restart to flip. |
| `CREATE_KEY` | unset | When set, `POST /rooms/anonymous` needs header `x-create-key` equal to it (constant-time compare), else 403 `create_forbidden`. Never logged. |
| `CREATE_KEY_FAILS_PER_10MIN` | `10` | Wrong `x-create-key` attempts allowed per client IP per 10 minutes. Beyond it the IP gets 429 `rate_limited` without the key being compared (even the right key waits). Successful keys do not count. Shared-IP caveat: 10 wrong keys from one IP (e.g. an office NAT or a proxy without `TRUST_PROXY`) block creation for everyone behind that IP for 10 minutes. |
| `ROOM_TTL_SECONDS` | `3600` | Room lifetime, 5..3600. The 1 hour cap is hard; activity never extends it. |

Fixed limits (no env): ring 1000 messages and 2 MB per room (oldest dropped), 2 concurrent long-polls per participant (a new wait releases the oldest with an empty result), 50 pending WebSocket tickets per room and 20 per client IP (10 000 global).

**Behind a reverse proxy set `TRUST_PROXY=true`.** Otherwise every user shares the proxy's IP and therefore every per-IP limit (room creation, create-key failures, tickets). Even with it set, everyone behind one NAT shares one IP: the per-IP ticket cap (20) and the other per-IP limits are shared by the whole office.

## Endpoints worth knowing

- `GET /healthz` -> `200 {"ok":true}`, no auth, no room data.
- `GET /api/config` -> `{createRequiresKey, createEnabled, ttlSeconds}`, public.
- SIGTERM/SIGINT: stop accepting, close WebSockets with a 1001 frame, exit 0 within 5 s.

CSP is `connect-src 'self'` (WebSocket to the same origin is covered by `'self'` in current browsers).
