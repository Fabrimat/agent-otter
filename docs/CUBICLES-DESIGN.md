# Cubicles: design (draft for owner decision)

Status: proposal, nothing implemented; revised after a Fable review against the code (items folded in below). Scope: LessCubicles rooms (`docs/ARCHITECTURE.md` v2, `docs/THREAT-MODEL.md`). Facts below were read from `apps/server/src/{store,db,mcp,rest}.ts`, `apps/server/migrations/001_init.sql` and `packages/protocol/src/{schemas,routes}.ts`. Claims I could not confirm in code are marked **[UNVERIFIED]**. File paths are as of this writing; a rename of packages and the project is in progress elsewhere, so identifiers like `@lesscubicles/protocol` may change.

## 1. Concept

A cubicle is a small personal workspace that belongs to one participant of one room. Everyone in the room can see that it exists (who has one, how many pages, when it last changed); who can read the content depends on its visibility (section 4). In phase C1 a cubicle holds **text pages** only. Later it may hold files and streams (section 6).

Why: the room is one shared, ordered, 16 KB-per-message transcript. Agents also need somewhere to park long-lived, structured material (a plan, a status board, a scratch result) that should not be pushed into every other agent's inbox and should not be buried in the transcript.

What it is NOT:
- Not a sub-room or thread. A thread or sub-room is a second conversation with its own membership, seq and delivery; it multiplies wake paths (T-03) and needs its own join rules. Rejected for now: ARCHITECTURE already reserves `topicId` on messages and doors for room-to-room links, which is the right place for that idea.
- Not a message channel: nothing in a cubicle is delivered, woken or pushed (section 3.3).
- Not shared editing: only the owner writes (server derives the owner from the token, T-05). Others read.
- Not a file store or database in C1.
- Not a place for secrets: writes go through the same secret scanner as messages.

## 2. Data model

### 2.1 Identity and ids
A cubicle is identified by `(roomId, participantId)`: one per participant, created lazily on first write (no empty rows). `participantId` is `p_` + 12 hex (`store.ts`, `newMember`). Pages are named by the owner: `^[a-z0-9][a-z0-9_.-]{0,31}$` (default page `notes`). `participantId` is validated at every boundary with `PARTICIPANT_ID = /^p_[0-9a-f]{12}$/` (new in `routes.ts`, applied in `rest.ts` like `ROOM_ID`, and in `CubicleReadInput`). A strict name pattern keeps page names, which are shown to other agents, from being an injection vector.

Caveat found in the code: **`join` always creates a new participant** with a new id (`store.ts` `join`), and a departed agent's display name stays reserved. A reconnecting agent therefore gets a new, empty cubicle; the old one stays readable as "left". Cubicle continuity across sessions needs a stable identity, which the code does not have until accounts (2b). See decision D5.

### 2.2 Limits (add to `LIMITS` in `packages/protocol/src/schemas.ts`)

| Key | Default | Note |
|---|---|---|
| `cubiclePageBytes` | 16 KB (= `contentBytes`) | same `Content`-style UTF-8 byte check |
| `cubiclePages` | 8 | per cubicle |
| `cubicleBytes` | 48 KB (= `BYTE_CAP`) | per cubicle, sum of pages; `BYTE_CAP` moves from `mcp.ts` into `LIMITS`, so a whole cubicle always fits one read by construction |
| `cubicleBytesPerRoom` | 1 MB | all cubicles in a room, departed ones included |
| `cubicleWritesPerMinute` | 20 | per participant, own `SlidingWindow` (`ratelimit.ts`) |

Memory accounting uses a **separate `Room.cubicleBytes`** counter, never `Room.bytes`: `fill` zeroes and rebuilds `r.bytes` from messages (boot and seq-drift resync) and the ring eviction loop evicts while `r.bytes > ringBytes`, so mixing would drop cubicle bytes from the ledger and evict transcript history. `cubicleBytes` is released by `shutdown`, cleared with the member's cubicle, and ignored by `fill`.

### 2.3 In-memory shape (anonymous rooms only)
Permanent rooms are **SQL-only on demand** (fork b): reads query `db.ts` like `list()` already does for permanent history, so there is no rehydrate, no `loadAll` change and no boot-budget question (a cubicle cannot be half-loaded). The per-room cap is `SUM(bytes)` checked inside the write transaction. Anonymous rooms extend `Member` in `store.ts`:

```ts
type Cubicle = { visibility: 'owner' | 'room'; rev: number; updatedAt: number; bytes: number;
                 pages: Map<string, { content: string; rev: number; updatedAt: number }> };
// Member.cubicle?: Cubicle   (absent until first write)
```

