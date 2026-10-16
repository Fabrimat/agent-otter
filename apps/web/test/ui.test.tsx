import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_PROMPT } from '@agent-office/protocol';
import { App } from '../src/App';
import { CopyButton, Countdown } from '../src/components';
import { RoomView } from '../src/RoomView';
import { loadRoom } from '../src/storage';
import { ROOM, SEC, msg, person, state } from './fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const renderAt = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('join page', () => {
  const joinResponse = {
    participantId: 'p9', token: 'tok', displayName: 'alice-bot', vendor: 'claude-code', cursorStartsAt: 0, note: 'UNTESTED: check your docs',
    snippets: {
      claudeCode: 'CC-BASH', claudeCodePowerShell: 'CC-PS', codexConfigToml: 'CODEX-TOML', codexEnv: 'CODEX-ENV', codexPowerShell: 'CODEX-PS', pathFallbackUrl: 'http://x/mcp/tok',
    },
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? json(joinResponse)
        : json({ roomId: ROOM, topic: 'Fix the build', expiresAt: Date.now() + 1000, participants: [], paused: false, closed: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reads the fragment, keeps the secret out of URLs, shows topic and snippets with safety notice', async () => {
    renderAt(`/join#${ROOM}.${SEC}`);
    expect(await screen.findByText('Fix the build')).toBeInTheDocument();
    const [getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(`/rooms/${ROOM}`);
    expect((getInit.headers as Record<string, string>)['x-invite-secret']).toBe(SEC);

    await userEvent.type(screen.getByLabelText('Display name'), 'alice-bot');
    expect(screen.queryByRole('option', { name: 'human' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByText('CC-BASH')).toBeInTheDocument();
    for (const t of ['CC-PS', 'CODEX-TOML', 'CODEX-ENV', 'CODEX-PS', 'http://x/mcp/tok']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy/ })).toHaveLength(7); // 6 snippets + prompt
    expect(screen.getByText(ONBOARDING_PROMPT.split('\n')[0]!, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/UNTESTED/)).toBeInTheDocument();
    expect(screen.getByText(/Never join a room with strangers/)).toBeInTheDocument();

    for (const [url] of fetchMock.mock.calls as [string][]) {
      expect(url).not.toContain(SEC);
      expect(url).not.toContain('?');
    }
    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe(`/rooms/${ROOM}/join`);
    expect(postInit.referrerPolicy).toBe('no-referrer');
  });

  it('rejects an invalid fragment without calling the API', () => {
    renderAt('/join#nope');
    expect(screen.getByRole('alert')).toHaveTextContent('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('home', () => {
  it('creates a room, stores secrets locally and goes to /r without secrets in the URL', async () => {
    const created = { roomId: ROOM, inviteSecret: SEC, adminSecret: 'f'.repeat(32), viewSecret: 'e'.repeat(32), expiresAt: Date.now() + 3600_000 };
    const fetchMock = vi.fn(async (url: string) => (url === '/api/config' ? json({ createRequiresKey: false, createEnabled: true, ttlSeconds: 3600 }) : json(created)));
    vi.stubGlobal('fetch', fetchMock);
    class FakeWS { static OPEN = 1; readyState = 0; close() {} send() {} }
    vi.stubGlobal('WebSocket', FakeWS);
    renderAt('/');
    await userEvent.type(screen.getByLabelText(/Topic/), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(loadRoom(ROOM)?.adminSecret).toBe('f'.repeat(32)));
    const post = fetchMock.mock.calls.find(([u]) => u === '/rooms/anonymous') as unknown as [string, RequestInit];
    expect(JSON.parse(post[1].body as string)).toEqual({ topic: 'hi' });
    expect(post[1].headers).not.toHaveProperty('x-create-key');
    expect(await screen.findByText(/Your room/)).toBeInTheDocument();
  });
});

describe('home access gate', () => {
  const cfg = (o: object) => ({ createRequiresKey: false, createEnabled: true, ttlSeconds: 3600, ...o });
  afterEach(() => sessionStorage.clear());

  it('asks for the key, sends it as x-create-key, keeps it in sessionStorage only, explains create_forbidden', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/config' ? json(cfg({ createRequiresKey: true })) : json({ error: 'nope', code: 'create_forbidden' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/');
    await userEvent.type(await screen.findByLabelText('Access key'), 'k3y');
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('access key is missing or wrong');
    const post = fetchMock.mock.calls.find(([u]) => u === '/rooms/anonymous') as unknown as [string, RequestInit];
    expect(post[1].headers).toMatchObject({ 'x-create-key': 'k3y' });
    expect(sessionStorage.getItem('ao:createKey')).toBe('k3y');
    expect(localStorage.length).toBe(0);
  });

  it('no key field when not required; disabled creation is explained and blocks the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(cfg({ createEnabled: false }))));
    renderAt('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Room creation is turned off');
    expect(screen.queryByLabelText('Access key')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
  });
});

describe('RoomView', () => {
  const admin = { inviteLink: 'i', viewLink: 'v', onAction: vi.fn(), onSend: vi.fn(() => true) };
  const s = state({ participants: [person()] });

  it('viewer has no send box and no admin controls', () => {
    render(<RoomView state={s} status="open" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    for (const n of [/kick/i, /pause/i, /close/i, /invite/i, /send/i]) expect(screen.queryByRole('button', { name: n })).toBeNull();
  });

  it('admin has kick, pause, close, links and send box; actions need confirmation', async () => {
    const onAction = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    render(<RoomView state={s} status="open" admin={{ ...admin, onAction }} />);
    expect(screen.getByRole('textbox', { name: 'Message as human' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy read-only view link' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Kick bot' }));
    expect(onAction).not.toHaveBeenCalled(); // declined
    await userEvent.click(screen.getByRole('button', { name: 'Kick bot' }));
    expect(onAction).toHaveBeenLastCalledWith({ action: 'kick', participantId: 'p1' });
    await userEvent.click(screen.getByRole('button', { name: 'Pause room' }));
    expect(onAction).toHaveBeenLastCalledWith({ action: 'pause', paused: true });
    await userEvent.click(screen.getByRole('button', { name: 'Close room' }));
    expect(onAction).toHaveBeenLastCalledWith({ action: 'close' });
    confirm.mockRestore();
  });

  it('admin never sees a Kick button for human participants', () => {
    render(<RoomView state={state({ participants: [person({ participantId: 'h', displayName: 'Ann', kind: 'human', vendor: undefined })] })} status="open" admin={admin} />);
    expect(screen.queryByRole('button', { name: /kick/i })).toBeNull();
  });

  it('copy button reports failure and exposes the text when clipboard is unavailable or rejects', async () => {
    const { unmount } = render(<CopyButton text="secret-snippet" />);
    vi.stubGlobal('navigator', { clipboard: undefined });
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Copy failed, select the text manually');
    expect(screen.getByLabelText('Text to copy')).toHaveValue('secret-snippet');
    unmount();
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    render(<CopyButton text="x" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed');
  });

  it('admin sends a message', async () => {
    const onSend = vi.fn(() => true);
    render(<RoomView state={s} status="open" admin={{ ...admin, onSend }} />);
    await userEvent.type(screen.getByRole('textbox'), 'yo');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('yo');
  });

  it('shows banners', () => {
    const { rerender } = render(<RoomView state={state({ paused: true })} status="open" />);
    expect(screen.getByRole('status')).toHaveTextContent('paused');
    rerender(<RoomView state={state({ closing: true })} status="open" />);
    expect(screen.getByRole('status')).toHaveTextContent('closing');
    rerender(<RoomView state={state({ closed: true })} status="open" />);
    expect(screen.getByRole('status')).toHaveTextContent('closed');
  });

  it('shows receipts and distinguishes human by server kind, vendor as declared', () => {
    const st = state({
      participants: [person(), person({ participantId: 'h', displayName: 'Ann', kind: 'human', vendor: undefined })],
      messages: [msg(0), msg(1, { from: { kind: 'human', participantId: 'h', displayName: 'claude-code', vendor: 'codex' } })],
      receipts: { 0: { h: Date.UTC(2024, 0, 1, 12, 34) } },
    });
    render(<RoomView state={st} status="open" />);
    expect(screen.getByText(/seen by Ann at/)).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').filter((li) => li.dataset['kind']);
    expect(rows.map((r) => r.dataset['kind'])).toEqual(['agent', 'human']);
    expect(screen.getAllByText(/declared: codex/).length).toBeGreaterThan(0);
  });

  it('renders hostile content as inert text', () => {
    const evil = [
      '<img src=x onerror="alert(1)">',
      '<script>alert(2)</script>',
      '[click](javascript:alert(3)) javascript:alert(4)',
      'a‮b​c⁦d',
    ].join('\n');
    const { container } = render(
      <RoomView state={state({ messages: [msg(0, { content: evil, from: { kind: 'agent', participantId: 'p1', displayName: '<b>bold</b>', vendor: 'codex' } })] })} status="open" />,
    );
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(/<img src=x onerror/)).toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(4\)/)).toBeInTheDocument();
    expect(screen.getByText('<b>bold</b>')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[‮​⁦]/);
    expect(container.textContent).toContain('abcd');
  });

  it('has an aria-live transcript', () => {
    render(<RoomView state={s} status="open" />);
    expect(screen.getByLabelText('Transcript')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('countdown', () => {
  it('counts down', () => {
    vi.useFakeTimers();
    render(<Countdown expiresAt={Date.now() + 90_000} />);
    expect(screen.getByTestId('countdown')).toHaveTextContent('01:30');
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(screen.getByTestId('countdown')).toHaveTextContent('00:59');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('countdown')).toHaveTextContent('expired');
    vi.useRealTimers();
  });
});

describe('viewer and misc pages', () => {
  it('viewer page parses fragment and requests a ticket with the view header only', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'bad', code: 'bad_secret' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    renderAt(`/view#${ROOM}.${SEC}`);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/rooms/${ROOM}/ws-ticket`);
    expect(init.headers).toMatchObject({ 'x-view-secret': SEC });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(await screen.findByRole('alert')).toHaveTextContent('bad_secret');
  });

  it('safety page lists what we do not defend; unknown route is not found', () => {
    const a = renderAt('/safety');
    expect(screen.getByText(/What we do NOT defend/)).toBeInTheDocument();
    expect(screen.getByText(/permission-bypass mode in a room with strangers/)).toBeInTheDocument();
    a.unmount();
    renderAt('/nope');
    expect(screen.getByText(/does not exist/)).toBeInTheDocument();
  });

  it('admin page with nothing stored points to home', () => {
    renderAt('/r');
    expect(screen.getByRole('alert')).toHaveTextContent('No room found');
  });
});
