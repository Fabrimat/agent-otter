// Shared UI. All server-provided strings render as React text only (no HTML, no auto-linking).
import { useEffect, useState, type ReactNode } from 'react';
import { sanitizeText, type DeliveredMessage, type ParticipantInfo } from '@agent-office/protocol';
import type { RoomState } from './roomState';

/** Defence in depth: the server already strips invisible/bidi characters; we do it again before display. */
export const clean = (s: string) => sanitizeText(s, true);
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const btn = 'rounded border border-slate-400 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50';
export const btnPrimary = 'rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-900 disabled:opacity-50';
export const input = 'w-full rounded border border-slate-400 px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setFailed(false);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button type="button" className={btn} onClick={() => void copy()}>
        {done ? 'Copied' : label}
      </button>
      {failed && (
        <span role="alert" className="block text-sm text-red-800">
          Copy failed, select the text manually
          <input readOnly aria-label="Text to copy" className={input} value={text} ref={(el) => el?.select()} onFocus={(e) => e.currentTarget.select()} />
        </span>
      )}
    </>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatRemaining(ms: number) {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function Countdown({ expiresAt }: { expiresAt: number }) {
  const now = useNow();
  return <span data-testid="countdown">Expires in {formatRemaining(expiresAt - now)}</span>;
}

export function Banner({ state }: { state: Pick<RoomState, 'paused' | 'closing' | 'closed' | 'closedReason'> }) {
  const text = state.closed ? `This room is closed${state.closedReason ? `: ${clean(state.closedReason)}` : ''}.` : state.closing ? 'This room is closing soon.' : state.paused ? 'This room is paused. Messages are not delivered until it resumes.' : null;
  return text ? <div role="status" className="rounded border border-amber-600 bg-amber-100 px-3 py-2 text-amber-900">{text}</div> : null;
}

export function SafetyNotice() {
  return (
    <div role="note" className="rounded border-2 border-red-700 bg-red-50 p-3 text-red-900">
      <strong>Safety.</strong> Never join a room with strangers while your agent runs in a permission-bypass mode (for example
      <code> --dangerously-skip-permissions</code>). Room messages reach your agent as text only, but an injected message can still steer
      it, and your agent may leak anything it can read and is allowed to post. Keep your host&apos;s approval prompts on.{' '}
      <a className="underline" href="/safety" target="_blank" rel="noopener noreferrer">Read the safety page</a>.
    </div>
  );
}

export function Transcript({ state }: { state: RoomState }) {
  const names = new Map(state.participants.map((p) => [p.participantId, p.displayName]));
  return (
    <ol aria-live="polite" aria-label="Transcript" className="space-y-2">
      {state.messages.length === 0 && <li className="text-slate-600">No messages yet.</li>}
      {state.messages.map((m) => (
        <MessageRow key={m.seq} m={m} seen={Object.entries(state.receipts[m.seq] ?? {}).map(([pid, at]) => ({ name: names.get(pid) ?? 'participant', at }))} />
      ))}
    </ol>
  );
}

// Human vs agent is decided by the server-provided `kind` only; vendor is shown as self-declared.
const KIND_STYLE = { human: 'border-green-700 bg-green-50', agent: 'border-slate-400 bg-white', system: 'border-slate-300 bg-slate-100 italic' } as const;

function MessageRow({ m, seen }: { m: DeliveredMessage; seen: { name: string; at: number }[] }) {
  const { kind, displayName, vendor } = m.from;
  return (
    <li className={`rounded border-l-4 p-2 ${KIND_STYLE[kind]}`} data-kind={kind}>
      <div className="text-xs text-slate-700">
        <span className="font-semibold">{clean(displayName)}</span>{' '}
        <span className="rounded bg-slate-200 px-1">{kind === 'human' ? 'human' : kind === 'system' ? 'system' : 'agent'}</span>
        {vendor && <span> (declared: {clean(vendor)})</span>} <time>{hhmm(m.ts)}</time>
      </div>
      <div className="whitespace-pre-wrap break-words">{m.content === null || m.deletedAt !== undefined ? '[deleted]' : clean(m.content)}</div>
      {seen.length > 0 && (
        <div className="text-xs text-slate-600">{seen.map((s) => `seen by ${clean(s.name)} at ${hhmm(s.at)}`).join(', ')}</div>
      )}
    </li>
  );
}

export function Participants({ participants, children }: { participants: ParticipantInfo[]; children?: (p: ParticipantInfo) => ReactNode }) {
  return (
    <ul aria-label="Participants" className="space-y-1">
      {participants.length === 0 && <li className="text-slate-600">Nobody has joined yet.</li>}
      {participants.map((p) => (
        <li key={p.participantId} className="flex items-center justify-between gap-2">
          <span className={p.left ? 'text-slate-500 line-through' : ''}>
            {clean(p.displayName)} <span className="text-xs text-slate-600">{p.kind}{p.vendor ? ` (declared: ${clean(p.vendor)})` : ''}{p.deliveryMode ? `, ${p.deliveryMode}` : ''}
            {p.lastSeen ? `, last seen ${hhmm(p.lastSeen)}` : ''}</span>
          </span>
          {!p.left && children?.(p)}
        </li>
      ))}
    </ul>
  );
}

export const Page = ({ title, children }: { title: string; children: ReactNode }) => (
  <main className="mx-auto max-w-3xl space-y-4 p-4">
    <h1 className="text-2xl font-bold"><a href="/">Agent Office</a> <span className="text-lg font-normal text-slate-600">{title}</span></h1>
    {children}
  </main>
);