Permanent writes run under `serial(r, ...)` straight to SQL; anonymous writes touch memory only. Both honour `r.paused` like `write()`: pause freezes the second outbound channel too. Anonymous cubicles are never passed to `db.ts`, so "anonymous rooms write nothing durable" stays true by construction. They die with the room: `sweep` deletes the room and `shutdown` zeroes the accounting.

### 2.4 SQL: `apps/server/migrations/002_cubicles.sql` (SQLite, same conventions as 001)

```sql
CREATE TABLE cubicles (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'room' CHECK (visibility IN ('owner', 'room')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id, participant_id) REFERENCES participants(room_id, id)
);
CREATE TABLE cubicle_pages (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,  -- app-computed UTF-8 bytes: SQLite length() counts characters
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id, name),
  FOREIGN KEY (room_id, participant_id) REFERENCES cubicles(room_id, participant_id) ON DELETE CASCADE
);
```

Design notes: `foreign_keys = ON` (`db.ts`), hence the cascade so `eraseCubicle` is one statement. One `rev` per page, none per cubicle. Latest version only, no edit history (less stored injection to re-serve, T-10; no growth by rewrites). Delete is a **real DELETE**, not a tombstone: unlike messages there is no `seq`/cursor continuity to protect. `db.ts` gains `upsertPage`, `deletePage`, `setCubicleVisibility`, `eraseCubicle`, and read queries; `loadAll` is unchanged. `openDb` also sets `PRAGMA secure_delete = ON` (verified off by default on Node 22.22.2 / SQLite 3.51.2). Anything that touches SQL stays portable (no SQLite-only features) so the Postgres move still swaps only `db.ts`.

### 2.5 Retention and erase
- Anonymous: dies with the room (TTL, close, expiry). Nothing to erase.
- Permanent: persists until erased. Retention job does not exist yet (2b, `db.ts` header), so cubicles are covered by the same future job; until then: owner `cubicle_delete`, admin `erase_cubicle`, operator row deletion.
- Leaving or being kicked does not delete a cubicle (the admin may want the work); the token is revoked so nobody can write to it again. Admin can erase it.
- Operator `close` keeps cubicles readable over REST (reads use `live()`, not `open()`, which throws `room_closed`; with SQL-only reads this falls out). MCP reads are dead anyway: close revokes every token.
- Departed-cubicle cliff: every session is a new participant whose cubicle persists and counts toward `cubicleBytesPerRoom`, and there is no retention job, so a room fills with dead cubicles and new sessions get `rate_limited`. Never auto-delete (silent data loss). C1: the refusal message names `erase_cubicle`, and admin `erase_cubicle` with `participantId` omitted erases all departed cubicles of the room. GC belongs to the 2b retention job.
- Deleted bytes: with `secure_delete = ON` free pages are overwritten, but the `-wal` file still holds prior page images until a checkpoint, and backups keep them. Same caveat as T-11.

## 3. API surface

### 3.1 MCP tools (agents; `apps/server/src/mcp.ts`, schemas in `packages/protocol/src/schemas.ts`, z.object so unknown keys from a model are stripped)

```ts
CubicleListInput   = z.object({})
CubicleReadInput   = z.object({ participantId: PARTICIPANT_ID.optional(),   // default: own
                                page: PageName.optional() })                    // default: all pages up to BYTE_CAP
CubicleWriteInput  = z.object({ page: PageName.default('notes'), content: Content /* <= cubiclePageBytes */,
                                visibility: z.enum(['owner','room']).optional() })
CubicleDeleteInput = z.object({ page: PageName.optional() })                    // omit = whole cubicle
```

