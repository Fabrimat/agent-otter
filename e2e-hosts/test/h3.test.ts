// H3: claude-code and codex in ONE room (cross-vendor), plus the pull-usability measurements from spike/README.md:
// loop persistence of room_inbox(waitSeconds 25) and the host tool-timeout behaviour.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { assertGlobalConfigUnchanged, globalConfigSnapshot, killAll, median, record, rmDir, startServer, tempDir, type Server } from '../src/harness.js';
import { HOSTS, NAME, inboxStats, isRoomCall, prompt, roomTool, startHost, waitInRoom } from '../src/scenarios.js';

let srv: Server;
const before = globalConfigSnapshot();
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { killAll(); await srv?.close(); assertGlobalConfigUnchanged(before); });

const [CC, CX] = [NAME['claude-code'], NAME.codex];

test('H3: cross-vendor conversation (human -> claude -> codex)', async () => {
  const room = await srv.createRoom('H3 cross-vendor');
  const ada = await room.join(CC, 'claude-code');
  const bo = await room.join(CX, 'codex');
  const human = await room.human();
  const dirs = [tempDir('h3a'), tempDir('h3b')];
  const note = (me: string, other: string) =>
    `Your display name in the room is "${me}"; another agent here is "${other}". For this test: stay in the room with room_inbox (waitSeconds 25). ` +
    `Reply with room_send when you are mentioned or asked. After you have replied once, stop and answer DONE. Give up after 10 room_inbox calls.`;
  const runs = Promise.all([
    startHost('claude-code', ada, prompt(note(CC, CX)), { cwd: dirs[0]!, timeoutMs: 6 * 60_000, maxTurns: 16 }),
    startHost('codex', bo, prompt(note(CX, CC)), { cwd: dirs[1]!, timeoutMs: 6 * 60_000 }),
  ]);
  const inRoom = await waitInRoom(room, [CC, CX], 120_000, 6000);
  const askedAt = Date.now();
  if (inRoom) human.send(`@${CC} quick question: what is 17 plus 25? Answer in the room and mention @${CX} in your answer so he can tell us double that number.`);
  const askSeq = (await room.waitFor((m) => m.from.kind === 'human', 10_000))?.seq ?? 0;
  const adaReply = await room.waitFor((m) => m.from.displayName === CC, 150_000, askSeq);
  const boReply = adaReply ? await room.waitFor((m) => m.from.displayName === CX, 150_000, adaReply.seq) : undefined;
  const [rcc, rcx] = await runs;
  dirs.forEach(rmDir);
  const transcript = await room.transcript();

  const result = {
    id: 'H3', joinedBoth: inRoom, versions: { 'claude-code': rcc.version, codex: rcx.version }, models: { 'claude-code': rcc.model, codex: rcx.model },
    messagesExchanged: transcript.length, transcript: transcript.map((m) => ({ seq: m.seq, ts: m.ts, from: m.from.displayName, content: m.content })),
    latencyMs: {
      humanToClaudeReply: adaReply ? adaReply.ts - askedAt : null,
      claudeReplyToCodexReply: adaReply && boReply ? boReply.ts - adaReply.ts : null,
      humanToCodexReply: boReply ? boReply.ts - askedAt : null,
    },
    receipts: human.events.filter((e) => e.type === 'receipt').map((e) => (e.type === 'receipt' ? { participantId: e.participantId, seqs: e.seqs } : null)),
    participantIds: { [CC]: ada.participantId, [CX]: bo.participantId },
    claudeMentionedCodex: adaReply ? adaReply.mentions.includes(CX) : false,
    perHost: {
      'claude-code': { turns: rcc.turns, costUsd: rcc.costUsd, ms: rcc.ms, inbox: inboxStats(rcc.calls), roomCalls: rcc.calls.filter(isRoomCall).map(roomTool), outside: rcc.calls.filter((c) => !isRoomCall(c) && c.tool !== 'ToolSearch').map((c) => c.tool), timedOut: rcc.timedOut, errors: rcc.calls.filter((c) => c.isError).map((c) => ({ tool: c.tool, result: (c.result ?? '').slice(0, 200) })), final: rcc.finalText.slice(0, 200) },
      codex: { turns: rcx.turns, ms: rcx.ms, inbox: inboxStats(rcx.calls), roomCalls: rcx.calls.filter(isRoomCall).map(roomTool), outside: rcx.calls.filter((c) => !isRoomCall(c)).map((c) => c.tool), timedOut: rcx.timedOut, errors: rcx.calls.filter((c) => c.isError).map((c) => ({ tool: c.tool, result: (c.result ?? '').slice(0, 200) })), final: rcx.finalText.slice(0, 200) },
    },
  };
  record('h3-cross-vendor', result);
  console.log(`[H3] joined=${inRoom} claudeReply=${!!adaReply} codexReply=${!!boReply} msgs=${transcript.length} latency=${JSON.stringify(result.latencyMs)}`);
  expect(inRoom, 'both agents must reach the room').toBe(true);
  expect(adaReply, 'claude agent did not reply to the human').toBeTruthy();
  expect(boReply, 'codex agent did not answer after the claude agent mentioned it').toBeTruthy();
});

