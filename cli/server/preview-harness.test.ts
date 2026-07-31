// @vitest-environment node
//
// NEE-350: preview entry harness. Unit tests pin the export-resolution rule
// (the same function is embedded verbatim into the browser entry) and the
// target/URL scheme; the integration block serves all corpus export shapes
// through a REAL Vite server. What a headless test cannot assert — the
// in-browser mount, HMR feel, error-boundary recovery — is exercised only up
// to "the served entry module contains that logic".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHarnessEntry,
  buildHarnessHtml,
  parsePreviewEntryId,
  parsePreviewPagePath,
  previewEntryPath,
  previewPagePath,
  resolvePreviewExport,
  resolvePreviewTarget,
  type PreviewTarget,
} from './preview-harness.js';
import { createPreviewManager, type PreviewManager } from './preview.js';
import { createBus } from './sse.js';

const ACE_NODE_MODULES = path.resolve(import.meta.dirname, '..', '..', 'node_modules');

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// ---------------------------------------------------------------------------
// resolvePreviewExport
// ---------------------------------------------------------------------------

describe('resolvePreviewExport', () => {
  const App = () => null;
  const Component = () => null;

  it('prefers the default export', () => {
    expect(resolvePreviewExport({ default: App, App, Other: App }, 'App')).toEqual({
      ok: true,
      exportName: 'default',
    });
  });

  it('accepts a memo/forwardRef default export (React exotic object)', () => {
    const memoized = React.memo(App);
    expect(resolvePreviewExport({ default: memoized }, 'App')).toEqual({
      ok: true,
      exportName: 'default',
    });
    const withRef = React.forwardRef(() => null);
    expect(resolvePreviewExport({ default: withRef }, 'Component')).toEqual({
      ok: true,
      exportName: 'default',
    });
  });

  it('falls back to the category-expected name', () => {
    expect(resolvePreviewExport({ Component, helper: 1 }, 'Component')).toEqual({
      ok: true,
      exportName: 'Component',
    });
  });

  it('falls back to the single remaining capitalised export (generated names)', () => {
    expect(resolvePreviewExport({ TodoBoard: App, useThing: () => 1 }, 'App')).toEqual({
      ok: true,
      exportName: 'TodoBoard',
    });
  });

  it('skips a non-renderable expected-name export in favour of the single component', () => {
    expect(resolvePreviewExport({ App: 42, RealOne: Component }, 'App')).toEqual({
      ok: true,
      exportName: 'RealOne',
    });
  });

  it('reports what WAS found when nothing resolves', () => {
    const result = resolvePreviewExport({ helper: 1, config: {} }, 'App');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('found exports [helper, config]');
    expect(result.message).toContain('a default export');
    expect(result.message).toContain('an export named "App"');
    // `config: {}` has no $$typeof, so it is not treated as a component.
  });

  it('reports ambiguity for multiple capitalised exports', () => {
    const result = resolvePreviewExport({ First: App, Second: Component }, 'App');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('ambiguous');
    expect(result.message).toContain('First');
    expect(result.message).toContain('Second');
  });

  it('handles an empty module', () => {
    const result = resolvePreviewExport({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('found no exports');
  });
});

// ---------------------------------------------------------------------------
// Target + URL scheme
// ---------------------------------------------------------------------------

describe('resolvePreviewTarget', () => {
  function makeQuestions(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-harness-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const qdir = path.join(root, 'questions');
    fs.mkdirSync(path.join(qdir, 'react-apps', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(qdir, 'react-apps', 'demo', 'App.tsx'), 'export default 1;\n');
    fs.mkdirSync(path.join(qdir, 'web-components', 'widget'), { recursive: true });
    fs.writeFileSync(path.join(qdir, 'web-components', 'widget', 'Component.tsx'), 'export default 1;\n');
    fs.mkdirSync(path.join(qdir, 'playground', 'scratch-1'), { recursive: true });
    fs.writeFileSync(path.join(qdir, 'playground', 'scratch-1', 'App.tsx'), 'export default 1;\n');
    fs.mkdirSync(path.join(qdir, 'playground-ts', 'scratch-1'), { recursive: true });
    fs.writeFileSync(
      path.join(qdir, 'playground-ts', 'scratch-1', 'index.ts'),
      "console.log('hi');\n",
    );
    return qdir;
  }

  it('derives the expected export name from the category solution file', () => {
    const qdir = makeQuestions();
    const app = resolvePreviewTarget(qdir, 'react-apps', 'demo');
    expect(app).toMatchObject({
      ok: true,
      target: {
        expectedName: 'App',
        moduleFile: path.join(qdir, 'react-apps', 'demo', 'App.tsx'),
        usesFixture: false,
        fixtureHint: null,
        mode: 'mount',
      },
    });
    const comp = resolvePreviewTarget(qdir, 'web-components', 'widget');
    expect(comp).toMatchObject({
      ok: true,
      target: {
        expectedName: 'Component',
        usesFixture: false,
        // web-components with no preview.tsx yet gets a hint; react-apps never does.
        fixtureHint: expect.stringContaining('preview.tsx'),
        mode: 'mount',
      },
    });
  });

  // NEE-387: playground categories drive their preview through the SAME
  // registry field ('preview'), not a hardcoded group check.
  it('resolves the react playground in mount mode like any other react-group category', () => {
    const qdir = makeQuestions();
    const resolved = resolvePreviewTarget(qdir, 'playground', 'scratch-1');
    expect(resolved).toMatchObject({
      ok: true,
      target: {
        moduleFile: path.join(qdir, 'playground', 'scratch-1', 'App.tsx'),
        expectedName: 'App',
        usesFixture: false,
        mode: 'mount',
      },
    });
  });

  it('resolves the ts playground in import mode, ignoring any preview.tsx fixture', () => {
    const qdir = makeQuestions();
    // Import mode never consults the fixture seam — even a stray preview.tsx
    // dropped in the dir is ignored, unlike the mount-mode web-components case.
    fs.writeFileSync(
      path.join(qdir, 'playground-ts', 'scratch-1', 'preview.tsx'),
      'export default function Preview() { return null; }\n',
    );
    const resolved = resolvePreviewTarget(qdir, 'playground-ts', 'scratch-1');
    expect(resolved).toMatchObject({
      ok: true,
      target: {
        moduleFile: path.join(qdir, 'playground-ts', 'scratch-1', 'index.ts'),
        expectedName: null,
        usesFixture: false,
        fixtureHint: null,
        mode: 'import',
      },
    });
  });

  it('mounts preview.tsx instead of the bare component when one exists (NEE-352 fixture seam)', () => {
    const qdir = makeQuestions();
    const fixturePath = path.join(qdir, 'web-components', 'widget', 'preview.tsx');
    fs.writeFileSync(fixturePath, 'export default function Preview() { return null; }\n');

    const resolved = resolvePreviewTarget(qdir, 'web-components', 'widget');
    expect(resolved).toMatchObject({
      ok: true,
      target: {
        moduleFile: fixturePath,
        expectedName: null,
        usesFixture: true,
        // A fixture means props are handled — no hint needed.
        fixtureHint: null,
      },
    });
  });

  it('never hints for react-apps even with no fixture (App is self-sufficient bare)', () => {
    const qdir = makeQuestions();
    const resolved = resolvePreviewTarget(qdir, 'react-apps', 'demo');
    expect(resolved).toMatchObject({ ok: true, target: { fixtureHint: null } });
  });

  it('rejects non-previewing categories, unknown categories, and missing questions', () => {
    const qdir = makeQuestions();
    // js-ts has preview: 'none' — still rejected, just with the field-driven
    // reason rather than the old hardcoded group==='react' message.
    const jsTs = resolvePreviewTarget(qdir, 'js-ts', 'anything');
    expect(jsTs).toMatchObject({ ok: false });
    if (jsTs.ok) throw new Error('unreachable');
    expect(jsTs.reason).toContain('not available for "js-ts"');

    expect(resolvePreviewTarget(qdir, 'not-a-category', 'x')).toMatchObject({ ok: false });
    const missing = resolvePreviewTarget(qdir, 'react-apps', 'nope');
    expect(missing).toMatchObject({ ok: false });
    if (missing.ok) throw new Error('unreachable');
    expect(missing.reason).toContain('App.tsx');
  });

  it('rejects traversal-shaped segments', () => {
    const qdir = makeQuestions();
    expect(resolvePreviewTarget(qdir, '..', 'demo')).toMatchObject({ ok: false });
    expect(resolvePreviewTarget(qdir, 'react-apps', '..')).toMatchObject({ ok: false });
    expect(resolvePreviewTarget(qdir, 'react-apps', 'a/b')).toMatchObject({ ok: false });
    expect(resolvePreviewTarget(qdir, 'react-apps', '.hidden')).toMatchObject({ ok: false });
  });
});

describe('preview URL scheme', () => {
  it('round-trips page and entry paths', () => {
    expect(parsePreviewPagePath(previewPagePath('react-apps', 'demo'))).toEqual({
      category: 'react-apps',
      slug: 'demo',
    });
    expect(parsePreviewPagePath('/preview/react-apps/demo')).toEqual({
      category: 'react-apps',
      slug: 'demo',
    });
    expect(parsePreviewEntryId(previewEntryPath('web-components', 'widget'))).toEqual({
      category: 'web-components',
      slug: 'widget',
    });
    expect(parsePreviewPagePath('/preview/only-one/')).toBeNull();
    expect(parsePreviewPagePath('/api/preview')).toBeNull();
    expect(parsePreviewEntryId('/@ace-preview/a/b/other.js')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Harness generation
// ---------------------------------------------------------------------------

describe('harness generation', () => {
  const target: PreviewTarget = {
    category: 'react-apps',
    slug: 'demo',
    moduleFile: '/ws/questions/react-apps/demo/App.tsx',
    expectedName: 'App',
    usesFixture: false,
    fixtureHint: null,
    mode: 'mount',
  };

  it('html mounts the entry module and nothing else', () => {
    const html = buildHarnessHtml(target);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(`src="${previewEntryPath('react-apps', 'demo')}"`);
    // NEE-380: a deterministic light canvas, not OS-derived — a dark-OS
    // `color-scheme:light dark` left text invisible and buttons black behind
    // the app pane's opaque white backdrop.
    expect(html).toContain('color-scheme:light');
    expect(html).not.toContain('color-scheme:light dark');
    expect(html).toContain('background:#fff;color:#111');
  });

  // NEE-381: runtime-JIT Tailwind script, when resolved, must load BEFORE
  // the harness entry — the app's own module graph runs after Tailwind's
  // MutationObserver is already installed.
  it('injects the tailwind script before the entry script when an entry is passed', () => {
    const html = buildHarnessHtml(target, '/ace/node_modules/@tailwindcss/browser/dist/index.global.js');
    const tailwindTag =
      '<script type="module" src="/@fs/ace/node_modules/@tailwindcss/browser/dist/index.global.js"></script>';
    expect(html).toContain(tailwindTag);
    const tailwindIdx = html.indexOf(tailwindTag);
    const entryIdx = html.indexOf(`src="${previewEntryPath('react-apps', 'demo')}"`);
    expect(tailwindIdx).toBeGreaterThan(-1);
    expect(entryIdx).toBeGreaterThan(tailwindIdx);
  });

  it('omits the tailwind script when the entry is null or omitted', () => {
    expect(buildHarnessHtml(target, null)).not.toContain('@tailwindcss/browser');
    expect(buildHarnessHtml(target)).not.toContain('@tailwindcss/browser');
  });

  it('html-escapes the tailwind entry path', () => {
    const html = buildHarnessHtml(target, '/ace/node_modules/@tailwindcss/browser/"><script>alert(1)</script>');
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('entry embeds the module path, expected name, and the SAME resolution rule', () => {
    const entry = buildHarnessEntry(target);
    expect(entry).toContain('"/@fs/ws/questions/react-apps/demo/App.tsx"');
    expect(entry).toContain('const EXPECTED_NAME = "App"');
    // Single source of truth: the browser gets resolvePreviewExport verbatim.
    expect(entry).toContain('function resolvePreviewExport(');
    expect(entry).toContain('$$typeof');
    expect(entry).toContain('React.StrictMode');
    expect(entry).toContain('PreviewErrorBoundary');
    expect(entry).toContain("import.meta.hot.on('vite:afterUpdate'");
    // No JSX — the entry must need no transform of its own.
    expect(entry).not.toContain('</');
    // No fixture hint for this target (react-apps, App is self-sufficient).
    expect(entry).toContain('const FIXTURE_HINT = null');
  });

  // NEE-370: under tsx (`npm run ace`) ace's modules are esbuild-compiled
  // with keepNames, which injects `__name(...)` helper calls into function
  // bodies. resolvePreviewExport.toString() serializes those calls but NOT
  // the module-scoped helper, so the browser copy threw ReferenceError and
  // white-screened every preview. The entry ships a no-op shim; simulate
  // that runtime with real esbuild and execute the serialized copy the way
  // the browser does.
  it('embedded resolver survives a keepNames runtime (NEE-370 __name shim)', () => {
    const compiledModule = transformSync(
      `${resolvePreviewExport.toString()}\nreturn resolvePreviewExport;`,
      { loader: 'js', keepNames: true },
    ).code;
    const compiled = new Function(compiledModule)() as typeof resolvePreviewExport;
    const serialized = compiled.toString();
    // The hazard must be present in the simulation, or this test proves nothing.
    expect(serialized).toContain('__name(');

    const entry = buildHarnessEntry(target);
    const shim = entry.split('\n').find((line) => line.startsWith('var __name'));
    expect(shim).toBeDefined();
    const shimIdx = entry.indexOf(shim as string);
    expect(shimIdx).toBeGreaterThan(-1);
    expect(shimIdx).toBeLessThan(entry.indexOf('const resolvePreviewExport ='));

    const run = new Function(
      `${shim}\nconst f = ${serialized};\nreturn f({ default: () => null }, null);`,
    );
    expect(run()).toEqual({ ok: true, exportName: 'default' });
  });

  it('embeds and renders a non-null fixture hint (NEE-352)', () => {
    const entry = buildHarnessEntry({
      ...target,
      category: 'web-components',
      expectedName: 'Component',
      fixtureHint: 'No preview.tsx yet — add one in this question folder to preview with real props.',
    });
    expect(entry).toContain(
      'const FIXTURE_HINT = "No preview.tsx yet — add one in this question folder to preview with real props."',
    );
    expect(entry).toContain('function renderFixtureHint(');
    expect(entry).toContain('renderFixtureHint()');
  });

  // NEE-351: console/error forwarding to the parent window.
  describe('error/console forwarding', () => {
    const entry = buildHarnessEntry(target);

    it('forwards window.onerror, unhandledrejection, and every console level', () => {
      expect(entry).toContain("window.addEventListener('error'");
      expect(entry).toContain("window.addEventListener('unhandledrejection'");
      expect(entry).toContain("['log', 'warn', 'error']");
      expect(entry).toContain("acePreviewPost(kind, args.map(aceStringify).join(' '))");
    });

    it('forwards a caught render error from the error boundary too', () => {
      expect(entry).toContain('componentDidCatch(_error, info)');
      expect(entry).toContain("acePreviewPost('window-error', String((_error && _error.stack) || _error))");
    });

    it('forwards Vite transform/syntax failures (vite:error) with file/line', () => {
      expect(entry).toContain("import.meta.hot.on('vite:error'");
      expect(entry).toContain("acePreviewPost('vite-error', text,");
      expect(entry).toContain('loc.file');
      expect(entry).toContain('loc.line');
    });

    it('tags every forwarded message with the ace-preview source marker', () => {
      expect(entry).toContain("source: 'ace-preview'");
    });

    it('rate-limits the channel itself before a flood ever reaches postMessage', () => {
      expect(entry).toContain('ACE_MAX_MSGS_PER_SEC');
      expect(entry).toContain("kind: 'rate-limited'");
    });

    it('posts with a wildcard target origin (the receiving hook validates event.origin instead)', () => {
      // The iframe cannot know the parent's origin in general (any ace UI
      // port/token) — see ui/src/hooks/usePreviewConsole.ts for the
      // corresponding receive-side origin check.
      const postCalls = entry.match(/postMessage\(\s*\{[\s\S]*?\},\s*'\*'/g) ?? [];
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  // NEE-387: import-only entry (playground-ts) — executes the module for its
  // side effects, no react/root/export-resolution at all.
  describe('import-mode entry', () => {
    const importTarget: PreviewTarget = {
      category: 'playground-ts',
      slug: 'scratch-1',
      moduleFile: '/ws/questions/playground-ts/scratch-1/index.ts',
      expectedName: null,
      usesFixture: false,
      fixtureHint: null,
      mode: 'import',
    };
    const entry = buildHarnessEntry(importTarget);

    it('dynamically imports the module for side effects only', () => {
      expect(entry).toContain('"/@fs/ws/questions/playground-ts/scratch-1/index.ts"');
      expect(entry).toMatch(/import\(\s*"\/@fs\/ws\/questions\/playground-ts\/scratch-1\/index\.ts"\s*\)/);
    });

    it('carries the ace-preview forwarding marker and a vite:error handler', () => {
      expect(entry).toContain("source: 'ace-preview'");
      expect(entry).toContain("import.meta.hot.on('vite:error'");
    });

    it('has no react/createRoot/export-resolution machinery', () => {
      expect(entry).not.toContain('react-dom');
      expect(entry).not.toContain('createRoot');
      expect(entry).not.toContain('resolvePreviewExport');
      expect(entry).not.toContain('PreviewErrorBoundary');
      expect(entry).not.toContain("import.meta.hot.on('vite:afterUpdate'");
    });

    // Load-bearing ordering (NEE-387): a static import hoists above every
    // other statement, so if the module import ran before the console patch,
    // an early `console.log` in the question's code would never forward —
    // the feature would look silently dead. The dynamic `import(` call must
    // therefore appear LATER in the string than the console-patching line.
    it('patches console BEFORE dynamically importing the module (ordering is load-bearing)', () => {
      const consolePatchIdx = entry.indexOf('console[level] =');
      const importIdx = entry.indexOf('import(');
      expect(consolePatchIdx).toBeGreaterThan(-1);
      expect(importIdx).toBeGreaterThan(-1);
      expect(consolePatchIdx).toBeLessThan(importIdx);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: every corpus export shape served through a real Vite server
// ---------------------------------------------------------------------------

describe('harness over a real vite server', () => {
  function trackManager(m: PreviewManager): PreviewManager {
    cleanups.push(() => m.dispose());
    return m;
  }

  function makeCorpusWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-harness-int-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (rel: string, content: string) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    };
    // The three shapes the corpus actually contains (NEE-350) + a broken one.
    write(
      'questions/react-apps/default-app/App.tsx',
      "import React from 'react';\nexport default function App() { return <h1>a</h1>; }\n",
    );
    write(
      'questions/web-components/named-comp/Component.tsx',
      "import React from 'react';\nexport function Component() { return <h1>c</h1>; }\n",
    );
    write(
      'questions/react-apps/custom-name/App.tsx',
      "import React from 'react';\nexport function TodoBoard() { return <h1>t</h1>; }\n",
    );
    write('questions/web-components/no-export/Component.tsx', 'export const helper = 1;\n');
    write('questions/js-ts/algo/solution.ts', 'export const solve = () => 1;\n');
    // NEE-387: the import-mode (playground-ts) fixture.
    write(
      'questions/playground-ts/scratch-1/index.ts',
      "console.log('hello from the ts playground');\n",
    );
    fs.symlinkSync(ACE_NODE_MODULES, path.join(root, 'node_modules'));
    return root;
  }

  it('serves page + entry for all three export shapes and 404s the rest', async () => {
    const root = makeCorpusWorkspace();
    const manager = trackManager(createPreviewManager({ bus: createBus() }));
    const status = await manager.open(root);
    expect(status.state).toBe('ready');
    const url = status.url as string;

    for (const [category, slug] of [
      ['react-apps', 'default-app'],
      ['web-components', 'named-comp'],
      ['react-apps', 'custom-name'],
      // A question with no mountable export still gets a page — the message
      // ("Nothing to mount", naming what WAS found) renders at runtime.
      ['web-components', 'no-export'],
    ] as const) {
      const page = await fetch(url + previewPagePath(category, slug));
      expect(page.status, `${category}/${slug} page`).toBe(200);
      const html = await page.text();
      expect(html).toContain(previewEntryPath(category, slug));
      // plugin-react's refresh preamble proves transformIndexHtml ran.
      expect(html).toContain('/@react-refresh');

      const entry = await fetch(url + previewEntryPath(category, slug));
      expect(entry.status, `${category}/${slug} entry`).toBe(200);
      const js = await entry.text();
      expect(js).toContain('resolvePreviewExport');
      expect(js).toContain('questionModule');
      expect(js).toContain('StrictMode');
      // NEE-351: the served (post-transform) entry still carries the
      // forwarding wiring — proves Vite's transform doesn't strip it (quotes
      // may be normalised by esbuild, hence no exact string match here).
      expect(js).toContain('acePreviewPost');
      expect(js).toContain('ace-preview');
    }

    // The mounted question module itself is served and transformed.
    const realRoot = fs.realpathSync(root);
    const mod = await fetch(`${url}/@fs${realRoot}/questions/react-apps/default-app/App.tsx`);
    expect(mod.status).toBe(200);

    // Categories with preview: 'none' have nothing to preview.
    const jsTs = await fetch(url + previewPagePath('js-ts', 'algo'));
    expect(jsTs.status).toBe(404);
    expect(await jsTs.text()).toContain('not available for "js-ts"');

    // Unknown question under a react category.
    const missing = await fetch(url + previewPagePath('react-apps', 'nope'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('App.tsx');

    // NEE-387: the ts playground (import mode) gets a page + entry too, but
    // an entry with none of the mount-mode machinery.
    const tsPage = await fetch(url + previewPagePath('playground-ts', 'scratch-1'));
    expect(tsPage.status).toBe(200);
    const tsHtml = await tsPage.text();
    expect(tsHtml).toContain(previewEntryPath('playground-ts', 'scratch-1'));

    const tsEntry = await fetch(url + previewEntryPath('playground-ts', 'scratch-1'));
    expect(tsEntry.status).toBe(200);
    const tsJs = await tsEntry.text();
    expect(tsJs).toContain('acePreviewPost');
    expect(tsJs).toContain('ace-preview');
    expect(tsJs).not.toContain('resolvePreviewExport');
    expect(tsJs).not.toContain('StrictMode');
  }, 30_000);

  // NEE-352: preview.tsx fixture — mounted instead of the bare (often
  // unimplemented/throwing) solution file, with a hint when it's absent.
  it('mounts preview.tsx when present, hints when absent, both for the SAME web-components question', async () => {
    const root = makeCorpusWorkspace();
    const withFixtureDir = path.join(root, 'questions', 'web-components', 'with-fixture');
    fs.mkdirSync(withFixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(withFixtureDir, 'Component.tsx'),
      "import React from 'react';\nexport function Widget(props) { throw new Error('not implemented'); }\n",
    );
    const fixturePath = path.join(withFixtureDir, 'preview.tsx');
    fs.writeFileSync(
      fixturePath,
      "import React from 'react';\nimport { Widget } from './Component';\nexport default function Preview() { return React.createElement('div', null, 'v1'); }\n",
    );

    const manager = trackManager(createPreviewManager({ bus: createBus() }));
    const status = await manager.open(root);
    expect(status.state).toBe('ready');
    const url = status.url as string;
    const realRoot = fs.realpathSync(root);

    // 1. named-comp (from makeCorpusWorkspace) has NO preview.tsx — the
    // entry carries the fixture hint for the pane to render, and mounts the
    // bare Component.tsx.
    const bareEntry = await (await fetch(url + previewEntryPath('web-components', 'named-comp'))).text();
    expect(bareEntry).toContain('No preview.tsx yet');
    // Vite's import-analysis rewrites in-root /@fs paths to root-relative
    // ones, so assert on the filename rather than the exact /@fs<root> form.
    expect(bareEntry).toMatch(/questionModule from ["'][^"']*named-comp\/Component\.tsx["']/);

    // 2. with-fixture mounts preview.tsx, NOT the (throwing) Component.tsx —
    // and carries no hint, since the fixture already provides the props.
    const fixtureEntry = await (
      await fetch(url + previewEntryPath('web-components', 'with-fixture'))
    ).text();
    expect(fixtureEntry).toMatch(/questionModule from ["'][^"']*with-fixture\/preview\.tsx["']/);
    expect(fixtureEntry).not.toContain('Component.tsx');
    expect(fixtureEntry).toContain('const FIXTURE_HINT = null');

    // 3. The fixture module is served/transformed like any other question
    // file (no special virtual bypass) — fetch it once for v1...
    const modUrl = `${url}/@fs${realRoot}/questions/web-components/with-fixture/preview.tsx`;
    const v1 = await (await fetch(modUrl)).text();
    expect(v1).toContain('v1');

    // ...then edit it on disk, exactly as a live user edit would, and
    // re-fetch: it must reflect the change through the SAME file-watching
    // pipeline every other question file already uses (not assumed — this is
    // the "verify, do not assume" NEE-352 calls for). Poll instead of a fixed
    // sleep since the watcher's propagation delay isn't guaranteed.
    fs.writeFileSync(
      fixturePath,
      "import React from 'react';\nimport { Widget } from './Component';\nexport default function Preview() { return React.createElement('div', null, 'v2-edited'); }\n",
    );
    const deadline = Date.now() + 10_000;
    let v2 = '';
    while (Date.now() < deadline) {
      v2 = await (await fetch(modUrl)).text();
      if (v2.includes('v2-edited')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(v2).toContain('v2-edited');
    expect(v2).not.toContain('>v1<');
  }, 30_000);
});
