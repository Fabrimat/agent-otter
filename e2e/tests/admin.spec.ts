import { ROUTES } from '@lesscubicles/protocol';
import { createRoomUi, expect, startProxy, test, transcript } from '../fixtures';

const mcpStatus = (url: string, token: string) =>
  fetch(url + ROUTES.mcp, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then((r) => r.status);

test('6. admin controls: pause, resume, kick (never the human), close', async ({ page, server, newContext, rest, connectAgent }) => {
  const room = await createRoomUi(page, server);
  const viewer = await (await newContext()).newPage();
  await viewer.goto(room.viewLink);
  await expect(viewer.getByText('connection: open')).toBeVisible();
  const [a, b] = [await rest.join(room, 'agent-a'), await rest.join(room, 'agent-b')];
  const agent = await connectAgent(a.token);
  await expect(page.getByRole('list', { name: 'Participants' })).toContainText('agent-b');

  // pause blocks agent sends with a clear error and shows the banner
  await page.getByRole('button', { name: 'Pause room' }).click();
  await expect(page.getByRole('status')).toContainText('paused');
  const blocked = await agent.call('room_send', { content: 'while paused' });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toMatch(/room_paused/);
  await expect(transcript(page).getByText('while paused')).toHaveCount(0);

  // resume
  await page.getByRole('button', { name: 'Resume room' }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
  expect((await agent.call('room_send', { content: 'after resume' })).isError).toBe(false);
  await expect(transcript(page).getByText('after resume')).toBeVisible();

  // Kick is offered for the two agents only, never for the human
  await expect(page.getByRole('button', { name: /^Kick / })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Kick (?!agent-)/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Kick agent-b' }).click();
  await expect(page.getByRole('button', { name: 'Kick agent-b' })).toHaveCount(0);
  await expect.poll(() => mcpStatus(server.url, b.token)).toBe(401);
  expect(await mcpStatus(server.url, a.token)).toBe(200); // the other agent is unaffected

  // close disconnects everyone
  await page.getByRole('button', { name: 'Close room' }).click();
  await expect(page.getByRole('status')).toContainText('closed');
  await expect(viewer.getByRole('status')).toContainText('closed');
  await expect(page.getByText('connection: stopped')).toBeVisible();
  await expect.poll(() => mcpStatus(server.url, a.token)).toBe(401);
  await expect(page.getByRole('button', { name: 'Close room' })).toBeDisabled();
});

test('7. offline and server-side drop: reconnects with a NEW ticket, no duplicate or lost messages', async ({ page, server, context, rest, connectAgent, issues }) => {
  issues.allow.push(/WebSocket|ERR_INTERNET_DISCONNECTED|Failed to fetch/i); // expected while the network is down
  const proxy = await startProxy(server.port);
  try {
    const tickets: string[] = [];
    const sockets: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/ws-ticket')) tickets.push(r.url()); });
    page.on('websocket', (w) => sockets.push(w.url()));

    await createRoomUi(page, { ...server, url: proxy.url });
    await expect(page.getByText('connection: open')).toBeVisible();
    const room = await page.evaluate(() => JSON.parse(localStorage.getItem(`ao:room:${localStorage.getItem('ao:lastRoom')}`)!) as { roomId: string; inviteSecret: string });
    const agent = await connectAgent((await rest.join(room, 'bot')).token);
    for (const m of ['m1', 'm2']) await agent.call('room_send', { content: m });
    await expect(transcript(page).getByText('m2')).toBeVisible();

    await context.setOffline(true);
    proxy.drop(); // the server sees the socket die
    await expect(page.getByText('connection: reconnecting')).toBeVisible();
    for (const m of ['m3', 'm4']) await agent.call('room_send', { content: m });
    await expect(transcript(page).getByText('m3')).toHaveCount(0); // really offline
    await page.waitForTimeout(1500); // a few failed reconnect attempts
    await context.setOffline(false);

    await expect(page.getByText('connection: open')).toBeVisible({ timeout: 25_000 });
    for (const m of ['m1', 'm2', 'm3', 'm4']) await expect(transcript(page).getByText(m, { exact: true })).toHaveCount(1);
    await expect(transcript(page).locator('li[data-kind]')).toHaveCount(4);
    expect(tickets.length).toBeGreaterThanOrEqual(2); // a new ticket per connection
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.at(-1)).toMatch(/lastSeq=\d+/); // resumes from the last seen seq
    const ids = sockets.map((s) => new URL(s).searchParams.get('ticket'));
    expect(new Set(ids).size).toBe(ids.length); // never a reused ticket

    // a live message after the resume arrives exactly once
    await agent.call('room_send', { content: 'm5' });
    await expect(transcript(page).getByText('m5', { exact: true })).toHaveCount(1);
  } finally {
    proxy.close();
  }
});

test('8. secret scanner: blocked for agent and for human, never shown or logged', async ({ page, server, rest, connectAgent }) => {
  const key = 'AKIAIOSFODNN7EXAMPLE';
  const room = await createRoomUi(page, server);
  const agent = await connectAgent((await rest.join(room, 'leaky-bot')).token);

  const r = await agent.call('room_send', { content: `my key is ${key}` });
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/secret_detected/);
  expect(r.text).toMatch(/looks like it contains a secret \(aws-key\)/);
  expect(r.text).not.toContain(key);

  await page.getByRole('textbox', { name: 'Message as human' }).fill(`export it: ${key}`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toContainText('looks like it contains a secret');
  await expect(page.getByRole('alert')).toContainText('secret_detected');

  await agent.call('room_send', { content: 'clean message' }); // flushes: proves the room still works and ordering
  await expect(transcript(page).getByText('clean message')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain(key);
  expect(await page.content()).not.toContain(key);
  await expect.poll(() => server.logs.join('')).toContain('secret_blocked');
  expect(server.logs.join('')).not.toContain(key);
  expect(server.logs.join('')).not.toContain('AKIA');
});
