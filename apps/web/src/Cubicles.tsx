// Read-only cubicles panel (docs/CUBICLES-DESIGN.md C2). Content is untrusted: plain text nodes only, no HTML, no markdown, no link detection.
import { useEffect, useState } from 'react';
import type { CubicleResponse, CubicleSummary } from '@lesscubicles/protocol';
import { ApiError, api, type Secret } from './api';
import { btn, clean } from './components';

type EraseTarget = { participantId: string; page?: string };

/** `tick` changes on every (re)connect and cubicle event: the list (and the open viewer) is refetched then. */
export function Cubicles({ roomId, secret, tick, onErase }: { roomId: string; secret: Secret; tick: number; onErase?: (t: EraseTarget, label: string) => void }) {
  const [list, setList] = useState<CubicleSummary[]>([]);
  const [open, setOpen] = useState<string>();
  const [view, setView] = useState<CubicleResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!roomId) return; // before the first init
    let live = true;
    const fail = (e: unknown) => live && (setView(undefined), setError(e instanceof ApiError ? e.message : 'could not load cubicles'));
    api.cubicles(roomId, secret).then((r) => live && (setList(r.cubicles), setError(undefined)), fail);
    if (open) api.cubicle(roomId, open, secret).then((r) => live && setView(r), fail);
    return () => { live = false; };
  }, [roomId, secret.kind, secret.value, tick, open]);
  return (
    <section aria-label="Cubicles" className="space-y-2">
      <h2 className="font-semibold">Cubicles</h2>
      {error && <p role="alert" className="text-red-800">{clean(error)}</p>}
      <ul aria-label="Cubicle list" className="space-y-1">
        {list.length === 0 && <li className="text-slate-600">No cubicles yet.</li>}
        {list.map((c) => (
          <li key={c.participantId} className="flex flex-wrap items-center gap-2">
            <span>
              {clean(c.displayName)} <span className="text-xs text-slate-600">{c.pageCount} page(s), {c.visibility === 'owner' ? 'owner only' : 'room'}{c.left ? ', left' : ''}</span>
            </span>
            {c.readable ? (
              <button type="button" className={btn} aria-label={`Open cubicle of ${clean(c.displayName)}`} onClick={() => { setView(undefined); setOpen(c.participantId); }}>Open</button>
            ) : (
              <span className="text-xs text-slate-600">private</span>
            )}
            {onErase && <button type="button" className={btn} aria-label={`Erase cubicle of ${clean(c.displayName)}`} onClick={() => onErase({ participantId: c.participantId }, `the cubicle of ${clean(c.displayName)}`)}>Erase</button>}
          </li>
        ))}
      </ul>
      {open && view && view.participantId === open && (
        <div aria-label={`Cubicle of ${clean(view.displayName)}`} className="space-y-2 rounded border border-slate-300 p-2">
          {view.pages.length === 0 && <p className="text-slate-600">Empty.</p>}
          {view.pages.map((p) => (
            <div key={p.name}>
              <h3 className="text-sm font-semibold">{clean(p.name)} <span className="font-normal text-slate-600">rev {p.rev}</span></h3>
              <pre className="whitespace-pre-wrap break-words rounded bg-slate-100 p-2 text-sm">{clean(p.content)}</pre>
              {onErase && <button type="button" className={btn} aria-label={`Erase page ${clean(p.name)}`} onClick={() => onErase({ participantId: view.participantId, page: p.name }, `page ${clean(p.name)} of ${clean(view.displayName)}`)}>Erase page</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
