// RoomStore: the one allowed abstraction (MemoryStore now, PostgresStore in phase 2). Anonymous rooms live in memory only:
// nothing in this file touches the disk.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type AdminAction, type CreateRoomResponse, type ParticipantInfo, type RoomPublicInfo, type Rng, type StoredMessage, type Vendor,
  LIMITS, isReservedName, sanitizeIdent, sanitizeText, skeleton,
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
  issueTicket(roomId: string, role: 'admin' | 'viewer'): Promise<{ ticket: string; role: 'admin' | 'viewer'; expiresInSeconds: number }>;
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
};

type Member = {
  id: string; ownerId: string; displayName: string; kind: 'agent' | 'human'; vendor?: Vendor; tokenHash?: string;
  cursor: number; joinSeq: number; left: boolean; conns: number; lastSeen: number | null; sent: Map<string, { seq: number; id: string }>;
};
type Room = {
  id: string; topic: string; secrets: Record<Role, string>; adminOwnerId: string; expiresAt: number; seq: number; ring: StoredMessage[];
  members: Map<string, Member>; paused: boolean; closed: boolean; closingSent: boolean; listeners: Set<(e: RoomEvent) => void>; limiter: SlidingWindow;
};

const CLIENT_MSG_IDS = 100; // remembered per participant
const TICKET_TTL_S = 30;
const CLOSING_WARNING_MS = 60_000;
// Memory bound on the member map. Departed AGENTS stay in the map on purpose (anti-impersonation: a left agent's name cannot be reused in this room),
// so a room that churns through 200 distinct agent names is full. The admin human is one stable member, so reconnects never grow the map.
const MAX_MEMBERS = 200;
const MAX_TICKETS = 10_000;

const sha = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));
const defaultRng: Rng = (n) => crypto.getRandomValues(new Uint8Array(n));

export class MemoryStore implements RoomStore {
  private rooms = new Map<string, Room>();
  private tokens = new Map<string, { roomId: string; participantId: string }>(); // sha256(token) hex -> owner
  private tickets = new Map<string, { roomId: string; role: 'admin' | 'viewer'; exp: number }>();
  private now: () => number;
  private rng: Rng;
  private o: Required<Omit<MemoryStoreOptions, 'now' | 'rng'>>;

  constructor(o: MemoryStoreOptions = {}) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? defaultRng;
    this.o = {
      maxRooms: o.maxRooms ?? 1000, maxAgents: o.maxAgents ?? LIMITS.agentsPerRoom, maxHumans: o.maxHumans ?? LIMITS.humansPerRoom,
      ringSize: o.ringSize ?? LIMITS.ringSize, messagesPerMinute: o.messagesPerMinute ?? LIMITS.messagesPerMinutePerRoom,
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
    const m: Member = { id: 'p_' + this.hex(6), ownerId, displayName, kind, vendor, cursor: r.seq, joinSeq: r.seq, left: false, conns: 0, lastSeen: null, sent: new Map() };
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
  private shutdown(r: Room, reason: string) {
    this.emit(r, { type: 'closed', reason });
    for (const m of r.members.values()) { m.left = true; this.revoke(m); }
    r.listeners.clear();
    r.ring = [];
  }

  async createRoom(topic: string): Promise<CreateRoomResponse> {
    if (this.rooms.size >= this.o.maxRooms) throw new StoreError('rate_limited', 'server is at capacity, try again later');
    let id = this.hex(6);
    while (this.rooms.has(id)) id = this.hex(6);
    const secrets = { invite: this.hex(16), view: this.hex(16), admin: this.hex(16) };
    const expiresAt = this.now() + LIMITS.roomTtlMs; // hard cap, never refreshed
    this.rooms.set(id, {
      id, topic: sanitizeText(topic), secrets, adminOwnerId: 'o_' + this.hex(8), expiresAt, seq: 0, ring: [], members: new Map(), paused: false, closed: false,
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
    const r = this.open(roomId);
    if (r.paused) throw new StoreError('room_paused', 'room is paused by the admin');
    const m = r.members.get(participantId);
    if (!m || m.left) throw new StoreError('bad_request', 'not a participant of this room');
    const dup = input.clientMsgId ? m.sent.get(input.clientMsgId) : undefined;
    if (dup) return { ...dup, duplicate: true }; // retries do not consume the rate budget
    const content = sanitizeText(input.content, true);
    if (!content) throw new StoreError('bad_request', 'message is empty');
    if (!r.limiter.hit('room')) throw new StoreError('rate_limited', `room message limit reached (${this.o.messagesPerMinute} per minute)`);
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
    if (r.ring.length > this.o.ringSize) r.ring.shift();
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
    const cand = this.pending(r, m, this.clamp(r, m, o.sinceSeq));
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
    if (messages.length) this.emit(r, { type: 'receipt', participantId, seqs: messages.map((x) => x.seq), at: this.now() });
    return { messages, hasMore, lastSeq, names: this.names(r) };
  }

  waitForMessages(roomId: string, participantId: string, o: { sinceSeq?: number; waitMs: number; signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve) => {
      const r = this.live(roomId);
      const m = r?.members.get(participantId);
      if (!r || !m) return resolve();
      const ready = () => r.closed || m.left || this.pending(r, m, this.clamp(r, m, o.sinceSeq)).length > 0;
      if (ready() || o.waitMs <= 0 || o.signal?.aborted) return resolve();
      const done = () => { clearTimeout(timer); r.listeners.delete(onEvent); o.signal?.removeEventListener('abort', done); resolve(); };
      const onEvent = () => { if (ready()) done(); };
      const timer = setTimeout(done, o.waitMs);
      r.listeners.add(onEvent);
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

  async issueTicket(roomId: string, role: 'admin' | 'viewer') {
    this.open(roomId);
    if (this.tickets.size >= MAX_TICKETS) throw new StoreError('rate_limited', 'too many pending tickets');
    const ticket = this.hex(16);
    this.tickets.set(ticket, { roomId, role, exp: this.now() + TICKET_TTL_S * 1000 });
    return { ticket, role, expiresInSeconds: TICKET_TTL_S };
  }

  async redeemTicket(ticket: string) {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket); // one use, even if expired
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
    for (const [k, v] of this.tickets) if (v.exp <= t) this.tickets.delete(k);
  }
}
