import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRoom, saveRoom } from '../src/storage';
import { useRoomSocket } from '../src/useRoomSocket';
import { ROOM, SEC } from './fixtures';

describe('storage: permanent rooms (expiresAt null)', () => {
  const base = { roomId: ROOM, inviteSecret: SEC, adminSecret: 'f'.repeat(32), viewSecret: 'e'.repeat(32) };
  it('never drops a permanent room; still drops an expired one', () => {
    saveRoom({ ...base, expiresAt: null });
    expect(loadRoom(ROOM)?.expiresAt).toBeNull();
    saveRoom({ ...base, expiresAt: Date.now() - 1 });
    expect(loadRoom(ROOM)).toBeNull();
    expect(localStorage.getItem(`ao:room:${ROOM}`)).toBeNull();
  });
});

describe('useRoomSocket: no send before init', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('refuses send_message until the server init event, again after a reconnect socket', async () => {
    const socks: FakeWS[] = [];
    class FakeWS {
      static OPEN = 1; readyState = 1; sent: string[] = []; onopen?: () => void; onmessage?: (m: { data: string }) => void; onclose?: () => void;
      constructor() { socks.push(this); }
      send(d: string) { this.sent.push(d); }
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ticket: 'a'.repeat(32), role: 'admin', expiresInSeconds: 30 }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { result } = renderHook(() => useRoomSocket(ROOM, 'admin', SEC));
    await waitFor(() => expect(socks).toHaveLength(1));
    act(() => socks[0]!.onopen?.());
    let ok = true;
    act(() => { ok = result.current.send('too early'); });
    expect(ok).toBe(false);
    expect(socks[0]!.sent).toEqual([]);
    act(() => socks[0]!.onmessage?.({ data: JSON.stringify({ type: 'init', roomId: ROOM, topic: 'T', expiresAt: null, participants: [], messages: [], lastSeq: 0 }) }));
    expect(result.current.state.expiresAt).toBeNull();
    act(() => { ok = result.current.send('hello'); });
    expect(ok).toBe(true);
    expect(socks[0]!.sent).toHaveLength(1);
  });
});

describe('RoomView: permanent room and erase', () => {
  it('shows a badge instead of a countdown, and erase sends the admin action after confirm', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { default: userEvent } = await import('@testing-library/user-event');
    const { RoomView } = await import('../src/RoomView');
    const { msg, state } = await import('./fixtures');
    const onAction = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RoomView state={state({ expiresAt: null, messages: [msg(3)] })} status="open" admin={{ inviteLink: 'i', viewLink: 'v', onAction, onSend: () => true, ready: true }} />);
    expect(screen.getByTestId('permanent')).toBeInTheDocument();
    expect(screen.queryByTestId('countdown')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Erase message 3' }));
    expect(onAction).toHaveBeenCalledWith({ action: 'erase', seq: 3 });
  });
});
