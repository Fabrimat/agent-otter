// Recorded backing for two Codex findings quoted in docs/hosts/codex.md: (a) which models answer a room question, (b) what happens without
// default_tools_approval_mode="approve". Small samples on purpose (N trials per model, default 2).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { assertGlobalConfigUnchanged, globalConfigSnapshot, killAll, record, rmDir, startServer, tempDir, type Server } from '../src/harness.js';
import { runCodex } from '../src/hosts.js';
import { isRoomCall, prompt, roomTool } from '../src/scenarios.js';

let srv: Server;
const before = globalConfigSnapshot();
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { killAll(); await srv?.close(); assertGlobalConfigUnchanged(before); });

const N = Number(process.env.HOSTS_QUIRK_TRIALS ?? '2');
const note = (me: string) => `Your display name in the room is "${me}". For this test: call room_inbox (waitSeconds 5) up to 3 times, handle the room as your onboarding instructions say, then stop and answer DONE.`;

async function one(model: string | undefined, noApprove: boolean) {
  const room = await srv.createRoom('codex quirks');
  const a = await room.join('bo', 'codex');
  const human = await room.human();
  human.send('@bo quick question: what is 6 times 7? Answer in the room.');
  await new Promise((r) => setTimeout(r, 500));
  const cwd = tempDir('cq');
  const run = await runCodex({ agent: a, cwd, prompt: prompt(note('bo')), timeoutMs: 4 * 60_000, model, noApprove });
  rmDir(cwd);
  const tr = await room.transcript();
  const mine = tr.filter((m) => m.from.displayName === 'bo').map((m) => m.content ?? '');
  return {
    answered42: mine.some((m) => /\b42\b/.test(m)), botMessages: mine.map((m) => m.slice(0, 120)),
    roomCalls: run.calls.filter(isRoomCall).map((c) => ({ tool: roomTool(c), isError: !!c.isError, result: (c.result ?? '').slice(0, 160) })), final: run.finalText.slice(0, 160),
  };
}

test('codex: model comparison and approval-mode behaviour (recorded)', async () => {
  const models = ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6.1-sol'];
  const byModel: Record<string, Awaited<ReturnType<typeof one>>[]> = {};
  await Promise.all(models.map(async (m) => { byModel[m] = await Promise.all(Array.from({ length: N }, () => one(m, false))); }));
  const noApprove = await one(undefined, true);
  record('codex-quirks', { id: 'CODEX-QUIRKS', trialsPerModel: N, byModel, withoutApprovalMode: noApprove });
  for (const m of models) console.log(`[CODEX-QUIRKS] ${m}: answered correctly ${byModel[m]!.filter((t) => t.answered42).length}/${N}`);
  console.log(`[CODEX-QUIRKS] without default_tools_approval_mode: ${JSON.stringify(noApprove.roomCalls.slice(0, 1))}`);
  expect(Object.keys(byModel).length).toBe(models.length);
});