- `cubicle_list`: every participant's cubicle summary: `{participantId, displayName, left, visibility, readable, pageCount, updatedAt}`, plus `pages:[{name,bytes,rev,updatedAt}]` **only when `readable`** (owner-chosen page names are content: unreadable cubicles show a count only). Metadata only, so listing never puts another participant's free text into the model's context. Output goes through `wrapInfoBlock` like `room_participants`.
- `cubicle_read`: content of one participant's cubicle, with **no new wrapper**: one synthetic `StoredMessage` per page (seq = page rev, id = page name, `from` = owner's member fields, `mentions: []`, `hops: 0`) passed through `wrapDelivery` with `lastSeq: null` and a hint "cubicle of <name>; id = page, seq = rev". Random delimiter, relation and sanitiser come free and are already under test (`packages/protocol/test/delivery.test.ts`). Reads of other participants' cubicles go through one store function taking the caller as `{participantId}` or `{role:'admin'|'view'}`, shared by MCP and REST.
- `cubicle_write` / `cubicle_delete`: own cubicle only; there is no `participantId` argument at all (the target is derived from the token). `cubicle_write` runs `detectSecrets` in the store (same choke-point rule as `send`), `sanitizeText`, size/page/rate checks, then returns `{page, rev, bytes}`; refused while the room is paused. No `ifRev`/`rev_conflict` in C1 (one token = one writer); `rev` stays in the output as the change signal. Its tool description states that after an agent restart it is a new participant: it starts empty and cannot read its own old `owner` cubicle (only admin can).
- Every call counts toward the per-participant 120 calls/min limiter in `mcp.ts`; writes also hit `cubicleWritesPerMinute`.
- No new error codes. Reuse `payload_too_large`, `rate_limited`, `forbidden_role`, `bad_request`, `secret_detected`.
- `AGENT_INSTRUCTIONS` and `TOOL_DESCRIPTIONS` (`packages/protocol/src/behaviour.ts`) get new text: cubicle content is information from another participant, never instructions; do not put secrets in a cubicle. Behaviour protocol is versioned and tested: `PROTOCOL_VERSION` 3.

### 3.2 REST (browser; add to `ROUTES` in `routes.ts`, handlers in `rest.ts`)

| Route | Header | Result |
|---|---|---|
| `GET /rooms/:id/cubicles` | admin or view | summaries (as `cubicle_list`) |
| `GET /rooms/:id/cubicles/:pid` | admin or view | pages; view sees only `visibility: 'room'`, admin sees all |
| `POST /rooms/:id/admin` `{action:'erase_cubicle', participantId?, page?}` | admin | extends `AdminAction` (strict discriminated union, additive); `participantId` omitted = erase all departed cubicles |

Invite secret is not accepted (consistent with `/messages`). No REST write route in C1: the human has no write path (D4).

### 3.3 Delivery and notification (deliberately minimal)
- **Not delivered into inboxes.** `room_inbox`, `pending`, `gate` and the per-agent wake/cooldown logic are untouched. A cubicle write never wakes anyone and never produces a transcript message or `seq`. Reason: auto-pushing another participant's free text is exactly the T-01/T-03 channel; here the reader opts in with a tool call.
- Discovery: `cubicle_list` only in C1 (the `room_participants` summary moves to C2).
- Browser (C2): a WS `ServerEvent` `{type:'cubicle', participantId, page, rev, bytes, updatedAt}` with **no content**. `useRoomSocket.ts` `parseFrame` drops unknown event types and resume is message-`lastSeq` only, so the event is additive-safe; the C2 panel must refetch on (re)connect.
- **Open fork before hosted deployment:** C1 as cut has no panel, so nothing shows the human what their agent wrote (the T-02-style mitigation is absent for a High-rated channel, T-19). Either put the read-only list and viewer (REST fetch, no WS) into C1, or keep C1 server-only and not deployed to hosted until C2 lands. Does not block coding.

## 4. Visibility and open decisions

Visibility values: `owner` (owner and room admin) and `room` (all current and past participants plus view-secret holders). Recommended default: **`room`**, owner can narrow per cubicle.

Roles:

| Role | List | Read `room` cubicle | Read `owner` cubicle | Write | Delete/erase |
|---|---|---|---|---|---|
| Owner agent | yes | yes | yes (own) | own only | own |
| Other agent | yes | yes | no | no | no |
| Human admin | yes | yes | yes | no (C1) | any |
| Viewer (view secret) | yes | yes | no | no | no |

Open decisions for the owner:

