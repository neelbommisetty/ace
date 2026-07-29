/**
 * Bundled monaco setup — imported once from main.tsx before first render.
 * Never the CDN: workers come in via Vite `?worker` imports and
 * `loader.config({ monaco })` points @monaco-editor/react at this bundle.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import { EDITOR_THEME } from './editor-options';
import { triggerStaleReload } from './stale-reload';

// Monarch tokenizers for every language the room can open. Monaco registers
// these behind a lazy import(), which Vite emits as separate hashed chunks;
// after a rebuild an already-open tab 404s on the old hash and every token
// falls back to plain foreground (the "theme stopped rendering" bug). A
// static import folds each tokenizer into the main bundle instead, so the
// lazy load resolves in-memory and never touches the network.
import 'monaco-editor/languages/definitions/typescript/typescript.js';
import 'monaco-editor/languages/definitions/javascript/javascript.js';
import 'monaco-editor/languages/definitions/css/css.js';
import 'monaco-editor/languages/definitions/html/html.js';
import 'monaco-editor/languages/definitions/markdown/markdown.js';

// A rebuild rewrites dist/assets with new content hashes; an already-open
// tab still requests these worker scripts by their old hashed filenames.
// Unlike a dynamic import(), a failed worker fetch never throws synchronously
// and never fires Vite's `vite:preloadError` — the failure only surfaces
// later as an `error` event on the Worker instance (or, in some browsers, a
// synchronous throw from the `new Worker(...)` constructor itself). Route
// both into the same one-shot reload path used for preload errors so a
// stale tab recovers instead of silently losing squiggles/diagnostics.
function newWorkerWithStaleReloadGuard(create: () => Worker): Worker {
  let worker: Worker;
  try {
    worker = create();
  } catch (err) {
    triggerStaleReload(window.sessionStorage, () => window.location.reload());
    throw err;
  }
  worker.addEventListener('error', () => {
    triggerStaleReload(window.sessionStorage, () => window.location.reload());
  });
  return worker;
}

// NEE-331: CSS/HTML document formatting (Shift+Alt+F, and the room's new
// Cmd+S / format-before-run) runs on the css/html language-service workers,
// same as TS/JS already did — without a dedicated worker script here these
// labels fell through to the plain `editorWorker`, which doesn't implement
// the CSSWorker/HTMLWorker RPC methods those providers call, so every
// hover/completion/format request for a .css/.html file would silently
// reject. Routing them to their own worker bundles (mirroring the ts/js
// case below) is the fix; TS/JS formatting was already reachable via its
// range-formatting provider (monaco synthesizes a whole-document formatter
// from it), so nothing else here needed to change.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript' || label === 'ts') {
      return newWorkerWithStaleReloadGuard(() => new tsWorker());
    }
    if (label === 'css' || label === 'less' || label === 'scss') {
      return newWorkerWithStaleReloadGuard(() => new cssWorker());
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return newWorkerWithStaleReloadGuard(() => new htmlWorker());
    }
    return newWorkerWithStaleReloadGuard(() => new editorWorker());
  },
};

// Semantic validation is the room's linter: type errors, undefined names,
// wrong argument counts. Solutions import from test-only or workspace-level
// deps monaco can't see (./solution, vitest, react), so every diagnostic
// that amounts to "module/typings not found" is suppressed — the unresolved
// import types as `any` and the rest of the file still checks cleanly.
// (monaco 0.55 moved languages.typescript to a top-level namespace.)
const MODULE_RESOLUTION_NOISE = [
  2307, // Cannot find module '...' or its corresponding type declarations
  2792, // Cannot find module — "did you mean to set moduleResolution?" variant
  7016, // Could not find a declaration file for module '...'
  2875, // This JSX tag requires the module path 'react/jsx-runtime' to exist
  7026, // JSX element implicitly has type 'any' (no React types loaded)
  2580, // Cannot find name 'require'/'process' — "install @types/node"
  2591, // Cannot find name '...' — "install @types/node" variant
];
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: MODULE_RESOLUTION_NOISE,
});
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: MODULE_RESOLUTION_NOISE,
});
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
});

// Catppuccin Macchiato (official palette hexes) for every Monaco surface.
monaco.editor.defineTheme(EDITOR_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '939ab7', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c6a0f6' },
    { token: 'string', foreground: 'a6da95' },
    { token: 'number', foreground: 'f5a97f' },
    { token: 'type', foreground: 'eed49f' },
    { token: 'class', foreground: 'eed49f' },
    { token: 'function', foreground: '8aadf4' },
    { token: 'variable', foreground: 'cad3f5' },
    { token: 'constant', foreground: 'f5a97f' },
    { token: 'operator', foreground: '91d7e3' },
    { token: 'delimiter', foreground: '939ab7' },
    { token: 'tag', foreground: '8aadf4' },
    { token: 'attribute.name', foreground: 'eed49f' },
    { token: 'regexp', foreground: 'f5bde6' },
  ],
  colors: {
    'editor.background': '#24273a',
    'editor.foreground': '#cad3f5',
    'editor.lineHighlightBackground': '#363a4f66',
    'editorLineNumber.foreground': '#6e738d',
    'editorLineNumber.activeForeground': '#a5adcb',
    'editorGutter.background': '#24273a',
    'editorIndentGuide.background1': '#363a4f',
    'editorIndentGuide.activeBackground1': '#494d64',
    'editorWidget.background': '#1e2030',
    'editorWidget.border': '#363a4f',
    'editorSuggestWidget.background': '#1e2030',
    'editorSuggestWidget.border': '#363a4f',
    'editorSuggestWidget.selectedBackground': '#363a4f',
    'editorHoverWidget.background': '#1e2030',
    'editorHoverWidget.border': '#363a4f',
    'editorCursor.foreground': '#f4dbd6',
    'editor.selectionBackground': '#5b607899',
    'scrollbarSlider.background': '#5b607866',
    'scrollbarSlider.hoverBackground': '#5b6078aa',
    'scrollbarSlider.activeBackground': '#5b6078dd',
  },
});

loader.config({ monaco });
