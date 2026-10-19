// RoomStore: the one allowed abstraction (MemoryStore now, PostgresStore in phase 2). Anonymous rooms live in memory only:
// nothing in this file touches the disk.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type AdminAction, type CreateRoomResponse, type ParticipantInfo, type RoomPublicInfo, type Rng, type StoredMessage, type Vendor,
  LIMITS, detectSecrets, isReservedName, sanitizeIdent, sanitizeText, skeleton,
} from '@agent-office/protocol';
import { StoreError } from './errors.js';
import { SlidingWindow } from './ratelimit.js';

export type Role = 'invite' | 'view' | 'admin';
export type Names = Map<string, string>; // participantId -> displayName
export type Identity = { roomId: string; participantId: string; ownerId: string; displayName: string };
export type RoomEvent =
  | { type: 'message'; message: StoredMessage; names: Names }
  | { type: 'participants'; participants: ParticipantInfo[] }
  | { type: 'receipt'; participantId: string; seqs: number[]; at: number }
  | { type: 'paused'; paused: boolean }
  | { type: 'closing'; expiresAt: number }
  | { type: 'closed'; reason: string }
  | { type: 'kicked'; participantId: string };
export type Page = { messages: StoredMessage[]; hasMore: boolean; lastSeq: number; names: Names; adminOwnerId: string };
export type Inbox = { messages: StoredMessage[]; hasMore: boolean; lastSeq: number; names: Names };
export type JoinResult = Identity & { token: string; vendor: Vendor; cursorStartsAt: number };

export interface RoomStore {
  createRoom(topic: string): Promise<CreateRoomResponse>;
  getRoom(roomId: string): Promise<RoomPublicInfo | undefined>;
  checkSecret(roomId: string, role: Role, secret: string): Promise<boolean>;
  join(roomId: string, req: { displayName: string; vendor: Vendor }): Promise<JoinResult>;
  joinHuman(roomId: string): Promise<Identity>;
  /** Token -> identity; undefined when unknown, revoked, left, kicked, closed or expired. Also marks the participant as seen. */
  authToken(token: string): Promise<Identity | undefined>;
  send(roomId: string, participantId: string, input: { content: string; replyTo?: string; clientMsgId?: string }): Promise<{ seq: number; id: string; duplicate: boolean }>;
  /** Commits a delivery: advances the cursor and emits a receipt. Returns undefined (and changes nothing) if `signal` is already aborted. */
  inbox(roomId: string, participantId: string, o: { sinceSeq?: number; limit: number; maxBytes: number; signal?: AbortSignal }): Promise<Inbox | undefined>;
  /** Resolves when there is something for the participant, the room closed, the timer ran out or `signal` aborted. Commits nothing. */
  waitForMessages(roomId: string, participantId: string, o: { sinceSeq?: number; waitMs: number; signal?: AbortSignal }): Promise<void>;
  /** `after`: exclusive lower bound, `before`: exclusive upper bound; with `after` pages forward, else returns the newest `limit`; ascending order.
   *  With `participantId` the lower bound is raised to that participant's join point (history_visibility since_join). */
  list(roomId: string, q: { after?: number; before?: number; participantId?: string; limit: number; maxBytes?: number }): Promise<Page>;
  participants(roomId: string): Promise<ParticipantInfo[]>;
  leave(roomId: string, participantId: string): Promise<void>;
  admin(roomId: string, action: AdminAction): Promise<void>;
  issueTicket(roomId: string, role: 'admin' | 'viewer', ip?: string): Promise<{ ticket: string; role: 'admin' | 'viewer'; expiresInSeconds: number }>;
  redeemTicket(ticket: string): Promise<{ roomId: string; role: 'admin' | 'viewer' } | undefined>;
  subscribe(roomId: string, fn: (e: RoomEvent) => void): () => void;
  sweep(): Promise<void>;
}

