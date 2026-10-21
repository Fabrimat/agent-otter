// Stateless MCP endpoint: a new McpServer per HTTP request, identity from the token (never from the MCP handshake).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  AGENT_INSTRUCTIONS, AGENT_TOKEN, CubicleDeleteInput, CubicleListInput, CubicleReadInput, CubicleWriteInput, LIMITS, RoomHistoryInput, RoomInboxInput, RoomLeaveInput, RoomParticipantsInput, RoomSendInput, TOOL_DESCRIPTIONS,
  wrapDelivery, wrapInfoBlock, type StoredMessage,
} from '@lesscubicles/protocol';
import { StoreError } from './errors.js';
import { send } from './http.js';
import { errKind, type Logger } from './log.js';
import { SlidingWindow } from './ratelimit.js';
import type { Identity, Names, RoomStore } from './store.js';

const BYTE_CAP = LIMITS.byteCap; // per room_inbox / room_history / piggyback / cubicle_read call
const BODY_CAP = 64 * 1024;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fault = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export function createMcp(d: { store: RoomStore; log: Logger; now?: () => number; callsPerMinute?: number }) {
  const { store, log } = d;
  const calls = new SlidingWindow(d.callsPerMinute ?? 120, 60_000, d.now ?? Date.now); // per participant, every tool call
  type Extra = { who: Identity; signal: AbortSignal };

  // `lastSeq`: the cursor the model should continue from (null for history: it is not a cursor read)
  const wrap = (who: Identity, messages: StoredMessage[], names: Names, lastSeq: number | null, hint?: string) =>
    wrapDelivery(messages, { ownerId: who.ownerId, displayName: who.displayName, nameOf: (p) => names.get(p) }, { hint, lastSeq });

  /** New messages since the participant's cursor, wrapped. Advances the cursor and emits receipts. */
  async function news(who: Identity, o: { sinceSeq?: number; limit?: number; signal?: AbortSignal } = {}) {
    const r = await store.inbox(who.roomId, who.participantId, { sinceSeq: o.sinceSeq, limit: o.limit ?? LIMITS.inboxLimitMax, maxBytes: BYTE_CAP, signal: o.signal });
    if (!r) return undefined;
    let hint = r.hasMore ? 'more messages waiting: call room_inbox again' : `call room_inbox({sinceSeq:${r.lastSeq}}) to continue; an older sinceSeq re-reads`;
    if (r.gap !== undefined) hint += `; older pending messages were not delivered: call room_history({beforeSeq:${r.gap}})`;
    return wrap(who, r.messages, r.names, r.lastSeq, hint);
  }

  const build = ({ who, signal }: Extra) => {
    const s = new McpServer({ name: 'lesscubicles', version: '0.0.1' }, { instructions: AGENT_INSTRUCTIONS });
    // StoreError becomes a tool error the model can read; anything else propagates to the SDK (generic error to the client).
    const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof text>>) => async (a: A) => {
      if (!calls.hit(who.participantId)) {
        log.warn({ evt: 'rate_limited', kind: 'mcp', roomId: who.roomId, participantId: who.participantId });
        return fault('rate_limited: too many tool calls, wait a moment and slow down');
      }
      try {
        return await fn(a);
      } catch (e) {
        if (e instanceof StoreError) {
          if (e.code === 'secret_detected') log.warn({ evt: 'secret_blocked', via: 'mcp', roomId: who.roomId, participantId: who.participantId });
          return fault(`${e.code}: ${e.message}`);
        }
        log.error({ evt: 'internal', err: errKind(e), tool: true });
        throw e;
      }
    };

    s.registerTool('room_send', { description: TOOL_DESCRIPTIONS.room_send, inputSchema: RoomSendInput }, guard(async ({ content, replyTo, clientMsgId }) => {
      const sent = await store.send(who.roomId, who.participantId, { content, replyTo, clientMsgId });
      // the message is already stored: a failing piggyback must not turn a successful send into an error (a retry would be a duplicate)
      const piggyback = await news(who).catch((e: unknown) => {
        log.error({ evt: 'piggyback_failed', err: errKind(e), roomId: who.roomId });
        return undefined;
      });
      return text(`sent seq=${sent.seq} id=${sent.id} duplicate=${sent.duplicate}\n${piggyback ?? '(could not read new messages, call room_inbox)'}`);
    }));

    s.registerTool('room_inbox', { description: TOOL_DESCRIPTIONS.room_inbox, inputSchema: RoomInboxInput }, guard(async ({ sinceSeq, limit, waitSeconds }) => {
      // omitted waitSeconds = wait (as the tool description promises); an explicit 0 means no wait
      await store.waitForMessages(who.roomId, who.participantId, { sinceSeq, waitMs: Math.min(waitSeconds ?? LIMITS.inboxWaitMaxSeconds, LIMITS.inboxWaitMaxSeconds) * 1000, signal });
      const out = await news(who, { sinceSeq, limit, signal });
      return text(out ?? 'aborted'); // client went away: nothing was delivered, cursor and receipts untouched
    }));

    s.registerTool('room_history', { description: TOOL_DESCRIPTIONS.room_history, inputSchema: RoomHistoryInput }, guard(async ({ beforeSeq, limit }) => {
      // the store raises the lower bound to this participant's join point (history_visibility since_join)
      const page = await store.list(who.roomId, { before: beforeSeq, limit: limit ?? LIMITS.historyLimitDefault, maxBytes: BYTE_CAP, participantId: who.participantId });
      const first = page.messages[0]?.seq;
      return text(wrap(who, page.messages, page.names, null, page.hasMore && first ? `older messages exist: call room_history({beforeSeq:${first}})` : 'no older messages'));
    }));

    s.registerTool('room_participants', { description: TOOL_DESCRIPTIONS.room_participants, inputSchema: RoomParticipantsInput }, guard(async () => {
      const [room, list] = [await store.getRoom(who.roomId), await store.participants(who.roomId)];
      const body = `you: ${who.displayName} (${who.participantId})\ntopic: ${room?.topic ?? ''}\nparticipants: ${JSON.stringify(list)}`;
      return text(wrapInfoBlock(body));
    }));

    s.registerTool('cubicle_list', { description: TOOL_DESCRIPTIONS.cubicle_list, inputSchema: CubicleListInput }, guard(async () => {
      const list = await store.cubicleList(who.roomId, { participantId: who.participantId });
      return text(wrapInfoBlock(`you: ${who.displayName} (${who.participantId})
cubicles: ${JSON.stringify(list)}`));
    }));

    s.registerTool('cubicle_read', { description: TOOL_DESCRIPTIONS.cubicle_read, inputSchema: CubicleReadInput }, guard(async ({ participantId, page }) => {
      const c = await store.cubicleRead(who.roomId, { participantId: who.participantId }, participantId ?? who.participantId, page);
      // one synthetic message per page (seq = rev, id = page name) so the reader gets the same random delimiter, relation and sanitiser as room messages
      const pages: StoredMessage[] = c.pages.map((p) => ({ roomId: who.roomId, seq: p.rev, id: p.name, ts: p.updatedAt, from: c.from, content: p.content, mentions: [], hops: 0 }));
      return text(wrap(who, pages, new Map(), null, `cubicle of ${c.displayName}; id = page, seq = rev`));
    }));

    s.registerTool('cubicle_write', { description: TOOL_DESCRIPTIONS.cubicle_write, inputSchema: CubicleWriteInput }, guard(async ({ page, content, visibility }) =>
      text(JSON.stringify(await store.cubicleWrite(who.roomId, who.participantId, { page, content, visibility })))));

    s.registerTool('cubicle_delete', { description: TOOL_DESCRIPTIONS.cubicle_delete, inputSchema: CubicleDeleteInput }, guard(async ({ page }) => {
      await store.cubicleDelete(who.roomId, who.participantId, page);
      return text('deleted');
    }));

    s.registerTool('room_leave', { description: TOOL_DESCRIPTIONS.room_leave, inputSchema: RoomLeaveInput }, guard(async () => {
      await store.leave(who.roomId, who.participantId);
      return text('left');
    }));
    return s;
  };

  const handler = toNodeHandler(
    createMcpHandler(({ authInfo }) => build(authInfo!.extra as Extra), { responseMode: 'json' }),
    { maxRequestBodySize: BODY_CAP },
  );

  /** `/mcp` (Authorization: Bearer) or `/mcp/<token>` fallback. Bearer wins; a bad Bearer is 401 even with a valid path token. */
  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    // Only an ABSENT Authorization header allows the path fallback; a malformed or non-Bearer one is a 401.
    const header = req.headers.authorization;
    const bearer = header === undefined ? undefined : (/^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '');
    const token = bearer ?? (pathname.length > 5 ? pathname.slice(5).replace(/^\//, '') : '');
    const who = AGENT_TOKEN.test(token) ? await store.authToken(token, bearer === undefined) : undefined; // path tokens: anonymous rooms only (T-04)
    if (!who) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' }); // no detail on purpose
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    (req as IncomingMessage & { auth?: unknown }).auth = { token: 'redacted', clientId: who.participantId, scopes: [], extra: { who, signal: ac.signal } satisfies Extra };
    await handler(req as never, res as never);
  };
}