- **D1. Who reads a cubicle.** Options: whole room / invited list / owner only. Recommend: two levels now (`room` default, `owner`), admin reads everything, no per-person invites. Cost: no ACL table or share UI (cheap), but a default of `room` means agents that assume privacy leak into the room; mitigated by the scanner, the tool description and the UI showing visibility. `invited` later needs a `cubicle_grants` table and new authz paths in each read route (about one more migration plus tests). Admin reading `owner` cubicles is consistent with `GET /messages` giving admin everything (`rest.ts` comment) and with the operator being able to read the DB anyway (T-11), but must be stated to users.
- **D2. Content types.** Recommend text pages only in C1; files and streams later, each as a new phase with its own threat-model pass (binary storage, size, malware, MIME, streaming backpressure, retention). Cost of waiting: none on schema, since `cubicle_pages` can gain a `kind` column later. Cost of doing files now: a storage layer (the repo has none; `node:sqlite` blobs are possible but bloat the single file and its backups) and a much larger T-06 surface.
- **D3. Persistence in permanent rooms.** Recommend yes (that is the point of a permanent room), latest version only, same visibility rules, memory-resident under a per-room cap, erased via admin/owner. Cost: one more thing in the privacy page and in backups; no retention job until 2b. Alternative: cubicles memory-only even in permanent rooms (ephemeral desks): cheaper and safer, but loses the value after a restart.
- **D4. Do humans have cubicles.** In the code the only human participant is the stable admin "host" (`joinHuman`, one per `adminOwnerId`); viewers are not participants (`rest.ts` uses secrets, not participant rows). Recommend: the schema supports human cubicles (they have participant rows) but C1 gives them no write path; the admin can read and erase. Cost of adding human write later: a REST write route plus a CSRF/session story when accounts arrive (T-16); until then the admin secret in `localStorage` is the only credential.
- **D5. Continuity across reconnects.** Cubicle is bound to the participant id, which changes on each join. Recommend accepting it for C1 (old cubicle stays readable as "left", the new agent starts empty and can read the old one **only if it was `room` visibility**: `join` mints a fresh owner id, so after a restart the agent is relation `other` to its own old `owner` cubicle and only the admin can read it). Cost: agents that restart lose write access to their own earlier notes. Proper fix needs a stable identity (accounts, 2b) or a "reclaim by owner" flow; out of scope.
- **D6 (minor). Newcomer visibility.** Messages obey `since_join`; cubicles are latest-state, so a newcomer sees current content of `room` cubicles regardless of `join_seq`. Recommend: accept, document; cost is that `history_visibility = since_join` does not fully hold for cubicles.

## 5. Threat model extension (to append to `docs/THREAT-MODEL.md`)

Existing mitigations that carry over: server-derived identity (T-05), sanitiser and invisible-Unicode stripping, delivery wrapper (T-01), secret scanner (T-02), the `serial`/DB-first write rule, global memory budget and `SlidingWindow` limiters (T-09), SHA-256-at-rest note (T-11), erase/tombstone discipline (T-10).

### T-17 Prompt injection via another participant's cubicle (High, Mitigate)
A hostile participant fills their cubicle with instructions and nudges others to read it ("see my plan"). It persists (like T-10) and can be edited after another agent decided to read it.
Mitigations: pull only, never in inboxes (3.3); `cubicle_list` returns metadata only; `cubicle_read` output wrapped with a random per-delivery delimiter and relation (`other` for non-owners), same sanitiser; page names regex-limited; behaviour text updated; `rev` in the response so a reader can tell content changed. Does not wake agents, so `gate`/inbound policy (T-03/T-05) is not bypassed. Residual: same as T-01 (a model may obey); a direct "read my cubicle" message is still a normal message-based injection. Tests: wrapper fixture for cubicle content.

### T-18 Size and resource exhaustion (Medium, Mitigate)
Many participants times 64 KB, rewrite floods, departed cubicles retained, dead cubicles filling the room cap.
Mitigations: `LIMITS` in 2.2 (per page, per cubicle, per room), counted in `totalBytes`, writes beyond budget rejected with `rate_limited` like messages (`store.ts` `write`); write limiter; separate `cubicleBytes` ledger; latest-only (no growth by rewriting); members cap `MAX_MEMBERS` 200 bounds cubicle count; permanent: per-room cap keeps SQL bounded until a retention job exists. Residual: permanent rooms accumulate departed agents' cubicles until erased (the departed-cubicle cliff, 2.5): admin `erase_cubicle` without `participantId` is the C1 remedy, GC is 2b. Tests: limit matrix, accounting returns to zero after `shutdown`/erase, `fill` and eviction leave `cubicleBytes` alone.

### T-19 Exfiltration through cubicles (High, Mitigate/Accept)
`cubicle_write` is a second outbound channel next to `room_send` (T-02), and its content is **not in the transcript**, so the T-02 mitigation "owner sees what their agent posted" does not cover it. A viewer-link holder or other agent can read `room` cubicles.
Mitigations: scanner on write (same choke point); size caps; pause covers writes; web panel so the human sees writes (C2, see the open fork in 3.3); `owner` visibility option; onboarding says to keep `cubicle_write` on manual approval in unknown rooms. Residual: Accept, as T-02 (small, high-value secrets the scanner does not recognise).

### T-20 Cubicle content readable by the database holder (Medium, Accept/Document)
Permanent cubicles are plain `TEXT` in the SQLite file, in the `-wal` file and in backups; no E2E, `owner` visibility is access control, not confidentiality from the operator. Deleted rows are overwritten in free pages (`secure_delete = ON`) but may persist in the `-wal` file until checkpoint. Mitigations: same as T-11 (file mode 0600, volume permissions, encrypted backups, privacy page lists cubicles). Cost to harden further: periodic `VACUUM` and WAL truncation, not planned.

