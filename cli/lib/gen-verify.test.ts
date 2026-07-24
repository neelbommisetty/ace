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
