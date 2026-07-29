import { useEffect, useRef, useState } from 'react';
import { PREVIEW_CONSOLE_KINDS } from '@shared/wire-types';
import type { PreviewConsoleKind, PreviewConsoleMessage } from '../types';

const KNOWN_KINDS: ReadonlySet<string> = new Set(PREVIEW_CONSOLE_KINDS);

export interface PreviewConsoleEntry {
  id: number;
  kind: PreviewConsoleKind;
  text: string;
  file: string | null;
  line: number | null;
  /** Consecutive identical (kind + text) messages collapse into one entry
   * with this bumped instead of appending a new row — see the module doc. */
  count: number;
  at: number;
}

/** Ring-buffer cap (mirrors OUTPUT_CAP in cli/server/runner.ts:15, bounding
 * ENTRY COUNT here rather than bytes since these are discrete rows, not a
 * text stream) — an infinite-loop-shaped flood degrades to evicting its own
 * oldest entries, never test output (a completely separate array/prop). */
const MAX_ENTRIES = 200;

function isPreviewConsoleMessage(data: unknown): data is PreviewConsoleMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.source !== 'ace-preview') return false;
  // Closed set, not just "a string" (NEE-351): an unrecognised kind is dropped
  // rather than rendered with an undefined label — the iframe is untrusted.
  if (typeof d.kind !== 'string' || !KNOWN_KINDS.has(d.kind)) return false;
  if (typeof d.text !== 'string') return false;
  if (d.file !== null && typeof d.file !== 'string') return false;
  if (d.line !== null && typeof d.line !== 'number') return false;
  return true;
}

/**
 * Preview error/console forwarding (NEE-351): listens for postMessage from
 * the preview iframe (the error-forwarding section of
 * cli/server/preview-harness.ts's buildHarnessEntry) and turns it into the
 * entries the console pane's Preview tab renders — sharing that component
 * with test output rather than forking a second console.
 *
 * SECURITY: the iframe runs LLM-generated + user-written code — everything
 * crossing postMessage is UNTRUSTED. A message is dropped unless
 * `event.origin` matches the preview dev server's own origin (derived from
 * the ready `PreviewStatus.url`, never the ace API's own origin — see
 * PreviewPane) AND the payload shape validates. Every field is rendered by
 * the caller as plain text (React children, never dangerouslySetInnerHTML).
 */
export function usePreviewConsole(previewOrigin: string | null): {
  entries: PreviewConsoleEntry[];
  clear: () => void;
} {
  const [entries, setEntries] = useState<PreviewConsoleEntry[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (previewOrigin == null) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== previewOrigin) return;
      if (!isPreviewConsoleMessage(e.data)) return;
      const msg = e.data;
      setEntries((prev) => {
        const last = prev[prev.length - 1];
        if (last != null && last.kind === msg.kind && last.text === msg.text) {
          const bumped: PreviewConsoleEntry = { ...last, count: last.count + 1, at: Date.now() };
          return [...prev.slice(0, -1), bumped];
        }
        const entry: PreviewConsoleEntry = {
          id: nextId.current++,
          kind: msg.kind,
          text: msg.text,
          file: msg.file,
          line: msg.line,
          count: 1,
          at: Date.now(),
        };
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewOrigin]);

  return { entries, clear: () => setEntries([]) };
}
