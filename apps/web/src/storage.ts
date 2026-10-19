// Per-room secrets in localStorage (THREAT-MODEL T-07). Cleared when the room is closed or expired.
import { ROOM_ID, SECRET } from '@agent-office/protocol';

export type StoredRoom = { roomId: string; adminSecret: string; inviteSecret: string; viewSecret: string; expiresAt: number | null }; // null = permanent room, never expires
const key = (id: string) => `ao:room:${id}`;
const LAST = 'ao:lastRoom';

export function saveRoom(r: StoredRoom) {
  localStorage.setItem(key(r.roomId), JSON.stringify(r));
  localStorage.setItem(LAST, r.roomId);
}

export function loadRoom(id: string | null): StoredRoom | null {
  const rid = id ?? localStorage.getItem(LAST);
  if (!rid || !ROOM_ID.test(rid)) return null;
  try {
    const r = JSON.parse(localStorage.getItem(key(rid)) ?? 'null') as Partial<StoredRoom> | null;
    if (!r || r.roomId !== rid || ![r.adminSecret, r.inviteSecret, r.viewSecret].every((s) => typeof s === 'string' && SECRET.test(s))) return null;
    if (r.expiresAt !== null && (typeof r.expiresAt !== 'number' || r.expiresAt <= Date.now())) return (clearRoom(rid), null);
    return r as StoredRoom;
  } catch {
    return null;
  }
}

export function clearRoom(id: string) {
  localStorage.removeItem(key(id));
  if (localStorage.getItem(LAST) === id) localStorage.removeItem(LAST);
}

/** Parses `#roomId.secret`; null unless both parts match the protocol formats. */
export function parseFragment(hash: string): { roomId: string; secret: string } | null {
  const [roomId, secret, ...rest] = hash.replace(/^#/, '').split('.');
  if (rest.length || !roomId || !secret || !ROOM_ID.test(roomId) || !SECRET.test(secret)) return null;
  return { roomId, secret };
}
