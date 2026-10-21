import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomView } from '../src/RoomView';
import { roomReducer } from '../src/roomState';
import { parseFrame } from '../src/useRoomSocket';
import { ROOM, SEC, state } from './fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PID = 'p_0123456789ab';
const EVIL = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>\nsee https://example.com';
const summary = { participantId: PID, displayName: 'bot', left: true, visibility: 'room', readable: true, pageCount: 1, updatedAt: 1 };
const view = { participantId: PID, displayName: 'bot', left: true, visibility: 'room', pages: [{ name: 'plan', content: EVIL, bytes: 5, rev: 2, updatedAt: 1 }] };
const stub = () => {
  const f = vi.fn(async (url: string) => json(url.endsWith(PID) ? view : { cubicles: [summary, { ...summary, participantId: 'p_aaaaaaaaaaaa', displayName: 'secretive', left: false, visibility: 'owner', readable: false }] }));
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

describe('cubicles panel', () => {
  it('renders content as literal text (no elements, no links), shows left and visibility markers', async () => {
    stub();
    const { container } = render(<RoomView state={state()} status="open" cubicles={{ kind: 'view', value: SEC }} />);
    expect(await screen.findByText(/1 page\(s\), room, left/)).toBeInTheDocument();
    expect(screen.getByText(/0 page|1 page\(s\), owner only/)).toBeInTheDocument();
    expect(screen.getByText('private')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open cubicle of bot' }));
    const pre = await waitFor(() => { const p = container.querySelector('pre'); expect(p).not.toBeNull(); return p!; });
    expect(pre.textContent).toBe(EVIL);
    expect(pre.children).toHaveLength(0);
    expect(container.querySelector('img, script, a[href^="https://example"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Erase/ })).toBeNull(); // viewers cannot erase
  });

  it('refetches the list when the tick changes (reconnect or cubicle event)', async () => {
    const f = stub();
    const secret = { kind: 'view', value: SEC } as const;
    const { rerender } = render(<RoomView state={state({ cubicleTick: 1 })} status="open" cubicles={secret} />);
    await screen.findByText(/left/);
    const n = () => f.mock.calls.filter(([u]) => String(u) === `/rooms/${ROOM}/cubicles`).length;
    expect(n()).toBe(1);
    rerender(<RoomView state={state({ cubicleTick: 2 })} status="open" cubicles={secret} />);
    await waitFor(() => expect(n()).toBe(2));
  });

  it('admin erase asks for confirmation, then sends erase_cubicle', async () => {
    stub();
    const onAction = vi.fn();
    const admin = { inviteLink: 'i', viewLink: 'v', onAction, onSend: () => true, ready: true };
    vi.stubGlobal('confirm', vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true));
    render(<RoomView state={state()} status="open" admin={admin} cubicles={{ kind: 'admin', value: SEC }} />);
    const btn = await screen.findAllByRole('button', { name: 'Erase cubicle of bot' });
    await userEvent.click(btn[0]!);
    expect(onAction).not.toHaveBeenCalled();
    await userEvent.click(btn[0]!);
    expect(onAction).toHaveBeenCalledWith({ action: 'erase_cubicle', participantId: PID });
  });
});

describe('cubicle events', () => {
  it('parse as metadata and bump the refetch tick; init bumps it too', () => {
    const ev = parseFrame(JSON.stringify({ type: 'cubicle', participantId: PID, page: 'plan', rev: 1, bytes: 3, updatedAt: 5 }));
    expect(ev).toMatchObject({ type: 'cubicle' });
    const s0 = state({ cubicleTick: 0 });
    expect(roomReducer(s0, ev!).cubicleTick).toBe(1);
    expect(roomReducer(s0, { type: 'init', roomId: ROOM, topic: 't', expiresAt: null, participants: [], messages: [], lastSeq: 0 }).cubicleTick).toBe(1);
  });
});
