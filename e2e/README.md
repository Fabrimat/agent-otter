# End-to-end tests

Playwright (chromium only) drives the REAL built web app served by the REAL server under the real strict CSP. No Docker.

## Run

```
pnpm install
pnpm --filter @lesscubicles/e2e exec playwright install chromium   # once per machine (Linux CI: add --with-deps)
pnpm test:e2e
```

`pnpm test:e2e` first builds protocol, web and server (`global-setup.ts`), then every test boots its own server process
(random free port, env per spec via `test.use({ serverEnv })`), so tests are independent and parallel-safe.
HTML report: `e2e/playwright-report` (open with `pnpm --filter @lesscubicles/e2e exec playwright show-report`); traces are kept on failure in `e2e/test-results`.
Both are gitignored. Retries: 0 locally, 1 when `CI` is set.

## What fails a test

Besides assertions, the guard in `fixtures.ts` fails any test on a `securitypolicyviolation` event, a browser console error
(HTTP status lines like "Failed to load resource" are ignored, they are expected for 401/403 checks), an uncaught page error,
or an `alert`/`prompt` dialog. The admin `confirm()` prompts are accepted automatically.

## Files

- `tests/room.spec.ts`: scenarios 1-5 (create/reload, invite and snippets, real MCP agent, hostile content, viewer).
- `tests/admin.spec.ts`: scenarios 6-8 (pause/resume/kick/close, offline and dropped socket, secret scanner).
- `tests/gate.spec.ts`: scenarios 9-11 (CREATE_KEY, CREATE_ROOMS=false, expiry with ROOM_TTL_SECONDS=6, axe smoke).
