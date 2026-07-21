import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldQuestion, scaffoldQuestionAt } from './scaffold.js';

let tempRoot = '';
let otherCwdWorkspace = '';
let originalCwd = '';

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-scaffold-'));
  fs.mkdirSync(path.join(root, 'questions'), { recursive: true });
  return root;
}

beforeEach(() => {
  originalCwd = process.cwd();
  tempRoot = createWorkspace();
  otherCwdWorkspace = createWorkspace();
  process.chdir(otherCwdWorkspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of [tempRoot, otherCwdWorkspace]) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('scaffoldQuestionAt', () => {
  it('writes coding-question files under the GIVEN root, ignoring process.cwd()', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Two Sum',
      slug: 'two-sum',
      category: 'js-ts',
      difficulty: 'hard',
      description: 'Find indices adding to target.',
    });

    const expectedDir = path.join(tempRoot, 'questions', 'js-ts', 'two-sum');
    expect(result.dir).toBe(expectedDir);
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'solution.ts'))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'solution.test.ts'))).toBe(true);
    expect(result.files.sort()).toEqual(['README.md', 'solution.test.ts', 'solution.ts']);

    // Nothing should have been written under the cwd workspace.
    expect(fs.existsSync(path.join(otherCwdWorkspace, 'questions', 'js-ts'))).toBe(false);

    const readme = fs.readFileSync(path.join(expectedDir, 'README.md'), 'utf-8');
    expect(readme).toContain('**Difficulty:** hard');
  });

  it('writes design-question files (notes.md, no solution/test files)', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Infinite Scroll',
      slug: 'infinite-scroll',
      category: 'design-fe',
      difficulty: 'medium',
      description: 'Design an infinite scroll component.',
    });

    const expectedDir = path.join(tempRoot, 'questions', 'design-fe', 'infinite-scroll');
    expect(result.dir).toBe(expectedDir);
    expect(result.files.sort()).toEqual(['README.md', 'notes.md']);
    expect(fs.existsSync(path.join(expectedDir, 'notes.md'))).toBe(true);
  });

  it('writeScorecard: false (default) leaves no scorecard.json', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Debounce',
      slug: 'debounce',
      category: 'js-ts',
      difficulty: 'easy',
      description: 'Implement debounce.',
    });

    expect(fs.existsSync(path.join(result.dir, 'scorecard.json'))).toBe(false);
    expect(result.files).not.toContain('scorecard.json');
  });

  it('writeScorecard: true puts scorecard.json under the PASSED root, not cwd', () => {
    const result = scaffoldQuestionAt(
      tempRoot,
      {
        title: 'Throttle',
        slug: 'throttle',
        category: 'js-ts',
        difficulty: 'medium',
        description: 'Implement throttle.',
      },
      { writeScorecard: true },
    );

    const scorecardPath = path.join(result.dir, 'scorecard.json');
    expect(fs.existsSync(scorecardPath)).toBe(true);
    expect(result.files).toContain('scorecard.json');

    // cwd points at a *different*, also-valid workspace — scorecard must not
    // land there.
    expect(
      fs.existsSync(path.join(otherCwdWorkspace, 'questions', 'js-ts', 'throttle', 'scorecard.json')),
    ).toBe(false);

    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8'));
    expect(scorecard.title).toBe('Throttle');
    expect(scorecard.difficulty).toBe('medium');
  });

  it('throws when the question dir already exists', () => {
    scaffoldQuestionAt(tempRoot, {
      title: 'Dup',
      slug: 'dup',
      category: 'js-ts',
      difficulty: 'easy',
      description: 'First.',
    });

    expect(() =>
      scaffoldQuestionAt(tempRoot, {
        title: 'Dup Again',
        slug: 'dup',
        category: 'js-ts',
        difficulty: 'easy',
        description: 'Second.',
      }),
    ).toThrow(/already exists/);
  });
});

describe('scaffoldQuestion (legacy cwd-resolving wrapper)', () => {
  it('scaffolds under process.cwd() and always writes a scorecard', () => {
    process.chdir(tempRoot);
    const dir = scaffoldQuestion({
      title: 'Legacy Path',
      slug: 'legacy-path',
      category: 'leetcode-algo',
      difficulty: 'easy',
      description: 'Legacy behavior check.',
    });

    expect(fs.realpathSync(dir)).toBe(
      fs.realpathSync(path.join(tempRoot, 'questions', 'leetcode-algo', 'legacy-path')),
    );
    expect(fs.existsSync(path.join(dir, 'scorecard.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  });
});
