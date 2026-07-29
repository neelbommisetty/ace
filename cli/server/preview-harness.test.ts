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
    return qdir;
  }

  it('derives the expected export name from the category solution file', () => {
    const qdir = makeQuestions();
    const app = resolvePreviewTarget(qdir, 'react-apps', 'demo');
    expect(app).toMatchObject({
      ok: true,
      target: { expectedName: 'App', moduleFile: path.join(qdir, 'react-apps', 'demo', 'App.tsx') },
    });
    const comp = resolvePreviewTarget(qdir, 'web-components', 'widget');
    expect(comp).toMatchObject({ ok: true, target: { expectedName: 'Component' } });
  });

  it('rejects non-react categories, unknown categories, and missing questions', () => {
    const qdir = makeQuestions();
    const jsTs = resolvePreviewTarget(qdir, 'js-ts', 'anything');
    expect(jsTs).toMatchObject({ ok: false });
    if (jsTs.ok) throw new Error('unreachable');
    expect(jsTs.reason).toContain('only available for React categories');

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
  const target = {
    category: 'react-apps',
    slug: 'demo',
    moduleFile: '/ws/questions/react-apps/demo/App.tsx',
    expectedName: 'App',
  };

  it('html mounts the entry module and nothing else', () => {
    const html = buildHarnessHtml(target);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(`src="${previewEntryPath('react-apps', 'demo')}"`);
    expect(html).toContain('color-scheme:light dark');
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
    }

    // The mounted question module itself is served and transformed.
    const realRoot = fs.realpathSync(root);
    const mod = await fetch(`${url}/@fs${realRoot}/questions/react-apps/default-app/App.tsx`);
    expect(mod.status).toBe(200);

    // Non-react categories have nothing to preview.
    const jsTs = await fetch(url + previewPagePath('js-ts', 'algo'));
    expect(jsTs.status).toBe(404);
    expect(await jsTs.text()).toContain('only available for React categories');

    // Unknown question under a react category.
    const missing = await fetch(url + previewPagePath('react-apps', 'nope'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('App.tsx');
  }, 30_000);
});
