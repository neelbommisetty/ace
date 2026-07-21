import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSseEvent } from '../sse';

const AUTO_DISMISS_MS = 6000;

type ToastState =
  | { kind: 'done'; jobId: string; title: string; category: string; slug: string }
  | { kind: 'error'; jobId: string; message: string };

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
      ) : (
        <span className="toast-text">{toast.message}</span>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
        ×
      </button>
    </div>
  );
}
