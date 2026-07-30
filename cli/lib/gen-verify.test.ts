import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyGeneratedQuestion } from './gen-verify.js';
import { renderSolutionStub } from './scaffold.js';

// Integration tests: real vitest runs in a sandbox under this repo's
// .ace/tmp/ (the repo root has vitest, happy-dom, jest-dom, and a
// vitest.setup.ts — exactly the workspace layout ace init produces).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SIGNATURE = 'export function add(a: number, b: number): number';

const REFERENCE_SOLUTION = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const GOOD_TESTS = `import { describe, expect, it } from 'vitest';
import { add } from './solution';

describe('add', () => {
  it('adds two positives', () => {
    // 1 + 2 = 3
    expect(add(1, 2)).toBe(3);
  });
  it('adds negatives', () => {
    // -4 + 1 = -3
    expect(add(-4, 1)).toBe(-3);
  });
});
`;

const WRONG_EXPECTATION_TESTS = `import { describe, expect, it } from 'vitest';
import { add } from './solution';

describe('add', () => {
  it('adds two positives', () => {
    expect(add(1, 2)).toBe(4); // wrong on purpose
  });
});
`;

const NO_TESTS_FILE = `// intentionally contains no test cases
export {};
`;

const VACUOUS_TESTS = `import { describe, expect, it } from 'vitest';
import { add } from './solution';

describe('add', () => {
  it('exists', () => {
    expect(typeof add).toBe('function');
  });
});
`;

const stub = () => renderSolutionStub('js-ts', 'solution.ts', { signature: SIGNATURE });

describe('verifyGeneratedQuestion (fail-loud backstop)', () => {
  it('throws for a category with no solution/test files to verify (testFiles: [])', async () => {
    // behavioral (like design) declares testFiles: [] — there is nothing to
    // run, so this must throw synchronously rather than silently no-op or
    // report a false green.
    await expect(
      verifyGeneratedQuestion(REPO_ROOT, 'behavioral', {
        referenceSolution: '',
        testCode: '',
        stubSolution: '',
      }),
    ).rejects.toThrow(/no solution\/test files to verify/);
  });
});

describe('verifyGeneratedQuestion (integration, real vitest)', () => {
  it(
    'returns green for a correct reference + failing-on-stub suite',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'js-ts', {
        referenceSolution: REFERENCE_SOLUTION,
        testCode: GOOD_TESTS,
        stubSolution: stub(),
      });
      expect(result.failureReport).toBeNull();
      expect(result.green).toBe(true);
      expect(result.summary?.total).toBe(2);
      expect(result.summary?.passed).toBe(2);
    },
    120_000,
  );

  it(
    'returns red with a useful per-test report when a test fails against the reference',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'js-ts', {
        referenceSolution: REFERENCE_SOLUTION,
        testCode: WRONG_EXPECTATION_TESTS,
        stubSolution: stub(),
      });
      expect(result.green).toBe(false);
      expect(result.failureReport).toContain('✕');
      expect(result.failureReport).toContain('adds two positives');
    },
    120_000,
  );

  it(
    'returns red when the test file contains no tests',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'js-ts', {
        referenceSolution: REFERENCE_SOLUTION,
        testCode: NO_TESTS_FILE,
        stubSolution: stub(),
      });
      expect(result.green).toBe(false);
      expect(result.failureReport).toBeTruthy();
    },
    120_000,
  );

  it(
    'returns red when the suite also passes against the unimplemented stub',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'js-ts', {
        referenceSolution: REFERENCE_SOLUTION,
        testCode: VACUOUS_TESTS,
        stubSolution: stub(),
      });
      expect(result.green).toBe(false);
      expect(result.failureReport).toContain('stub');
    },
    120_000,
  );

  it(
    'returns red (never green) when the starter stub itself fails to compile',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'js-ts', {
        referenceSolution: REFERENCE_SOLUTION,
        testCode: GOOD_TESTS,
        stubSolution: 'export function add(a: number { // broken on purpose\n',
      });
      expect(result.green).toBe(false);
      expect(result.failureReport).toContain('stub');
    },
    120_000,
  );

  it(
    'surfaces the load error when the reference solution fails to compile',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'js-ts', {
        referenceSolution: 'export function add(a: number { // broken on purpose\n',
        testCode: GOOD_TESTS,
        stubSolution: stub(),
      });
      expect(result.green).toBe(false);
      expect(result.failureReport).toContain('failed to load');
    },
    120_000,
  );
});

// react-apps' supportCode contract: a real fake-backend module (`api.ts`)
// shared by the app and the tests. App.tsx imports data ONLY from './api' —
// never fetch — so a real run here also proves the support-file write path
// in verifyGeneratedQuestion actually wires the module in, not just that the
// react/happy-dom toolchain works (js-ts's tests above already cover that).
const REACT_APPS_SUPPORT_CODE = `export interface Item {
  id: number;
  name: string;
}

const FIXTURES: Item[] = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Beta' },
];

// Latency via setTimeout (not an already-resolved promise) so
// vi.advanceTimersByTimeAsync controls exactly when this settles.
export function fetchItems(): Promise<Item[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(FIXTURES), 10);
  });
}
`;

const REACT_APPS_SIGNATURE = `import React from 'react';
import { fetchItems, type Item } from './api';

export default function App() {
  // TODO: implement
  return <div>TODO</div>;
}
`;

const REACT_APPS_REFERENCE = `import React, { useEffect, useState } from 'react';
import { fetchItems, type Item } from './api';

export default function App() {
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    fetchItems().then(setItems);
  }, []);

  if (items === null) {
    return <p>Loading…</p>;
  }

  return (
    <ul aria-label="items">
      {items.map((item) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}
`;

const REACT_APPS_TESTS = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import App from './App';

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a loading state, then the fetched items', async () => {
    render(<App />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await advance(10); // api.ts's fetchItems latency
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});
`;

describe('verifyGeneratedQuestion (react-apps support module, integration)', () => {
  it(
    'writes the support module once and passes vs the reference App+api pair, fails vs the starter stub',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'react-apps', {
        referenceSolution: REACT_APPS_REFERENCE,
        testCode: REACT_APPS_TESTS,
        stubSolution: renderSolutionStub('react-apps', 'App.tsx', {
          signature: REACT_APPS_SIGNATURE,
        }),
        supportCode: REACT_APPS_SUPPORT_CODE,
      });
      expect(result.failureReport).toBeNull();
      expect(result.green).toBe(true);
      expect(result.summary?.total).toBe(1);
      expect(result.summary?.passed).toBe(1);
    },
    120_000,
  );

  it(
    'without supportCode, ./api has nothing to resolve to — the write path is exercised, not assumed',
    async () => {
      const result = await verifyGeneratedQuestion(REPO_ROOT, 'react-apps', {
        referenceSolution: REACT_APPS_REFERENCE,
        testCode: REACT_APPS_TESTS,
        stubSolution: renderSolutionStub('react-apps', 'App.tsx', {
          signature: REACT_APPS_SIGNATURE,
        }),
        // supportCode omitted on purpose.
      });
      expect(result.green).toBe(false);
      expect(result.failureReport).toBeTruthy();
    },
    120_000,
  );
});
