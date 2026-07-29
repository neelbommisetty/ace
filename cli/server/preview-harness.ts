import fs from 'node:fs';
import path from 'node:path';
import { lookupCategoryConfig } from '../lib/categories.js';

/**
 * Preview entry harness (NEE-350): the per-question index.html + entry module
 * the dev server SYNTHESISES (virtual — never written into the user's
 * question folder, whose contents are the user's artifact and are hashed for
 * snapshots).
 *
 * There is no single export contract across the corpus: the react-apps
 * template default-exports `App`, the web-components template NAMED-exports
 * `Component`, and generated questions render whatever `{{{signature}}}` the
 * LLM supplied — so the harness resolves the mountable export at RUNTIME in
 * the browser (see resolvePreviewExport) instead of hardcoding one import,
 * and re-resolves after every HMR update.
 */

// ---------------------------------------------------------------------------
// URL scheme — one place, so the page middleware, the virtual-module plugin
// and the pane agree byte-for-byte.
// ---------------------------------------------------------------------------

/** Iframe page for one question: `/preview/<category>/<slug>/`. */
export function previewPagePath(category: string, slug: string): string {
  return `/preview/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/`;
}

/** Virtual entry module the page's `<script type="module">` loads. */
export function previewEntryPath(category: string, slug: string): string {
  return `/@ace-preview/${encodeURIComponent(category)}/${encodeURIComponent(slug)}/entry.js`;
}

const PAGE_RE = /^\/preview\/([^/]+)\/([^/]+)\/?$/;
const ENTRY_RE = /^\/@ace-preview\/([^/]+)\/([^/]+)\/entry\.js$/;

