// Stateless MCP endpoint: a new McpServer per HTTP request, identity from the token (never from the MCP handshake).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  AGENT_INSTRUCTIONS, AGENT_TOKEN, LIMITS, RoomHistoryInput, RoomInboxInput, RoomLeaveInput, RoomParticipantsInput, RoomSendInput, TOOL_DESCRIPTIONS,
  detectSecrets, wrapDelivery, wrapInfoBlock, type StoredMessage,
} from '@agent-office/protocol';
import { StoreError } from './errors.js';
import { send } from './http.js';
import type { Logger } from './log.js';
import type { Identity, Names, RoomStore } from './store.js';

const BYTE_CAP = 48 * 1024; // per room_inbox / room_history / piggyback call
const BODY_CAP = 64 * 1024;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fault = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export function createMcp(d: { store: RoomStore; log: Logger }) {
  const { store, log } = d;
  type Extra = { who: Identity; signal: AbortSignal };

  // `lastSeq`: the cursor the model should continue from (null for history: it is not a cursor read)
  const wrap = (who: Identity, messages: StoredMessage[], names: Names, lastSeq: number | null, hint?: string) =>
    wrapDelivery(messages, { ownerId: who.ownerId, displayName: who.displayName, nameOf: (p) => names.get(p) }, { hint, lastSeq });

  /** New messages since the participant's cursor, wrapped. Advances the cursor and emits receipts. */
  async function news(who: Identity, o: { sinceSeq?: number; limit?: number; signal?: AbortSignal } = {}) {
    const r = await store.inbox(who.roomId, who.participantId, { sinceSeq: o.sinceSeq, limit: o.limit ?? LIMITS.inboxLimitMax, maxBytes: BYTE_CAP, signal: o.signal });
    if (!r) return undefined;
    const hint = r.hasMore ? 'more messages waiting: call room_inbox again' : `call room_inbox({sinceSeq:${r.lastSeq}}) to continue; an older sinceSeq re-reads`;
    return wrap(who, r.messages, r.names, r.lastSeq, hint);
  }

  const build = ({ who, signal }: Extra) => {
    const s = new McpServer({ name: 'agent-office', version: '0.0.1' }, { instructions: AGENT_INSTRUCTIONS });
    // StoreError becomes a tool error the model can read; anything else propagates to the SDK (generic error to the client).
    const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof text>>) => async (a: A) => {
      try {
        return await fn(a);
      } catch (e) {
        if (e instanceof StoreError) return fault(`${e.code}: ${e.message}`);
        log.error({ evt: 'internal', err: (e as Error).message, tool: true });
        throw e;
      }
    };

    s.registerTool('room_send', { description: TOOL_DESCRIPTIONS.room_send, inputSchema: RoomSendInput }, guard(async ({ content, replyTo, clientMsgId }) => {
      const kinds = detectSecrets(content);
      if (kinds.length) {
        log.warn({ evt: 'secret_blocked', via: 'mcp', roomId: who.roomId, participantId: who.participantId, kinds });
        return fault(`secret_detected: not sent, the message looks like it contains a secret (${kinds.join(', ')}). Remove it and send again.`);
      }
      const sent = await store.send(who.roomId, who.participantId, { content, replyTo, clientMsgId });
      // the message is already stored: a failing piggyback must not turn a successful send into an error (a retry would be a duplicate)
      const piggyback = await news(who).catch((e: Error) => {
        log.error({ evt: 'piggyback_failed', err: e.name, roomId: who.roomId });
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
    const who = AGENT_TOKEN.test(token) ? await store.authToken(token) : undefined;
    if (!who) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' }); // no detail on purpose
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    (req as IncomingMessage & { auth?: unknown }).auth = { token: 'redacted', clientId: who.participantId, scopes: [], extra: { who, signal: ac.signal } satisfies Extra };
    await handler(req as never, res as never);
  };
}
