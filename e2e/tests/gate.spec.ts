import { AxeBuilder } from '@axe-core/playwright';
import { ROUTES } from '@lesscubicles/protocol';
import { createRoomUi, expect, joinViaUi, test } from '../fixtures';

test.describe('9. access gate: CREATE_KEY', () => {
  test.use({ serverEnv: { CREATE_KEY: 'open-sesame' } });

  test('wrong key rejected in the UI, right key works, healthz ok', async ({ page, server, rest }) => {
    expect(await (await fetch(server.url + '/healthz')).json()).toEqual({ ok: true });
    expect((await rest.post(ROUTES.createRoom)).status).toBe(403); // no key at all

    await page.goto(server.url + '/');
    const key = page.getByLabel('Access key');
    await expect(key).toBeVisible();
    await key.fill('wrong');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(page.getByRole('alert')).toContainText('access key is missing or wrong');
    expect(page.url()).not.toContain('/r#');

    await key.fill('open-sesame');
    await page.getByRole('button', { name: 'Create room' }).click();
    await page.waitForURL(/\/r#[0-9a-f]{12}$/);
    await expect(page.getByText('connection: open')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('ao:createKey'))).toBeNull(); // key lives in sessionStorage only
    expect(server.logs.join('')).not.toContain('open-sesame');
  });
});

test.describe('9. access gate: CREATE_ROOMS=false', () => {
  test.use({ serverEnv: { CREATE_ROOMS: 'false' } });

  test('shows the disabled message; healthz ok; API answers create_disabled', async ({ page, server, rest }) => {
    await page.goto(server.url + '/');
    await expect(page.getByRole('alert')).toContainText('Room creation is turned off');
    await expect(page.getByRole('button', { name: 'Create room' })).toBeDisabled();
    expect((await fetch(server.url + '/healthz')).status).toBe(200);
    const r = await rest.post(ROUTES.createRoom);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe('create_disabled');
  });
});

test.describe('10. expiry', () => {
  test.use({ serverEnv: { ROOM_TTL_SECONDS: '6' } });

  test('closing banner, then closed; MCP token 401; room gone', async ({ page, server, rest, connectAgent }) => {
    const room = await createRoomUi(page, server);
    const { token } = await rest.join(room, 'bot');
    const agent = await connectAgent(token);
    expect((await agent.call('room_participants')).isError).toBe(false);

    await expect(page.getByRole('status')).toContainText('closing soon');
    await expect(page.getByRole('status')).toContainText('This room is closed', { timeout: 15_000 });
    await expect(page.getByTestId('countdown')).toHaveText('Expires in expired');

    const mcp = await fetch(server.url + ROUTES.mcp, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);
    const gone = await fetch(server.url + ROUTES.room(room.roomId), { headers: { 'x-admin-secret': room.adminSecret } });
    expect([404, 410]).toContain(gone.status);
    // the stored secrets are dropped once the room is dead, so a reload shows the "no room" notice
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('No room found');
  });
});

test('11. accessibility smoke: no critical or serious axe violations', async ({ page, server, newContext }) => {
  const scan = async (label: string, p = page) => {
    const { violations } = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`);
    expect(bad, label).toEqual([]);
  };
  await page.goto(server.url + '/');
  await expect(page.getByRole('button', { name: 'Create room' })).toBeVisible();
  await scan('home');
  await page.goto(server.url + '/safety');
  await expect(page.getByText('What we do NOT defend')).toBeVisible();
  await scan('safety');

  const room = await createRoomUi(page, server);
  await expect(page.getByText('connection: open')).toBeVisible();
  await scan('admin');

  const guest = await (await newContext()).newPage();
  await guest.goto(room.inviteLink);
  await expect(guest.getByLabel('Display name')).toBeVisible();
  await scan('join form', guest);
  await joinViaUi(guest, room.inviteLink, 'axe-bot');
  await expect(guest.getByRole('region', { name: 'Onboarding prompt' })).toBeVisible();
  await scan('join snippets', guest);
});
