import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store.js';

const mk = async (o: ConstructorParameters<typeof MemoryStore>[0] = {}) => {
  let t = 1_700_000_000_000;
  const st = new MemoryStore({ now: () => t, messagesPerMinute: 100_000, deliveryCooldownMs: 5000, ...o });
  const { roomId } = await st.createRoom('t');
  const a = (await st.join(roomId, { displayName: 'alice', vendor: 'other' })).participantId;
  const b = (await st.join(roomId, { displayName: 'bob', vendor: 'other' })).participantId;
  const say = (from: string, content: string) => st.send(roomId, from, { content });
  const inbox = (p: string) => st.inbox(roomId, p, { limit: 50, maxBytes: 1e6 });
  return { st, roomId, a, b, say, inbox, tick: (ms: number) => (t += ms) };
};
const texts = (i: any) => i.messages.map((m: any) => m.content);

describe('inbound delivery policy', () => {
  it('holds non-mention messages during the cooldown, then delivers all in order', async () => {
    const { a, b, say, inbox, tick } = await mk();
    await say(b, 'one');
    expect(texts(await inbox(a))).toEqual(['one']);
    for (const x of ['two', 'three', 'four']) await say(b, x);
    const held = (await inbox(a))!;
    expect(held).toMatchObject({ messages: [], hasMore: false, lastSeq: 1 });
    tick(4999);
    expect((await inbox(a))!.messages).toEqual([]);
    tick(1);
    expect(texts(await inbox(a))).toEqual(['two', 'three', 'four']);
  });

  it('a pending mention bypasses the cooldown', async () => {
    const { a, b, say, inbox } = await mk();
    await say(b, 'one');
    await inbox(a);
    await say(b, 'plain');
    await say(b, 'hey @alice look');
    expect(texts(await inbox(a))).toEqual(['plain', 'hey @alice look']);
  });

  it('never holds humans', async () => {
    const { st, roomId, a, say } = await mk();
    const h = (await st.joinHuman(roomId)).participantId;
    await say(a, 'one');
    expect(texts(await st.inbox(roomId, h, { limit: 50, maxBytes: 1e6 }))).toEqual(['one']);
    await say(a, 'two');
    expect(texts(await st.inbox(roomId, h, { limit: 50, maxBytes: 1e6 }))).toEqual(['two']);
  });

  it('cooldown 0 keeps the old behaviour', async () => {
    const { a, b, say, inbox } = await mk({ deliveryCooldownMs: 0 });
    await say(b, 'one');
    await inbox(a);
    await say(b, 'two');
    expect(texts(await inbox(a))).toEqual(['two']);
  });

  it('daily cap: over it only mentions get through, window resets after 24h', async () => {
    const { st, a, b, say, inbox } = await mk({ deliveryCooldownMs: 0, deliveriesPerDay: 2 });
    await say(b, 'one'); await say(b, 'two');
    expect((await inbox(a))!.messages).toHaveLength(2);
    await say(b, 'three');
    expect((await inbox(a))!.messages).toEqual([]);
    await say(b, '@alice four');
    expect(texts(await inbox(a))).toEqual(['three', '@alice four']);
    await say(b, 'five');
    expect((await inbox(a))!.messages).toEqual([]);
    // rooms live 1 h, so rewind the window start instead of ticking 24 h
    for (const r of (st as any).rooms.values()) for (const m of r.members.values()) m.dayStart -= 86_400_000;
    expect(texts(await inbox(a))).toEqual(['five']);
  });

  it('a held long-poll resolves at cooldown end, not at the poll timeout', async () => {
    const { st, roomId, a, b, say, inbox } = await mk({ now: undefined, deliveryCooldownMs: 300 });
    await say(b, 'one');
    await inbox(a);
    await say(b, 'two');
    const t0 = Date.now();
    await st.waitForMessages(roomId, a, { waitMs: 10_000 });
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThan(200);
    expect(dt).toBeLessThan(1500);
    expect(texts(await inbox(a))).toEqual(['two']);
  });
});