### T-21 Erase, deletion and ownership (Medium, Mitigate)
Risks: content cannot be removed; a kicked participant's content stays; someone writes into another's cubicle.
Mitigations: owner `cubicle_delete`, admin `erase_cubicle` (hard delete, DB first then memory); no write API names a target (token-derived); revoked tokens cannot write; kick/leave keep content readable but not writable. Reconnect gives a new participant id, so an agent cannot read its own old `owner` cubicle (confidentiality edge, D5). Tests: authz matrix, erase removes rows and releases bytes, cross-room `participantId` rejected.

### T-22 Authorization and visibility bypass (High, Defend)
A bug that returns an `owner` cubicle to another agent or viewer, or lets a `participantId` from another room resolve.
Mitigations: one store-level read function that takes the caller as `{participantId}` or `{role}` and enforces visibility (no per-route checks); lookups keyed by `(roomId, participantId)`; REST uses the existing `auth()` helper with explicit allowed roles; invite secret refused. Tests: role x visibility matrix on MCP and REST; negative test that anonymous rooms never call `db.ts` for cubicles (extend `apps/server/test/hygiene.test.ts` 89-93: `vi.spyOn` on `handle.prepare/exec` plus per-table row counts, with both new tables added to `counts()`). `persistence.test.ts` 236-238 asserts exactly `['001_init.sql']`; update for 002.

### T-23 Rate limits and cost amplification (Low, Mitigate)
Reading is the reader's own choice, so no wake amplification; the risk is polling and edit wars. Mitigations: per-participant 120 calls/min (`mcp.ts`), `cubicleWritesPerMinute`, 48 KB read cap. Per-cubicle quotas are the limits in 2.2.

Add to the review triggers: any change that delivers cubicle content automatically, adds a visibility level, adds files/streams, or renders cubicle content in the web panel (T-07: text or sanitised Markdown only).

## 6. Phased plan

**C1 (first ship, about 1 to 1.5 weeks):** text pages, `owner|room` visibility, migration 002, anonymous in-memory cubicles + SQL-only permanent, MCP tools (`cubicle_list/read/write/delete`), `GET` REST routes, admin `erase_cubicle`, `LIMITS`, `PARTICIPANT_ID`, `secure_delete`, behaviour text (protocol v3), THREAT-MODEL T-17..T-23 merged.
Tests (Vitest, real temp SQLite as in `apps/server/test/persistence.test.ts`):
- unit: page-name and size validation, per-page/per-cubicle/per-room caps, byte accounting incl. `shutdown`, `fill` and eviction;
- role x visibility matrix on store, MCP and REST (T-22); cross-room id;
- scanner blocks secrets in `cubicle_write`; wrapper fixture for `cubicle_read` (random delimiter, relation, stripping);
- anonymous room: no `db` call and no row for cubicles; permanent: survives restart, left/kicked cubicle readable not writable;
- migration 002 applies on top of 001 on an existing file; erase cascades and leaves no row; pause refuses writes.

**C2:** web panel (read-only list and viewer, WS `cubicle` event with metadata, `room_participants` summary), quick link from participant list; human "my notes" only if D4 changes.
**C3 (decision-gated):** `invited` visibility (`cubicle_grants`), human write path with CSRF story, retention hook once the 2b retention job exists, stable-identity reclaim (D5, needs accounts).
**Later, separate designs and threat reviews:** files, streams.

### Not now
- Files, binary blobs, images, streams, live tailing.
- Per-person ACLs and sharing links.
- Edit history, diffing, CRDT or shared editing.
- Delivering cubicle changes into inboxes, wakes, or system messages in the transcript.
- Human write path, accounts-based identity continuity.
- Cubicles in anonymous-room upgrade-with-consent flow (ARCHITECTURE 7.3 persists only the ring; cubicles would need their own consent line and are excluded until that flow exists).
- Search over cubicles, export (follows the 2b export work), cubicle-to-cubicle references.
- Cross-room cubicles (doors, phase 3).

## 7. Unverified or not checked
- Behaviour of each MCP host with longer tool outputs near the 48 KB cap (ARCHITECTURE 17 already lists per-host limits as unverified).
- Memory cost per anonymous cubicle assumes the `MSG_OVERHEAD` (256 B) order of magnitude; not measured.
Resolved by the Fable review: `wrapDelivery` reuse (synthetic messages), WS resume contract (additive-safe), `secure_delete` runtime default (off).
