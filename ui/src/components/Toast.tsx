import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useSseEvent } from '../sse';

const AUTO_DISMISS_MS = 6000;

type ToastState =
  | { kind: 'done'; jobId: string; title: string; category: string; slug: string }
  | { kind: 'error'; jobId: string; message: string }
  | { kind: 'action'; message: string; actionLabel: string; onAction: () => void };

/**
 * Module-singleton trigger for a generic "message + one action" toast (NEE-296
 * uses it for archive's undo) — same cross-component pattern as
 * lib/switchSignal.ts: the Library row action can't reach Toast's state
 * directly since Toast is mounted once at App level.
 */
let showActionToastFn: ((message: string, actionLabel: string, onAction: () => void) => void) | null =
  null;

export function showActionToast(message: string, actionLabel: string, onAction: () => void): void {
  showActionToastFn?.(message, actionLabel, onAction);
}

/**
 * App-level toast for generation completion/failure. Rendered once inside
 * BrowserRouter (so the "Open room" Link works) and listens globally —
 * suppressed on /new since GenerationJobStrip there already surfaces the
 * same information inline.
 */
export function Toast() {
  const location = useLocation();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<number | null>(null);

  function show(next: ToastState) {
    setToast(next);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setToast(null), AUTO_DISMISS_MS);
  }

  useSseEvent('generation-done', ({ jobId, question }) => {
    show({ kind: 'done', jobId, title: question.title, category: question.category, slug: question.slug });
  });

  useSseEvent('generation-error', ({ jobId, message }) => {
    show({ kind: 'error', jobId, message });
  });

  useEffect(() => {
    const fn = (message: string, actionLabel: string, onAction: () => void) =>
      show({ kind: 'action', message, actionLabel, onAction });
    showActionToastFn = fn;
    return () => {
      if (showActionToastFn === fn) showActionToastFn = null;
    };
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  if (toast == null || location.pathname === '/new') return null;

  return (
    <div className="toast" role="status">
      {toast.kind === 'done' ? (
        <>
          <span className="toast-text">&quot;{toast.title}&quot; is ready</span>
          <Link className="toast-action" to={`/q/${toast.category}/${toast.slug}`} onClick={() => setToast(null)}>
            Open room
          </Link>
        </>
      ) : toast.kind === 'action' ? (
        <>
          <span className="toast-text">{toast.message}</span>
          <button
            className="toast-action"
            onClick={() => {
              toast.onAction();
              setToast(null);
            }}
          >
            {toast.actionLabel}
          </button>
        </>
      ) : (
        <span className="toast-text">{toast.message}</span>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
        ×
      </button>
    </div>
  );
}
