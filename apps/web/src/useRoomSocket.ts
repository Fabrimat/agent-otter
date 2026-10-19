// Live room connection: one-time ticket -> WS with lastSeq -> validated events -> reducer. Reconnects with backoff and a NEW ticket.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ROUTES, ServerEvent, type ClientCommand } from '@agent-otter/protocol';
import { ApiError, api } from './api';
import { initialRoomState, roomReducer } from './roomState';

/** Never trust a frame: JSON + schema or nothing. */
export function parseFrame(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const r = ServerEvent.safeParse(JSON.parse(data));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export const backoffMs = (attempt: number) => Math.min(15_000, 500 * 2 ** attempt);
const FATAL = new Set(['bad_secret', 'room_not_found', 'room_closed']);

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export function useRoomSocket(roomId: string, role: 'admin' | 'view', secret: string) {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const lastSeq = useRef(-1);
  const ws = useRef<WebSocket | null>(null);
  const inited = useRef(false); // per connection: the server drops send_message before `init`
  lastSeq.current = state.lastSeq;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const retry = () => {
      if (stopped) return;
      setStatus('reconnecting');
      timer = setTimeout(connect, backoffMs(attempt++));
    };

    async function connect() {
      if (stopped) return;
      let ticket: string;
      try {
        ticket = (await api.wsTicket(roomId, { kind: role, value: secret })).ticket;
      } catch (e) {
        if (e instanceof ApiError && e.code && FATAL.has(e.code)) {
          dispatch({ type: 'error', code: e.code, message: e.message });
          setStatus('stopped');
          return;
        }
        return retry();
      }
      if (stopped) return;
      const base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
      const sock = new WebSocket(base + ROUTES.ws(ticket, lastSeq.current >= 0 ? lastSeq.current : undefined));
      ws.current = sock;
      inited.current = false;
      sock.onopen = () => setStatus('open');
      sock.onmessage = (m) => {
        const ev = parseFrame(m.data);
        if (!ev) return; // malformed frame: dropped
        if (ev.type === 'init') inited.current = true;
        attempt = 0; // backoff resets only after the first valid frame
        dispatch(ev);
        if (ev.type === 'room_closed') { stopped = true; setStatus('stopped'); sock.close(); }
      };
      sock.onclose = () => { if (ws.current === sock) ws.current = null; retry(); };
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      const s = ws.current;
      ws.current = null;
      if (s) { s.onclose = null; s.close(); }
    };
  }, [roomId, role, secret]);

  const send = useCallback((content: string) => {
    const cmd: ClientCommand = { type: 'send_message', content, clientMsgId: crypto.randomUUID() };
    if (!inited.current || ws.current?.readyState !== WebSocket.OPEN) return false;
    ws.current.send(JSON.stringify(cmd));
    return true;
  }, []);

  return { state, status, send };
}
