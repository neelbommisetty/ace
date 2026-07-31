/**
 * React 19 typings for the Monaco TS worker (NEE-385) — pure data, no monaco
 * imports, so the node-side vitest proof (monaco-react-typings.test.ts) can
 * type-check real sources against the exact payload the browser ships.
 *
 * Vite's `?raw` inlines each .d.ts as a bundled string (they ride the main
 * chunk — same stale-tab reasoning as every other static import in monaco.ts).
 * Relative `../../node_modules/` specifiers, not bare ones: the @types
 * packages' `exports` maps only expose extensionless subpaths ('.',
 * './jsx-runtime', './client', …), so Vite's exports resolution would refuse a
 * bare deep import of the .d.ts files themselves.
 */
import reactIndexDts from '../../node_modules/@types/react/index.d.ts?raw';
import reactJsxRuntimeDts from '../../node_modules/@types/react/jsx-runtime.d.ts?raw';
import reactGlobalDts from '../../node_modules/@types/react/global.d.ts?raw';
import csstypeIndexDts from '../../node_modules/csstype/index.d.ts?raw';
import reactDomIndexDts from '../../node_modules/@types/react-dom/index.d.ts?raw';
import reactDomClientDts from '../../node_modules/@types/react-dom/client.d.ts?raw';

/**
 * Each entry's `path` mirrors the real package layout under a virtual
 * /node_modules root, so nodejs module resolution finds the set for the
 * specifiers 'react', 'react/jsx-runtime', 'csstype', 'react-dom' and
 * 'react-dom/client' from any file:///… model. Deliberately NO package.json
 * entries: with none present, resolution falls through to index.d.ts
 * directly, which keeps the modern root typings in play and avoids the
 * typesVersions indirection the real package.json files would introduce.
 * global.d.ts is never imported by specifier — index.d.ts pulls it in via
 * `/// <reference path="global.d.ts" />`.
 */
export const REACT_TYPE_LIBS: ReadonlyArray<{ path: string; content: string }> = [
  { path: '/node_modules/@types/react/index.d.ts', content: reactIndexDts },
  { path: '/node_modules/@types/react/jsx-runtime.d.ts', content: reactJsxRuntimeDts },
  { path: '/node_modules/@types/react/global.d.ts', content: reactGlobalDts },
  { path: '/node_modules/csstype/index.d.ts', content: csstypeIndexDts },
  { path: '/node_modules/@types/react-dom/index.d.ts', content: reactDomIndexDts },
  { path: '/node_modules/@types/react-dom/client.d.ts', content: reactDomClientDts },
];

// Semantic validation is the room's linter: type errors, undefined names,
// wrong argument counts. Solutions import from test-only or workspace-level
// deps monaco can't see (./solution, vitest, @testing-library/*), so every
// diagnostic that amounts to "module/typings not found" is suppressed — the
// unresolved import types as `any` and the rest of the file still checks
// cleanly. 2875 ("react/jsx-runtime must exist") and 7026 ("JSX element
// implicitly has type any") used to be suppressed too; with REACT_TYPE_LIBS
// loaded they only fire when the React typings are genuinely broken, so
// keeping them here would mask real errors. (javascriptDefaults still adds
// them back on top — see monaco.ts.)
export const MODULE_RESOLUTION_NOISE = [
  2307, // Cannot find module '...' or its corresponding type declarations
  2792, // Cannot find module — "did you mean to set moduleResolution?" variant
  7016, // Could not find a declaration file for module '...'
  2580, // Cannot find name 'require'/'process' — "install @types/node"
  2591, // Cannot find name '...' — "install @types/node" variant
];
