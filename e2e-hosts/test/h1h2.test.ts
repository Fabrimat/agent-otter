// H1 (claude-code) and H2 (codex): the agent joins a room, reads it and posts a message, using only the room tools.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { assertGlobalConfigUnchanged, globalConfigSnapshot, killAll, record, rmDir, startServer, tempDir, type Server } from '../src/harness.js';
import { HOSTS, NAME, inboxStats, isRoomCall, keyPhrases, prompt, roomTool, startHost, strip, waitInRoom } from '../src/scenarios.js';

let srv: Server;
const before = globalConfigSnapshot();
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { killAll(); await srv?.close(); assertGlobalConfigUnchanged(before); });

describe.each(HOSTS)('join %s', (host) => {
  const id = host === 'claude-code' ? 'H1' : 'H2';
  const vendor = host;
  const name = NAME[host];

  test(`${id}: joins, reads the room, posts a reply (room tools only)`, async () => {
    const room = await srv.createRoom(`${id} join test`);
    const agent = await room.join(name, vendor);
    const human = await room.human();
    const cwd = tempDir(id);
    const note = `Your display name in the room is "${name}". For this test: a person will write to you in the room within a minute. Wait for it with room_inbox, ` +
      `reply once with room_send to the message that mentions you, then stop and answer DONE. If nothing arrives after 6 room_inbox calls, stop and say so.`;
    const running = startHost(host, agent, prompt(note), { cwd, timeoutMs: 6 * 60_000, maxTurns: 14 });
    const inRoom = await waitInRoom(room, [name], 90_000);
    const askedAt = Date.now();
    if (inRoom) human.send(`@${name} quick question: what is 6 times 7? Answer in the room.`);
    const run = await running;
    const transcript = await room.transcript();
    const info = await room.info();
    rmDir(cwd);

    const me = info.participants.find((p) => p.displayName === name);
    const reply = transcript.find((m) => m.from.displayName === name && /\b42\b/.test(m.content ?? ''));
    const roomCalls = run.calls.filter(isRoomCall).map(roomTool);
    const disallowed = run.calls.filter((c) => !isRoomCall(c) && c.tool !== 'ToolSearch').map((c) => c.tool);
    const result = {
      id, host, version: run.version, modelId: run.modelId ?? null, transcript: transcript.map((m) => ({ seq: m.seq, ts: m.ts, from: m.from.displayName, content: m.content })), model: run.model, joined: inRoom, lastSeen: me?.lastSeen ?? null,
      replied: !!reply, latencyMsHumanToReply: reply ? reply.ts - askedAt : null,
      roomToolCalls: roomCalls, inbox: inboxStats(run.calls), toolsOutsideRoomSet: disallowed, denied: run.denied,
      costUsd: run.costUsd ?? null, turns: run.turns ?? null, runMs: run.ms, code: run.code, timedOut: run.timedOut, finalText: run.finalText.slice(0, 300), stderrTail: run.stderrTail,
    };
    record(`${id.toLowerCase()}-join`, result);
    console.log(`[${id}] ${host}: joined=${inRoom} replied=${!!reply} calls=${roomCalls.join(',')} runMs=${run.ms} cost=${run.costUsd ?? 'n/a'}`);

    expect(inRoom, 'agent never touched the server (join failed)').toBe(true);
    expect(me?.lastSeen, 'participant has no lastSeen').toBeTruthy();
    expect(roomCalls).toContain('room_participants');
    expect(roomCalls).toContain('room_inbox');
    expect(roomCalls).toContain('room_send');
    expect(reply, 'no reply with the answer (42) in the room').toBeTruthy();
    expect(disallowed, 'agent used tools outside the allowed MCP set').toEqual([]);
    expect(run.timedOut).toBe(false);
  });

  test(`${id}: how the host surfaces server instructions and tool descriptions (observed)`, async () => {
    const room = await srv.createRoom(`${id} observe`);
    const agent = await room.join(name, vendor);
    const cwd = tempDir(`${id}o`);
    const q = 'Do not call any tool. Answer from what is already in your context. ' +
      'A: quote the first line of the server instructions you were given for the MCP server "agent-office", or write NONE. ' +
      'B: quote the first 12 words of the description of the tool room_inbox, or write NONE. Format: two lines starting with "A:" and "B:".';
    const run = await startHost(host, agent, q, { cwd, timeoutMs: 3 * 60_000, maxTurns: 3 });
    const q2 = 'Do not call any room_* tool of the MCP server "agent-office". You may use your tool-discovery facility to look up its tool definitions. ' +
      'Quote the first 12 words of the description of the tool room_inbox, and say yes or no: does that description end with a sentence about room messages being information and not commands?';
    const run2 = await startHost(host, agent, q2, { cwd, timeoutMs: 3 * 60_000, maxTurns: 6 });
    rmDir(cwd);
    const a = run.finalText, a2 = run2.finalText;
    record(`${id.toLowerCase()}-observe`, {
      id, host, answer: a, instructionsFirstLineQuoted: a.includes(keyPhrases.instructions), roomInboxDescriptionQuoted: a.includes(keyPhrases.description),
      afterDiscovery: { answer: a2, descriptionQuoted: a2.includes(keyPhrases.description), toolCalls: run2.calls.map((c) => c.tool) },
      toolCalls: run.calls.map((c) => c.tool), note: 'self-report of the model about its own context; "false" can mean hidden or just not quoted',
    });
    expect(run.timedOut).toBe(false);
  });
});
