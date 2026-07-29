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
import { createHighlighterCoreSync, createJavaScriptRegexEngine } from 'shiki';
import { shikiToMonaco } from '@shikijs/monaco';
import catppuccinMacchiato from 'shiki/themes/catppuccin-macchiato.mjs';
import tsxGrammar from 'shiki/langs/tsx.mjs';
import javascriptGrammar from 'shiki/langs/javascript.mjs';
import jsxGrammar from 'shiki/langs/jsx.mjs';
import cssGrammar from 'shiki/langs/css.mjs';
import htmlGrammar from 'shiki/langs/html.mjs';
import markdownGrammar from 'shiki/langs/markdown.mjs';
import { EDITOR_THEME } from './editor-options';
import { triggerStaleReload } from './stale-reload';

// Every language the room can open still needs Monaco's own language
// *configuration* registered — auto-closing brackets, comment toggling —
// even though shiki (below) now replaces Monaco's built-in Monarch
// tokenizer for colorization. Monaco registers configuration + Monarch
// tokenizer together behind a lazy import(), which Vite emits as a separate
// hashed chunk; after a rebuild an already-open tab 404s on the old hash and
// every token falls back to plain foreground (the "theme stopped rendering"
// bug). A static import folds each definition into the main bundle instead,
// so the lazy load resolves in-memory and never touches the network. The
// Monarch tokenizer these also register is immediately superseded once
// shikiToMonaco() runs below — `setTokensProvider` overwrites whatever
// `setMonarchTokensProvider` installed for the same language id, so import
// order here (before the shiki setup) is what makes shiki's provider win.
import 'monaco-editor/languages/definitions/typescript/typescript.js';
import 'monaco-editor/languages/definitions/javascript/javascript.js';
import 'monaco-editor/languages/definitions/css/css.js';
import 'monaco-editor/languages/definitions/html/html.js';
import 'monaco-editor/languages/definitions/markdown/markdown.js';

// NEE-335: Monaco's Monarch TypeScript tokenizer is coarse — it has no
// notion of "this", "function call", or "property access", so
// `this.data.children[id].filter(...)` comes out as nearly all `identifier`
// tokens and the hand-rolled theme's function/class/variable rules almost
// never fire. Shiki runs the real TextMate grammars (the same ones VS Code
// uses) against the official catppuccin-macchiato theme instead.
// `createHighlighterCoreSync` + `createJavaScriptRegexEngine` keeps setup
// entirely synchronous (no oniguruma wasm to fetch); `forgiving: true`
// tolerates the handful of grammar regexes the JS engine can't translate
// 1:1 from Oniguruma rather than throwing on them. Every grammar/theme
// import above is `shiki/<kind>/<name>.mjs`, not shiki's own
// `createHighlighter()` bundle helper — that helper pulls grammars in
// behind a lazy import(), which would regress the same stale-tab bug the
// language-definition imports above guard against (c9e4a98/NEE-330).
//
// Caveat — .tsx maps to the Monaco language id "typescript": Monaco has no
// separate "tsx" language id, and this app's own `languageFor()`
// (DisputeModal.tsx) maps both .ts and .tsx to "typescript"; the
// react-apps question set is full of .tsx files. Loading the plain
// `typescript` grammar under that id would leave every JSX file
// untokenized (falls back to plain foreground) the moment a tag appears.
// Rather than accept that, the `tsx` grammar — a strict superset that
// layers JSX scopes on top of the same TypeScript grammar — is renamed to
// `typescript` below and registered in its place instead of the plain one.
// Plain .ts content (interfaces, generics, `this`) tokenizes identically
// through it; .tsx content now gets real JSX scopes too.
const typescriptGrammar = tsxGrammar.map((grammar) =>
  grammar.name === 'tsx'
    ? { ...grammar, name: 'typescript', aliases: ['ts', 'cts', 'mts'] }
    : grammar,
);

const highlighter = createHighlighterCoreSync({
  themes: [catppuccinMacchiato],
  langs: [typescriptGrammar, javascriptGrammar, jsxGrammar, cssGrammar, htmlGrammar, markdownGrammar],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

// shikiToMonaco() (below) registers a Monaco theme named after the VS Code
// theme it was given — here, shiki's own `catppuccinMacchiato.name`. Every
// other surface in the app (editor-options.ts's EDITOR_THEME, DisputeModal's
// diff editor) passes that same string as the Monaco theme id, so this
// guards against the two silently drifting apart rather than trusting the
// coincidence.
if (catppuccinMacchiato.name !== EDITOR_THEME) {
  throw new Error(
    `shiki theme name ("${catppuccinMacchiato.name}") no longer matches EDITOR_THEME ("${EDITOR_THEME}")`,
  );
}

// Registers shiki's tokens provider for every one of the languages above
// that Monaco already knows about (typescript, javascript, css, html,
// markdown — all registered by the static language-definition imports
// above) and defines the `catppuccin-macchiato` Monaco theme from the VS
// Code theme's own `tokenColors`/`colors`. Must run after those imports
// (see the comment on them) so this tokens provider is the one left
// installed, not Monarch's.
shikiToMonaco(highlighter, monaco);

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

// The hand-rolled `monaco.editor.defineTheme(EDITOR_THEME, ...)` that used
// to live here is gone: `shikiToMonaco()` above already registers a Monaco
// theme under this same `catppuccin-macchiato` name (EDITOR_THEME), built
// from the official VS Code theme's `tokenColors` and `colors` and encoded
// against shiki's own colormap. Redefining over it here would silently
// break every token color again. Every workbench surface this app hand-
// tuned before (line highlight, selection, scrollbar, indent guides,
// widgets) is present in the official theme's `colors` or resolves through
// Monaco's own color-registry fallback chain (e.g. `editorIndentGuide.
// background1` falls back to the theme's `editorIndentGuide.background`,
// `editorWidget.border` falls back to a foreground tint) — none of them
// came out actually unset, so none were re-added.
loader.config({ monaco });