test('H3b: loop persistence: does room_inbox(waitSeconds 25) keep going by itself in an empty room (about 170 s, no nudging)', async () => {
  const room = await srv.createRoom('H3b loop');
  const WINDOW = 170_000; // codex is stopped at the window; claude by --max-turns 8 (it has no kill: the cost is reported)
  const out = await Promise.all(HOSTS.map(async (h) => {
    const agent = await room.join(NAME[h], h);
    const cwd = tempDir('h3b');
    const r = await startHost(h, agent, prompt('Nobody will write for a while: that is expected. Follow the onboarding instructions as written.'), { cwd, timeoutMs: h === 'codex' ? WINDOW : 4 * 60_000, maxTurns: 8 });
    rmDir(cwd);
    const s = inboxStats(r.calls);
    return [h, { endedBy: r.timedOut ? 'window-kill' : (r.endReason ?? 'exit'), stoppedByItself: !r.timedOut && r.endReason !== 'error_max_turns', runMs: r.ms, inbox: s, medianEmptyPollMs: median(s.emptyDurationsMs), final: r.finalText.slice(0, 300), code: r.code, costUsd: r.costUsd ?? null, turns: r.turns ?? null, usage: r.usage ?? null }] as const;
  }));
  record('h3b-loop', { id: 'H3b', windowMs: WINDOW, hosts: Object.fromEntries(out) });
  for (const [h, v] of out) console.log(`[H3b] ${h}: inbox polls=${v.inbox.calls} empty=${v.inbox.empty} stoppedByItself=${v.stoppedByItself} medianEmptyPollMs=${v.medianEmptyPollMs}`);
  expect(out.length).toBe(2);
});

test('H3c: host tool timeout shorter than the 25 s long-poll (10 s): how is it reported?', async () => {
  const room = await srv.createRoom('H3c timeout');
  const out = await Promise.all(HOSTS.map(async (h) => {
    const agent = await room.join(NAME[h], h);
    const cwd = tempDir('h3c');
    const r = await startHost(h, agent, 'Call room_inbox of the MCP server "agent-office" exactly once with waitSeconds 25. Then report the exact result or error text you got (first 200 characters), then stop.', { cwd, timeoutMs: 3 * 60_000, maxTurns: 5, toolTimeout: 10 });
    rmDir(cwd);
    const c = r.calls.find((x) => isRoomCall(x) && roomTool(x) === 'room_inbox');
    return [h, { timeoutSetTo: '10 s', call: c ? { isError: c.isError, ms: (c.tEnd ?? c.t) - c.t, result: (c.result ?? '').slice(0, 300) } : null, final: r.finalText.slice(0, 300) }] as const;
  }));
  record('h3c-timeout', { id: 'H3c', hosts: Object.fromEntries(out) });
  for (const [h, v] of out) console.log(`[H3c] ${h}: ${JSON.stringify(v.call)}`);
  expect(out.length).toBe(2);
});
