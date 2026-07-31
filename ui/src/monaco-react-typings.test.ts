import { describe, expect, it } from 'vitest';
import { API, type Diagnostic } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';

import { MODULE_RESOLUTION_NOISE, REACT_TYPE_LIBS } from './monaco-react-typings';

// Semantic proof the browser can't give us in CI-less local verification:
// type-check real room-shaped sources against the exact .d.ts payload monaco
// ships, over a virtual filesystem that contains ONLY the REACT_TYPE_LIBS
// entries at their virtual paths (plus the sample under test). The compiler
// options mirror monaco.ts's setCompilerOptions, with one forced deviation:
// monaco's bundled TS 5.x uses ModuleResolutionKind.NodeJs, which typescript
// 7 removed (error 5108) — `bundler` resolves this package-json-less layout
// identically (directory → index.d.ts, extensionless subpath → .d.ts).
function semanticDiagnostics(fileName: string, source: string): readonly Diagnostic[] {
  const tsconfig = JSON.stringify({
    compilerOptions: {
      jsx: 'react-jsx',
      target: 'esnext',
      moduleResolution: 'bundler',
      allowSyntheticDefaultImports: true,
      // monaco's worker defaults are non-strict; strictness would invent
      // diagnostics (implicit any, strict null checks) the room never shows.
      strict: false,
      noEmit: true,
      lib: ['esnext', 'dom'],
      // monaco's worker does no automatic @types discovery — every lib it
      // sees is an explicitly registered extraLib, mirrored here as roots.
      types: [],
    },
    files: [fileName, ...REACT_TYPE_LIBS.map((lib) => lib.path)],
  });
  const files: Record<string, string> = { '/tsconfig.json': tsconfig, [fileName]: source };
  for (const lib of REACT_TYPE_LIBS) {
    files[lib.path] = lib.content;
  }
  const api = new API({ fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: ['/tsconfig.json'] });
    const project = snapshot.getProject('/tsconfig.json');
    if (project == null) throw new Error('virtual tsconfig project failed to load');
    // A config/program-level diagnostic (bad option, unreadable lib) would
    // silently weaken every assertion below — surface it instead.
    const programDiags = [
      ...project.program.getConfigFileParsingDiagnostics(),
      ...project.program.getProgramDiagnostics(),
    ];
    if (programDiags.length > 0) {
      throw new Error(`program diagnostics: ${programDiags.map((d) => `TS${d.code} ${d.text}`).join('; ')}`);
    }
    return project.program.getSemanticDiagnostics(fileName);
  } finally {
    api.close();
  }
}

function flatten(diag: Diagnostic): string {
  return [diag.text, ...(diag.messageChain ?? []).map(flatten)].join(' ');
}

function outsideNoise(diags: readonly Diagnostic[]): Diagnostic[] {
  return diags.filter((d) => !MODULE_RESOLUTION_NOISE.includes(d.code));
}

// Readable failure output: code + full flattened message per diagnostic.
function describeDiags(diags: readonly Diagnostic[]): string[] {
  return diags.map((d) => `TS${d.code}: ${flatten(d)}`);
}

describe('REACT_TYPE_LIBS', () => {
  it('flags onclick on a <button> in a .tsx solution (typed JSX, not any)', () => {
    const diags = semanticDiagnostics(
      '/src/App.tsx',
      `import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onclick={() => setCount(count + 1)}>{count}</button>;
}
`,
    );
    const real = outsideNoise(diags);
    expect(describeDiags(real)).not.toEqual([]);
    expect(real.some((d) => flatten(d).includes("'onclick'"))).toBe(true);
  });

  it('checks a correct .tsx solution clean — the shipped .d.ts set is self-consistent', () => {
    const diags = semanticDiagnostics(
      '/src/App.tsx',
      `import { useState } from 'react';
import { createRoot } from 'react-dom/client';

export function App() {
  const [count, setCount] = useState<number>(0);
  return (
    <div className="counter">
      <button onClick={() => setCount(count + 1)}>{count}</button>
    </div>
  );
}

export function mount(el: HTMLElement) {
  createRoot(el).render(<App />);
}
`,
    );
    expect(describeDiags(outsideNoise(diags))).toEqual([]);
  });

  it('keeps a test file squiggle-free — vitest/@testing-library stay unresolved by design', () => {
    const diags = semanticDiagnostics(
      '/src/App.test.tsx',
      `import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

describe('App', () => {
  it('increments on click', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('1');
  });
});
`,
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(describeDiags(outsideNoise(diags))).toEqual([]);
  });

  it('leaves a plain .ts file untouched — js-ts questions are unaffected', () => {
    const diags = semanticDiagnostics(
      '/src/group-by.ts',
      `export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    (out[key(item)] ??= []).push(item);
  }
  return out;
}

console.log(groupBy([1, 2, 3], (n) => (n % 2 === 0 ? 'even' : 'odd')));
`,
    );
    expect(describeDiags(diags)).toEqual([]);
  });
});

describe('MODULE_RESOLUTION_NOISE', () => {
  it('no longer suppresses the JSX-runtime/JSX-any codes real typings turned into signal', () => {
    expect(MODULE_RESOLUTION_NOISE).not.toContain(2875);
    expect(MODULE_RESOLUTION_NOISE).not.toContain(7026);
  });
});