export type MemoryStoreOptions = {
  now?: () => number;
  rng?: Rng;
  maxRooms?: number;
  maxAgents?: number;
  maxHumans?: number;
  ringSize?: number;
  messagesPerMinute?: number;
  ttlMs?: number;
  ringBytes?: number;
  maxTotalBytes?: number;
  maxWaitsPerParticipant?: number;
  maxTicketsPerRoom?: number;
  maxTicketsPerIp?: number;
  deliveryCooldownMs?: number; // 0 disables
  deliveriesPerDay?: number; // 0 disables
};

type Member = {
  id: string; ownerId: string; displayName: string; kind: 'agent' | 'human'; vendor?: Vendor; tokenHash?: string;
  cursor: number; joinSeq: number; left: boolean; conns: number; lastSeen: number | null; sent: Map<string, { seq: number; id: string }>;
  waits: Set<() => void>; // resolvers of this participant's open long-polls, oldest first
  deliveredAt: number; dayStart: number; dayCount: number; // inbound delivery policy (agents only): last non-empty batch, 24h window start, messages delivered in it
};
type Room = {
  id: string; topic: string; secrets: Record<Role, string>; adminOwnerId: string; expiresAt: number; seq: number; ring: StoredMessage[]; bytes: number;
  members: Map<string, Member>; paused: boolean; closed: boolean; closingSent: boolean; listeners: Set<(e: RoomEvent) => void>; limiter: SlidingWindow;
};

const CLIENT_MSG_IDS = 100; // remembered per participant
const TICKET_TTL_S = 30;
const DAY_MS = 86_400_000;
const CLOSING_WARNING_MS = 60_000;
// Memory bound on the member map. Departed AGENTS stay in the map on purpose (anti-impersonation: a left agent's name cannot be reused in this room),
// so a room that churns through 200 distinct agent names is full. The admin human is one stable member, so reconnects never grow the map.
const MAX_MEMBERS = 200;
const MAX_TICKETS = 10_000;
// Memory math. A stored message costs its content bytes plus MSG_OVERHEAD (object, ids, strings, mentions; rounded up).
// Per room: ringBytes (2 MB) bounds the ring, oldest dropped first (a 16 KB message means at least 128 stay).
// Global: maxTotalBytes (256 MB) bounds the sum over all rooms and REJECTS sends (rate_limited) instead of evicting other rooms' history.
// Worst case 1000 rooms x 2 MB = 2 GB would exceed it, so the global budget is the binding limit; accounted bytes are only PART of the heap: strings,
// objects, listeners, tokens, tickets and the runtime come on top, and V8 does not GC before a cgroup OOM-kill. 256 MB accounted is sized for
// roughly a 768 MB container; raise MAX_TOTAL_BYTES only together with the memory limit.
const MSG_OVERHEAD = 256;
const cost = (m: StoredMessage) => Buffer.byteLength(m.content ?? '') + MSG_OVERHEAD;

const sha = (s: string) => createHash('sha256').update(s).digest();
export const sameSecret = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));
const defaultRng: Rng = (n) => crypto.getRandomValues(new Uint8Array(n));

export class MemoryStore implements RoomStore {
  private rooms = new Map<string, Room>();
  private tokens = new Map<string, { roomId: string; participantId: string }>(); // sha256(token) hex -> owner
  private tickets = new Map<string, { roomId: string; role: 'admin' | 'viewer'; ip: string; exp: number }>();
  private now: () => number;
  private rng: Rng;
  private o: Required<Omit<MemoryStoreOptions, 'now' | 'rng'>>;
  private totalBytes = 0;
  private ticketsByRoom = new Map<string, number>();
  private ticketsByIp = new Map<string, number>();

