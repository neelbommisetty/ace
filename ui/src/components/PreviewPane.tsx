import { useCallback, useRef, useState } from 'react';
import type { PreviewStatus } from '../types';

export type PreviewViewport = 'mobile' | 'tablet' | 'full';

/** Emulated content width for each viewport toggle — component questions are
 * frequently about responsive behaviour, so a narrow room needs a way to
 * preview at mobile/tablet widths without resizing the whole browser. */
const VIEWPORT_WIDTH: Record<PreviewViewport, number | null> = {
  mobile: 390,
  tablet: 834,
  full: null,
};

/**
 * Mirrors `previewPagePath` in cli/server/preview-harness.ts byte-for-byte.
 * Not imported from there: that module is server-only (pulls in node:fs /
 * node:path to resolve questions on disk) and has no reason to be part of
 * the browser bundle for one string template.
 */
function previewPagePath(category: string, slug: string): string {
  return `/preview/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/`;
}

/**
 * Live preview pane (NEE-349): an iframe pointed at the workspace's Vite dev
 * server for the current question. Rendered only for react-group questions
 * (Room.tsx derives that from the category registry — never a hardcoded
 * list here). Read-only by nature, so it renders the same whether the room
 * itself is a live attempt or a solved read-only reference.
 *
 * The iframe's `key` is `${category}/${slug}` ONLY — it must never remount
 * on every keystroke or every autosave. Vite's own HMR keeps the mounted
 * page current; a manual "reload" is a real navigation
 * (`contentWindow.location.reload()`), not a React remount, so it can't
 * fight HMR or loop against the save debounce.
 */
export function PreviewPane({
  category,
  slug,
  status,
  onRetry,
  flushSaves,
  onCollapse,
}: {
  category: string;
  slug: string;
  status: PreviewStatus;
  /** Manually re-attempts starting the dev server (starting/failed states). */
  onRetry: () => void;
  /** Flushed before every manual reload (NEE-349) so the freshest saved
   * content is what gets served, never one debounce behind. */
  flushSaves: () => Promise<void>;
  onCollapse: () => void;
}) {
  const [viewport, setViewport] = useState<PreviewViewport>('full');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageUrl = status.state === 'ready' && status.url != null ? status.url + previewPagePath(category, slug) : null;

  const handleReload = useCallback(() => {
    void (async () => {
      await flushSaves();
      const frame = iframeRef.current;
      try {
        frame?.contentWindow?.location.reload();
      } catch {
        // Cross-origin (the preview server's own port) mid-navigation can
        // throw — a fresh `src` assignment is the fallback hard-reload.
        if (frame != null && pageUrl != null) frame.src = pageUrl;
      }
    })();
  }, [flushSaves, pageUrl]);

  const openInTab = useCallback(() => {
    if (pageUrl != null) window.open(pageUrl, '_blank', 'noopener,noreferrer');
  }, [pageUrl]);

  const emulatedWidth = VIEWPORT_WIDTH[viewport];

  return (
    <aside className="preview-pane">
      <div className="pane-header">
        <span className="pane-title">Preview</span>
        <div className="ai-header-actions">
          <div className="preview-viewport-toggle" role="group" aria-label="Preview viewport width">
            {(['mobile', 'tablet', 'full'] as const).map((mode) => (
              <button
                key={mode}
                className={`preview-viewport-btn ${viewport === mode ? 'active' : ''}`}
                onClick={() => setViewport(mode)}
                title={`${mode[0].toUpperCase()}${mode.slice(1)} width`}
                aria-pressed={viewport === mode}
              >
                {mode === 'mobile' ? '📱' : mode === 'tablet' ? '📟' : '🖥️'}
              </button>
            ))}
          </div>
          <button
            className="icon-btn"
            onClick={handleReload}
            title="Reload the preview (flushes unsaved edits first)"
            disabled={status.state !== 'ready'}
          >
            ⟲
          </button>
          <button
            className="icon-btn"
            onClick={openInTab}
            title="Open the preview in a new tab"
            disabled={pageUrl == null}
          >
            ↗
          </button>
          <button className="icon-btn" onClick={onCollapse} title="Collapse preview pane">
            ✕
          </button>
        </div>
      </div>
      <div className="preview-body">
        {status.state === 'ready' && pageUrl != null ? (
          <div className="preview-frame-wrap" data-viewport={viewport}>
            <iframe
              key={`${category}/${slug}`}
              ref={iframeRef}
              src={pageUrl}
              title="Live preview"
              className="preview-frame"
              style={emulatedWidth != null ? { width: `${emulatedWidth}px` } : undefined}
            />
          </div>
        ) : (
          <PreviewStatusNotice status={status} onRetry={onRetry} />
        )}
      </div>
    </aside>
  );
}

/** Never a blank white rectangle (NEE-349 acceptance): starting/failed/
 * stopped all say so, with a retry affordance for the two that can be
 * retried. */
function PreviewStatusNotice({ status, onRetry }: { status: PreviewStatus; onRetry: () => void }) {
  if (status.state === 'starting') {
    return (
      <div className="preview-status preview-status-starting">
        <span className="pulse-dot" />
        starting the preview server…
      </div>
    );
  }
  if (status.state === 'failed') {
    return (
      <div className="preview-status preview-status-failed">
        <div className="compile-error-title">Preview failed to start</div>
        <pre className="compile-error-text">{status.reason ?? 'Unknown error.'}</pre>
        <button className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  // 'stopped' — idle-timed-out or not yet requested.
  return (
    <div className="preview-status preview-status-stopped">
      <span>Preview server is stopped.</span>
      <button className="btn btn-small" onClick={onRetry}>
        Start preview
      </button>
    </div>
  );
}
