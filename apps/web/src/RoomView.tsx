// Transcript + participants. Admin controls and the message box exist only when `admin` is passed (viewer pages never pass it).
import { useState } from 'react';
import { Banner, Countdown, PermanentBadge, CopyButton, Participants, Transcript, btn, btnPrimary, clean, input } from './components';
import type { AdminActionInput } from './api';
import type { RoomState } from './roomState';
import type { SocketStatus } from './useRoomSocket';

export type AdminProps = {
  inviteLink: string;
  viewLink: string;
  onAction: (a: AdminActionInput) => void;
  onSend: (content: string) => boolean;
  ready: boolean; // server init received: sending earlier would be dropped
  actionError?: string;
};

export function RoomView({ state, status, admin }: { state: RoomState; status: SocketStatus; admin?: AdminProps }) {
  const [draft, setDraft] = useState('');
  const confirmDo = (msg: string, a: AdminActionInput) => {
    if (window.confirm(msg)) admin?.onAction(a);
  };
  return (
    <div className="space-y-4">
      <Banner state={state} />
      {state.error && (
        <div role="alert" className="rounded border border-red-700 bg-red-50 px-3 py-2 text-red-900">
          {clean(state.error.message)} ({state.error.code})
        </div>
      )}
      <p className="text-slate-800">
        Topic: <strong>{clean(state.topic) || '(none)'}</strong>
      </p>
      <p className="text-sm text-slate-700">
        {state.expiresAt === null ? <PermanentBadge /> : <Countdown expiresAt={state.expiresAt} />} | connection: {status}
      </p>

      {admin && (
        <section aria-label="Admin controls" className="space-y-2 rounded border border-slate-300 p-3">
          <div className="flex flex-wrap gap-2">
            <CopyButton text={admin.inviteLink} label="Copy invite link" />
            <CopyButton text={admin.viewLink} label="Copy read-only view link" />
            <button
              type="button"
              className={btn}
              disabled={state.closed}
              onClick={() => confirmDo(state.paused ? 'Resume the room?' : 'Pause the room?', { action: 'pause', paused: !state.paused })}
            >
              {state.paused ? 'Resume room' : 'Pause room'}
            </button>
            <button
              type="button"
              className={btn}
              disabled={state.closed}
              onClick={() => confirmDo('Close the room for everyone? This cannot be undone.', { action: 'close' })}
            >
              Close room
            </button>
          </div>
          <p className="text-xs text-slate-600">
            The invite link lets anyone join with an agent. The view link is read-only. Share them only with people you trust.
          </p>
          {admin.actionError && (
            <p role="alert" className="text-red-800">
              {admin.actionError}
            </p>
          )}
        </section>
      )}

      <section aria-label="People">
        <h2 className="font-semibold">Participants</h2>
        <Participants participants={state.participants}>
          {admin &&
            ((p) =>
              p.kind === 'human' ? null : ( // the admin is a human participant: never offer kicking humans

              <button
                type="button"
                className={btn}
                aria-label={`Kick ${clean(p.displayName)}`}
                disabled={state.closed}
                onClick={() => confirmDo(`Kick ${clean(p.displayName)}?`, { action: 'kick', participantId: p.participantId })}
              >
                Kick
              </button>
              ))}
        </Participants>
      </section>

      <section aria-label="Messages">
        <h2 className="font-semibold">Transcript</h2>
        <Transcript state={state} onErase={admin && ((seq) => confirmDo(`Erase message ${seq} for everyone? The content is removed for good.`, { action: 'erase', seq }))} />
        {admin && <p className="text-xs text-slate-600">Erasing keeps a [deleted] placeholder. Other open tabs show it after a reload.</p>}
      </section>

      {admin && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (t && admin.onSend(t)) setDraft('');
          }}
        >
          <label className="flex-1">
            <span className="sr-only">Message as human</span>
            <input
              className={input}
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message as human"
              disabled={state.closed || state.paused || !admin.ready}
            />
          </label>
          <button type="submit" className={btnPrimary} disabled={state.closed || state.paused || !admin.ready}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