  constructor(o: MemoryStoreOptions = {}) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? defaultRng;
    this.o = {
      maxRooms: o.maxRooms ?? 1000, maxAgents: o.maxAgents ?? LIMITS.agentsPerRoom, maxHumans: o.maxHumans ?? LIMITS.humansPerRoom,
      ringSize: o.ringSize ?? LIMITS.ringSize, messagesPerMinute: o.messagesPerMinute ?? LIMITS.messagesPerMinutePerRoom,
      ttlMs: Math.min(o.ttlMs ?? LIMITS.roomTtlMs, LIMITS.roomTtlMs), ringBytes: o.ringBytes ?? 2 * 1024 * 1024, maxTotalBytes: o.maxTotalBytes ?? 256 * 1024 * 1024,
      maxWaitsPerParticipant: o.maxWaitsPerParticipant ?? 2, maxTicketsPerRoom: o.maxTicketsPerRoom ?? 50, maxTicketsPerIp: o.maxTicketsPerIp ?? 20,
      deliveryCooldownMs: o.deliveryCooldownMs ?? 5000, deliveriesPerDay: o.deliveriesPerDay ?? 2000,
    };
  }

  private hex = (bytes: number) => [...this.rng(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
  private live(id: string): Room | undefined {
    const r = this.rooms.get(id);
    return r && this.now() < r.expiresAt ? r : undefined;
  }
  private open(id: string): Room {
    const r = this.live(id);
    if (!r) throw new StoreError('room_not_found', 'room not found');
    if (r.closed) throw new StoreError('room_closed', 'room is closed');
    return r;
  }
  private names = (r: Room): Names => new Map([...r.members.values()].map((m) => [m.id, m.displayName]));
  private info = (m: Member): ParticipantInfo => ({
    participantId: m.id, displayName: m.displayName, kind: m.kind, ...(m.vendor && { vendor: m.vendor }),
    ...(m.kind === 'agent' && { deliveryMode: 'pull' as const }), lastSeen: m.lastSeen, left: m.left,
  });
  private infos = (r: Room) => [...r.members.values()].map(this.info);
  private emit(r: Room, e: RoomEvent) {
    for (const fn of [...r.listeners]) {
      try { fn(e); } catch { /* a broken listener must not break the room */ }
    }
  }
  private revoke(m: Member) {
    if (m.tokenHash) this.tokens.delete(m.tokenHash);
  }
  private depart(r: Room, m: Member) {
    m.left = true;
    this.revoke(m);
    this.emit(r, { type: 'participants', participants: this.infos(r) });
  }
  private newMember(r: Room, kind: 'agent' | 'human', displayName: string, ownerId: string, vendor?: Vendor): Member {
    const active = [...r.members.values()].filter((m) => !m.left && m.kind === kind).length;
    if (r.members.size >= MAX_MEMBERS || active >= (kind === 'agent' ? this.o.maxAgents : this.o.maxHumans)) throw new StoreError('room_full', `room is full (max ${kind === 'agent' ? this.o.maxAgents : this.o.maxHumans} ${kind}s)`);
    const m: Member = { id: 'p_' + this.hex(6), ownerId, displayName, kind, vendor, cursor: r.seq, joinSeq: r.seq, left: false, conns: 0, lastSeen: null, sent: new Map(), waits: new Set(), deliveredAt: -Infinity, dayStart: -Infinity, dayCount: 0 };
    r.members.set(m.id, m);
    return m;
  }
  private clamp(r: Room, m: Member, since: number | undefined) {
    // never below the join point, never above the last seq: a hallucinated future value must not move the cursor ahead
    return Math.min(Math.max(since ?? m.cursor, m.joinSeq), r.seq);
  }
  private pending(r: Room, m: Member, since: number) {
    return r.ring.filter((x) => x.seq > since && x.from.participantId !== m.id);
  }
  /** Inbound delivery policy for agents: a pending mention always passes; otherwise the batch is held (hold = ms until it may pass) during the
   *  cooldown after the last batch, or once the daily cap is spent. Held messages stay pending, the cursor is untouched. Humans are never held. */
  private gate(m: Member, cand: StoredMessage[]): { cand: StoredMessage[]; hold: number } {
    if (m.kind === 'human' || !cand.length || cand.some((x) => x.mentions.includes(m.id))) return { cand, hold: 0 };
    const t = this.now();
    if (t - m.dayStart >= DAY_MS) { m.dayStart = t; m.dayCount = 0; } // fixed window, restarts on the first delivery decision after it ends
    if (this.o.deliveriesPerDay > 0 && m.dayCount >= this.o.deliveriesPerDay) return { cand: [], hold: m.dayStart + DAY_MS - t };
    const hold = m.deliveredAt + this.o.deliveryCooldownMs - t;
    return hold > 0 ? { cand: [], hold } : { cand, hold: 0 };
  }
  private shutdown(r: Room, reason: string) {
    this.emit(r, { type: 'closed', reason });
    for (const m of r.members.values()) { m.left = true; this.revoke(m); }
    r.listeners.clear();
    this.totalBytes -= r.bytes;
    r.bytes = 0;
    r.ring = [];
  }

  async createRoom(topic: string): Promise<CreateRoomResponse> {
    if (this.rooms.size >= this.o.maxRooms) throw new StoreError('rate_limited', 'server is at capacity, try again later');
    let id = this.hex(6);
    while (this.rooms.has(id)) id = this.hex(6);
    const secrets = { invite: this.hex(16), view: this.hex(16), admin: this.hex(16) };
    const expiresAt = this.now() + this.o.ttlMs; // hard cap (ttlMs <= 1 h), never refreshed
    this.rooms.set(id, {
      id, topic: sanitizeText(topic), secrets, adminOwnerId: 'o_' + this.hex(8), expiresAt, seq: 0, ring: [], bytes: 0, members: new Map(), paused: false, closed: false,
      closingSent: false, listeners: new Set(), limiter: new SlidingWindow(this.o.messagesPerMinute, 60_000, this.now),
    });
    return { roomId: id, inviteSecret: secrets.invite, adminSecret: secrets.admin, viewSecret: secrets.view, expiresAt };
  }

  async getRoom(roomId: string): Promise<RoomPublicInfo | undefined> {
    const r = this.live(roomId);
    return r && { roomId: r.id, topic: r.topic, expiresAt: r.expiresAt, participants: this.infos(r), paused: r.paused, closed: r.closed };
  }

  async checkSecret(roomId: string, role: Role, secret: string) {
    const r = this.live(roomId);
    return !!r && sameSecret(r.secrets[role], secret);
  }

  async join(roomId: string, req: { displayName: string; vendor: Vendor }): Promise<JoinResult> {
    const r = this.open(roomId);
    const name = sanitizeIdent(req.displayName, LIMITS.displayNameChars);
    if (!name) throw new StoreError('bad_request', 'displayName has no usable characters');
    if (isReservedName(name)) throw new StoreError('reserved_name', 'that display name is reserved');
    const key = skeleton(name);
    if ([...r.members.values()].some((m) => skeleton(m.displayName) === key)) throw new StoreError('name_taken', 'that display name is already used in this room');
    const m = this.newMember(r, 'agent', name, 'o_' + this.hex(8), req.vendor); // every join is its own owner in phase 1a
    const token = Buffer.from(this.rng(32)).toString('base64url');
    m.tokenHash = sha(token).toString('hex');
    this.tokens.set(m.tokenHash, { roomId, participantId: m.id });
    this.emit(r, { type: 'participants', participants: this.infos(r) });
    return { roomId, participantId: m.id, ownerId: m.ownerId, displayName: name, token, vendor: req.vendor, cursorStartsAt: m.joinSeq };
  }

  async joinHuman(roomId: string): Promise<Identity> {
    const r = this.open(roomId);
    // One stable human per room admin owner: tabs and reconnects share it (reference-counted), so reloads never grow the member map.
    let m = [...r.members.values()].find((x) => x.kind === 'human' && x.ownerId === r.adminOwnerId);
    const revived = !m || m.left;
    if (!m) {
      let name = 'host', n = 1; // server-chosen; an agent may already have taken 'host'
      while ([...r.members.values()].some((x) => skeleton(x.displayName) === name)) name = `host-${++n}`;
      m = this.newMember(r, 'human', name, r.adminOwnerId);
    }
    m.left = false;
    m.conns++;
    if (revived) this.emit(r, { type: 'participants', participants: this.infos(r) });
    return { roomId, participantId: m.id, ownerId: m.ownerId, displayName: m.displayName };
  }

  async authToken(token: string): Promise<Identity | undefined> {
    const hit = this.tokens.get(sha(token).toString('hex'));
    const r = hit && this.live(hit.roomId);
    const m = r && !r.closed ? r.members.get(hit.participantId) : undefined;
    if (!r || !m || m.left) return undefined;
    m.lastSeen = this.now();
    return { roomId: r.id, participantId: m.id, ownerId: m.ownerId, displayName: m.displayName };
  }

  async send(roomId: string, participantId: string, input: { content: string; replyTo?: string; clientMsgId?: string }) {
    // the one choke point: no caller (MCP, WS, future REST) can skip the secret scan
    const kinds = detectSecrets(input.content);
    if (kinds.length) throw new StoreError('secret_detected', `not sent, the message looks like it contains a secret (${kinds.join(', ')}). Remove it and send again.`);
    const r = this.open(roomId);
    if (r.paused) throw new StoreError('room_paused', 'room is paused by the admin');
    const m = r.members.get(participantId);
    if (!m || m.left) throw new StoreError('bad_request', 'not a participant of this room');
    const dup = input.clientMsgId ? m.sent.get(input.clientMsgId) : undefined;
    if (dup) return { ...dup, duplicate: true }; // retries do not consume the rate budget
    const content = sanitizeText(input.content, true);
    if (!content) throw new StoreError('bad_request', 'message is empty');
    if (!r.limiter.hit('room')) throw new StoreError('rate_limited', `room message limit reached (${this.o.messagesPerMinute} per minute)`);
    const size = Buffer.byteLength(content) + MSG_OVERHEAD;
    if (this.totalBytes + size > this.o.maxTotalBytes) throw new StoreError('rate_limited', 'server memory budget reached, messages are rejected until rooms expire');
    const mentions = [...new Set([...content.matchAll(/@([\p{L}\p{N}_.-]+)/gu)].flatMap((x) => {
      const k = skeleton((x[1] ?? '').replace(/[.-]+$/, ''));
      const hit = [...r.members.values()].find((q) => !q.left && skeleton(q.displayName) === k);
      return hit ? [hit.id] : [];
    }))];
    const replyTo = input.replyTo ? sanitizeIdent(input.replyTo, 64) : '';
    const message: StoredMessage = {
      roomId, seq: ++r.seq, id: this.now().toString(36).padStart(9, '0') + this.hex(5), ts: this.now(),
      from: { kind: m.kind, participantId: m.id, ownerId: m.ownerId, displayName: m.displayName, ...(m.vendor && { vendor: m.vendor }) },
      content, mentions, ...(replyTo && { replyTo }), hops: 0,
    };
    r.ring.push(message);
    r.bytes += size;
    this.totalBytes += size;
    while (r.ring.length > 1 && (r.ring.length > this.o.ringSize || r.bytes > this.o.ringBytes)) {
      const old = cost(r.ring.shift()!);
      r.bytes -= old;
      this.totalBytes -= old;
    }
    if (input.clientMsgId) {
      m.sent.set(input.clientMsgId, { seq: message.seq, id: message.id });
      if (m.sent.size > CLIENT_MSG_IDS) m.sent.delete(m.sent.keys().next().value as string);
    }
    m.lastSeen = this.now();
    this.emit(r, { type: 'message', message, names: this.names(r) });
    return { seq: message.seq, id: message.id, duplicate: false };
  }

  async inbox(roomId: string, participantId: string, o: { sinceSeq?: number; limit: number; maxBytes: number; signal?: AbortSignal }) {
    if (o.signal?.aborted) return undefined;
    const r = this.open(roomId);
    const m = r.members.get(participantId);
    if (!m || m.left) throw new StoreError('bad_request', 'not a participant of this room');
    const since = this.clamp(r, m, o.sinceSeq);
    const all = this.pending(r, m, since);
    const cand = this.gate(m, all).cand;
    if (all.length && !cand.length) return { messages: [], hasMore: false, lastSeq: since, names: this.names(r) }; // held: nothing lost, cursor stays
    const messages: StoredMessage[] = [];
    let bytes = 0;
    for (const x of cand) {
      bytes += Buffer.byteLength(x.content ?? '');
      if (messages.length >= o.limit || (messages.length && bytes > o.maxBytes)) break;
      messages.push(x);
    }
    const hasMore = messages.length < cand.length;
    const lastSeq = hasMore ? messages.at(-1)!.seq : r.seq; // own messages in the range are skipped, not pending
    m.cursor = Math.max(m.cursor, lastSeq);
    m.lastSeen = this.now();
    if (messages.length) { m.deliveredAt = this.now(); m.dayCount += messages.length; }
    if (messages.length) this.emit(r, { type: 'receipt', participantId, seqs: messages.map((x) => x.seq), at: this.now() });
    return { messages, hasMore, lastSeq, names: this.names(r) };
  }

  waitForMessages(roomId: string, participantId: string, o: { sinceSeq?: number; waitMs: number; signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve) => {
      const r = this.live(roomId);
      const m = r?.members.get(participantId);
      if (!r || !m) return resolve();
      const ready = () => r.closed || m.left || this.gate(m, this.pending(r, m, this.clamp(r, m, o.sinceSeq))).cand.length > 0;
      if (ready() || o.waitMs <= 0 || o.signal?.aborted) return resolve();
      const done = () => { m.waits.delete(done); clearTimeout(timer); clearTimeout(wake); r.listeners.delete(onEvent); o.signal?.removeEventListener('abort', done); resolve(); };
      let wake: NodeJS.Timeout | undefined;
      const check = () => { // wake exactly when the hold ends instead of at the poll timeout
        clearTimeout(wake);
        if (ready()) return done();
        const hold = this.gate(m, this.pending(r, m, this.clamp(r, m, o.sinceSeq))).hold;
        if (hold > 0) wake = setTimeout(check, hold);
      };
      const onEvent = check;
      const timer = setTimeout(done, o.waitMs);
      r.listeners.add(onEvent);
      // cap: a new wait resolves the oldest one early (it returns with whatever is pending, normally nothing)
      while (m.waits.size >= this.o.maxWaitsPerParticipant) m.waits.values().next().value!();
      m.waits.add(done);
      check();
      o.signal?.addEventListener('abort', done, { once: true });
    });
  }

  async list(roomId: string, q: { after?: number; before?: number; participantId?: string; limit: number; maxBytes?: number }): Promise<Page> {
    const r = this.live(roomId);
    if (!r) throw new StoreError('room_not_found', 'room not found');
    const lo = Math.max(q.after ?? 0, q.participantId ? (r.members.get(q.participantId)?.joinSeq ?? 0) : 0), hi = q.before ?? Infinity;
    const pool = r.ring.filter((x) => x.seq > lo && x.seq < hi);
    const forward = q.after !== undefined;
    const taken: StoredMessage[] = [];
    let bytes = 0;
    for (const x of forward ? pool : [...pool].reverse()) {
      bytes += Buffer.byteLength(x.content ?? '');
      if (taken.length >= q.limit || (taken.length && q.maxBytes !== undefined && bytes > q.maxBytes)) break;
      taken.push(x);
    }
    if (!forward) taken.reverse();
    return { messages: taken, hasMore: taken.length < pool.length, lastSeq: r.seq, names: this.names(r), adminOwnerId: r.adminOwnerId };
  }

  async participants(roomId: string) {
    return this.infos(this.open(roomId));
  }

  async leave(roomId: string, participantId: string) {
    const r = this.live(roomId);
    const m = r?.members.get(participantId);
    if (!r || !m || m.left) return;
    if (m.kind === 'human' && --m.conns > 0) return; // other admin tabs still connected
    m.conns = 0;
    this.depart(r, m);
  }

  async admin(roomId: string, a: AdminAction) {
    const r = this.open(roomId);
    if (a.action === 'approve') return; // joins are open in phase 1a
    if (a.action === 'pause') {
      if (r.paused !== a.paused) { r.paused = a.paused; this.emit(r, { type: 'paused', paused: a.paused }); }
    } else if (a.action === 'kick') {
      const m = r.members.get(a.participantId);
      if (!m || m.left) throw new StoreError('bad_request', 'unknown participant');
      if (m.ownerId === r.adminOwnerId) throw new StoreError('forbidden_role', 'the room admin cannot be kicked'); // would lock the admin out of their own room
      this.emit(r, { type: 'kicked', participantId: m.id });
      m.conns = 0;
      this.depart(r, m);
    } else {
      r.closed = true; // the shell stays until expiry so GET reports closed:true; content, tokens and sockets are gone
      this.shutdown(r, 'closed by the room admin');
    }
  }

  async issueTicket(roomId: string, role: 'admin' | 'viewer', ip = '') {
    this.open(roomId);
    if (this.tickets.size >= MAX_TICKETS || (this.ticketsByRoom.get(roomId) ?? 0) >= this.o.maxTicketsPerRoom || (ip && (this.ticketsByIp.get(ip) ?? 0) >= this.o.maxTicketsPerIp)) {
      throw new StoreError('rate_limited', 'too many pending tickets, try again in a moment');
    }
    const ticket = this.hex(16);
    this.tickets.set(ticket, { roomId, role, ip, exp: this.now() + TICKET_TTL_S * 1000 });
    this.ticketsByRoom.set(roomId, (this.ticketsByRoom.get(roomId) ?? 0) + 1);
    if (ip) this.ticketsByIp.set(ip, (this.ticketsByIp.get(ip) ?? 0) + 1);
    return { ticket, role, expiresInSeconds: TICKET_TTL_S };
  }

  private dropTicket(ticket: string) {
    const t = this.tickets.get(ticket);
    if (!t) return;
    this.tickets.delete(ticket);
    for (const [map, key] of [[this.ticketsByRoom, t.roomId], [this.ticketsByIp, t.ip]] as const) {
      const n = (map.get(key) ?? 1) - 1;
      if (n > 0) map.set(key, n); else map.delete(key);
    }
  }

  async redeemTicket(ticket: string) {
    const t = this.tickets.get(ticket);
    this.dropTicket(ticket); // one use, even if expired
    return t && t.exp > this.now() && this.live(t.roomId) && !this.rooms.get(t.roomId)!.closed ? { roomId: t.roomId, role: t.role } : undefined;
  }

  subscribe(roomId: string, fn: (e: RoomEvent) => void) {
    const r = this.live(roomId);
    r?.listeners.add(fn);
    return () => void r?.listeners.delete(fn);
  }

  async sweep() {
    const t = this.now();
    for (const [id, r] of this.rooms) {
      if (t >= r.expiresAt) {
        if (!r.closed) { r.closed = true; this.shutdown(r, 'expired'); } // closed first: waiting long-polls wake at once
        this.rooms.delete(id);
      } else if (!r.closed && !r.closingSent && t >= r.expiresAt - CLOSING_WARNING_MS) {
        r.closingSent = true;
        this.emit(r, { type: 'closing', expiresAt: r.expiresAt });
      }
    }
    for (const [k, v] of this.tickets) if (v.exp <= t) this.dropTicket(k);
  }
}