function decodePair(m: RegExpExecArray): { category: string; slug: string } | null {
  try {
    return { category: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

export function parsePreviewPagePath(pathname: string): { category: string; slug: string } | null {
  const m = PAGE_RE.exec(pathname);
  return m ? decodePair(m) : null;
}

export function parsePreviewEntryId(id: string): { category: string; slug: string } | null {
  const m = ENTRY_RE.exec(id);
  return m ? decodePair(m) : null;
}

// ---------------------------------------------------------------------------
// Target resolution — which module does this question's preview mount?
// ---------------------------------------------------------------------------

export interface PreviewTarget {
  category: string;
  slug: string;
  /** Absolute path of the module the harness mounts. */
  moduleFile: string;
  /**
   * The category's expected export name (`App` for react-apps, `Component`
   * for web-components — derived from the category's first solution file, so
   * a category change can't silently drift a twin copy of the rule).
   */
  expectedName: string | null;
}

export type PreviewTargetResolution =
  | { ok: true; target: PreviewTarget }
  | { ok: false; reason: string };

/** Path-segment guard: URL-supplied category/slug must never traverse out of questions/. */
function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && !segment.includes('..');
}

/**
 * FIXTURE SEAM (deliberate, for the parallel preview-fixture ticket): this
 * function is the single decision point for "which module gets mounted". A
 * user-owned `preview.tsx` in the question folder will, when present, be
 * returned here as the moduleFile (mounted directly, `expectedName: null`)
 * instead of the bare solution component — nothing else in the harness needs
 * to change for that.
 */
export function resolvePreviewTarget(
  questionsDir: string,
  category: string,
  slug: string,
): PreviewTargetResolution {
  if (!isSafeSegment(category) || !isSafeSegment(slug)) {
    return { ok: false, reason: 'invalid preview path' };
  }
  const config = lookupCategoryConfig(category);
  if (config == null) {
    return { ok: false, reason: `unknown category "${category}"` };
  }
  if (config.group !== 'react') {
    return {
      ok: false,
      reason: `live preview is only available for React categories — "${category}" has nothing to mount`,
    };
  }
  const solutionFile = config.solutionFiles[0];
  const moduleFile = path.join(questionsDir, category, slug, solutionFile);
  if (!fs.existsSync(moduleFile)) {
    return {
      ok: false,
      reason: `no ${solutionFile} found for ${category}/${slug}`,
    };
  }
  return {
    ok: true,
    target: {
      category,
      slug,
      moduleFile,
      expectedName: path.basename(solutionFile).replace(/\.[^.]+$/, ''),
    },
  };
}

// ---------------------------------------------------------------------------
// Export resolution — SELF-CONTAINED ON PURPOSE: buildHarnessEntry embeds
// this exact function into the browser entry via .toString(), so the rule
// tested here in Node is byte-for-byte the rule that runs in the pane (no
// twin copy to drift). No imports, no closures, plain ES2022 only.
// ---------------------------------------------------------------------------

/**
 * Resolution order (NEE-350): default export -> the category's expected name
 * (`App` / `Component`) -> the single remaining capitalised component
 * export. "Component" accepts functions/classes and React exotic objects
 * (memo/forwardRef carry `$$typeof`). When nothing resolves the message
 * names what WAS found and what is expected.
 */
export function resolvePreviewExport(
  mod: Record<string, unknown>,
  expectedName: string | null,
): { ok: true; exportName: string } | { ok: false; message: string } {
  function isRenderable(value: unknown): boolean {
    if (typeof value === 'function') return true;
    return (
      typeof value === 'object' && value !== null && '$$typeof' in (value as Record<string, unknown>)
    );
  }
  if (isRenderable(mod['default'])) return { ok: true, exportName: 'default' };
  if (expectedName != null && isRenderable(mod[expectedName])) {
    return { ok: true, exportName: expectedName };
  }
  const capitalised = Object.keys(mod).filter(
    (name) => name !== 'default' && name !== expectedName && /^[A-Z]/.test(name) && isRenderable(mod[name]),
  );
  if (capitalised.length === 1) return { ok: true, exportName: capitalised[0] };

  const found = Object.keys(mod);
  const expected = [
    'a default export',
    expectedName != null ? 'an export named "' + expectedName + '"' : '',
    'a single capitalised component export',
  ]
    .filter((s) => s !== '')
    .join(', or ');
  const foundLabel = found.length > 0 ? 'found exports [' + found.join(', ') + ']' : 'found no exports';
  const ambiguous =
    capitalised.length > 1
      ? ' (' + capitalised.length + ' capitalised exports - ambiguous: ' + capitalised.join(', ') + ')'
      : '';
  return { ok: false, message: foundLabel + ambiguous + '; expected ' + expected };
}

// ---------------------------------------------------------------------------
// Harness generation
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The per-question index.html. Neutral baseline styling ONLY — the
 * question's own styling is the thing under test, so no reset beyond a
 * margin-free body and the platform font stack.
 */
export function buildHarnessHtml(target: PreviewTarget): string {
  const title = `${target.category}/${target.slug} — ace preview`;
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>:root{color-scheme:light dark}body{margin:0;font-family:system-ui,sans-serif}</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module" src="${previewEntryPath(target.category, target.slug)}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

const RESOLVE_PREVIEW_EXPORT_SOURCE = resolvePreviewExport.toString();

/**
 * Error/console forwarding (NEE-351) — plain JS spliced verbatim into the
 * browser entry, installed before the first render so a mount-time throw is
 * still caught. Posts to the parent window so the Room's EXISTING console
 * pane can show these under a Preview source (ui/src/hooks/usePreviewConsole.ts
 * validates origin + payload shape before touching any of it — the iframe
 * runs LLM-generated + user-written code, so nothing here is trusted on
 * arrival). Kinds mirror shared/wire-types.ts's `PreviewConsoleKind` — kept
 * in sync by hand since this half runs as an emitted string, not compiled
 * TS.
 *
 * The per-second cap throttles the CHANNEL itself (not just the display): an
 * infinite render loop can call console.error far faster than any consumer
 * can use, and without this the flood would still saturate the parent
 * window's postMessage queue even if the receiving hook collapses repeats.
 */
const ACE_PREVIEW_FORWARDING_SOURCE = `
let aceMsgCount = 0;
let aceMsgWindowStart = Date.now();
const ACE_MAX_MSGS_PER_SEC = 20;

function aceStringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function acePreviewPost(kind, text, extra) {
  const now = Date.now();
  if (now - aceMsgWindowStart > 1000) {
    aceMsgWindowStart = now;
    aceMsgCount = 0;
  }
  aceMsgCount += 1;
  if (aceMsgCount > ACE_MAX_MSGS_PER_SEC) {
    if (aceMsgCount === ACE_MAX_MSGS_PER_SEC + 1) {
      try {
        window.parent.postMessage(
          {
            source: 'ace-preview',
            kind: 'rate-limited',
            text: MODULE_LABEL + ' is emitting messages faster than the console can show — throttling',
            file: null,
            line: null,
          },
          '*',
        );
      } catch {}
    }
    return;
  }
  try {
    window.parent.postMessage(
      {
        source: 'ace-preview',
        kind,
        text,
        file: (extra && extra.file) || null,
        line: extra && extra.line != null ? extra.line : null,
      },
      '*',
    );
  } catch {}
}

window.addEventListener('error', (e) => {
  const err = e.error;
  const text = (err && err.stack) || e.message + ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')';
  acePreviewPost('window-error', text);
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const text = (reason && reason.stack) || (reason && reason.message) || String(reason);
  acePreviewPost('unhandled-rejection', text);
});

for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  const kind = 'console-' + level;
  console[level] = function (...args) {
    original.apply(console, args);
    acePreviewPost(kind, args.map(aceStringify).join(' '));
  };
}
`;

/**
 * The virtual entry module. Plain JS with React.createElement (no JSX, so it
 * needs no transform of its own); React 19 createRoot with StrictMode ON —
 * double-invoked effects are exactly the bug class a practice tool should
 * surface. The export is re-resolved on every HMR update: an in-place
 * react-refresh update keeps identities (and the boundary key bump remounts
 * out of a caught error), while an export RENAME is refresh-incompatible and
 * triggers a full reload, whose fresh import re-resolves from scratch.
 */
export function buildHarnessEntry(target: PreviewTarget): string {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import * as questionModule from ${JSON.stringify('/@fs' + target.moduleFile)};

const EXPECTED_NAME = ${JSON.stringify(target.expectedName)};
const MODULE_LABEL = ${JSON.stringify(`${target.category}/${target.slug}/${path.basename(target.moduleFile)}`)};

${ACE_PREVIEW_FORWARDING_SOURCE}

// Injected verbatim from cli/server/preview-harness.ts (single source of truth).
const resolvePreviewExport = ${RESOLVE_PREVIEW_EXPORT_SOURCE};

// A render-time throw shows the error + component stack instead of a white
// screen; the boundary is remounted (fresh key) on the next HMR update.
class PreviewErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(_error, info) {
    this.setState({ componentStack: info ? info.componentStack : null });
    // The boundary already shows this locally — also forward it so the same
    // failure is visible in the console pane (NEE-351), not just in-pane.
    acePreviewPost('window-error', String((_error && _error.stack) || _error));
  }
  render() {
    if (this.state.error) {
      const error = this.state.error;
      return React.createElement(
        'div',
        { style: { padding: '16px', fontFamily: 'ui-monospace, SFMono-Regular, monospace' } },
        React.createElement('h2', { style: { marginTop: 0, color: '#b3261e' } }, 'Render error'),
        React.createElement(
          'pre',
          { style: { whiteSpace: 'pre-wrap' } },
          String((error && error.stack) || error),
        ),
        this.state.componentStack
          ? React.createElement(
              'pre',
              { style: { whiteSpace: 'pre-wrap', opacity: 0.7 } },
              this.state.componentStack,
            )
          : null,
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById('root'));
let mountGeneration = 0;

function renderPreview() {
  mountGeneration += 1;
  const resolved = resolvePreviewExport(questionModule, EXPECTED_NAME);
  if (!resolved.ok) {
    root.render(
      React.createElement(
        'div',
        { style: { padding: '16px' } },
        React.createElement('h2', { style: { marginTop: 0 } }, 'Nothing to mount'),
        React.createElement(
          'pre',
          { style: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' } },
          MODULE_LABEL + ': ' + resolved.message,
        ),
      ),
    );
    return;
  }
  const Component = questionModule[resolved.exportName];
  root.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(PreviewErrorBoundary, { key: mountGeneration }, React.createElement(Component)),
    ),
  );
}

renderPreview();

if (import.meta.hot) {
  // Re-resolve + remount after every HMR update. Export renames don't land
  // here — react-refresh treats them as incompatible and full-reloads, which
  // re-runs this module and re-resolves anyway.
  import.meta.hot.on('vite:afterUpdate', () => {
    renderPreview();
  });
  // A transform/syntax failure (NEE-351) never reaches renderPreview at
  // all — Vite's own overlay would normally show it, but the console pane
  // is the one place the user is already looking, so it's forwarded there
  // too, mapped onto the same compile-error shape a vitest transform
  // failure produces (file/line included when Vite reports a loc).
  import.meta.hot.on('vite:error', (payload) => {
    const err = payload && payload.err;
    const loc = err && err.loc;
    let text = (err && err.message) || (MODULE_LABEL + ': preview failed to compile');
    if (err && err.frame) text += '\\n' + err.frame;
    acePreviewPost('vite-error', text, {
      file: (loc && loc.file) || (err && err.id) || null,
      line: loc ? loc.line : null,
    });
  });
}
`;
}
