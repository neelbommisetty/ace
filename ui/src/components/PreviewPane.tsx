import { useCallback, useRef, useState } from 'react';
import type { PreviewConsoleEntry } from '../hooks/usePreviewConsole';
import type { PreviewStatus } from '../types';
import { PreviewTab } from './TestConsole';

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
 * server for the current question. Rendered only for previewable questions
 * (Room.tsx derives that from the category registry's `preview` field —
 * never a hardcoded list here). Read-only by nature, so it renders the same
 * whether the room itself is a live attempt or a solved read-only reference.
 *
 * The iframe's `key` is `${category}/${slug}` ONLY — it must never remount
 * on every keystroke or every autosave. Vite's own HMR keeps the mounted
 * page current; a manual "reload" is a real navigation
 * (`contentWindow.location.reload()`), not a React remount, so it can't
 * fight HMR or loop against the save debounce.
 *
 * `mode: 'import'` (NEE-387, e.g. playground-ts) is a console-first variant
 * for categories with nothing to mount visually: the iframe still MOUNTS
 * (it's what actually executes the code — no other runner exists) but stays
 * visually hidden, and the pane's body becomes a scrollable console over
 * `consoleEntries` reusing TestConsole's own `PreviewTab` renderer rather
 * than forking a second one. Everyone else (mode 'mount', the default) keeps
 * the original visible-iframe behaviour untouched.
 */
export function PreviewPane({
  category,
  slug,
  status,
  onRetry,
  flushSaves,
  onCollapse,
  mode = 'mount',
  consoleEntries,
  onClearConsole,
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
  /** 'import' (NEE-387): console-mode variant — hidden iframe + a scrollable
   * console instead of a visible frame. Defaults to 'mount', the original
   * (and only) behaviour before NEE-387. */
  mode?: 'mount' | 'import';
  /** Forwarded console/error entries (usePreviewConsole) — only rendered
   * (and only meaningful) in 'import' mode. */
  consoleEntries?: PreviewConsoleEntry[];
  /** Clears `consoleEntries` — only rendered in 'import' mode. */
  onClearConsole?: () => void;
}) {
  const [viewport, setViewport] = useState<PreviewViewport>('full');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pageUrl = status.state === 'ready' && status.url != null ? status.url + previewPagePath(category, slug) : null;
  const isConsole = mode === 'import';

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
        <span className="pane-title">{isConsole ? 'Console' : 'Preview'}</span>
        <div className="ai-header-actions">
          {!isConsole && (
            <div className="preview-viewport-toggle" role="group" aria-label="Preview viewport width">
              {(['mobile', 'tablet', 'full'] as const).map((vp) => (
                <button
                  key={vp}
                  className={`preview-viewport-btn ${viewport === vp ? 'active' : ''}`}
                  onClick={() => setViewport(vp)}
                  title={`${vp[0].toUpperCase()}${vp.slice(1)} width`}
                  aria-pressed={viewport === vp}
                >
                  {vp === 'mobile' ? '📱' : vp === 'tablet' ? '📟' : '🖥️'}
                </button>
              ))}
            </div>
          )}
          <button
            className="icon-btn"
            onClick={handleReload}
            title={isConsole ? 'Re-run (reloads the sandbox)' : 'Reload the preview (flushes unsaved edits first)'}
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
          {isConsole && (
            <button className="icon-btn" onClick={onClearConsole} title="Clear console">
              ⊘
            </button>
          )}
          <button className="icon-btn" onClick={onCollapse} title="Collapse preview pane">
            ✕
          </button>
        </div>
      </div>
      <div className="preview-body">
        {status.state === 'ready' && pageUrl != null ? (
          isConsole ? (
            <>
              <iframe
                key={`${category}/${slug}`}
                ref={iframeRef}
                src={pageUrl}
                title="Live preview"
                className="preview-frame preview-frame-hidden"
              />
              <div className="preview-console-surface">
                <PreviewTab entries={consoleEntries ?? []} />
              </div>
            </>
          ) : (
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
          )
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
