import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCategoryConfig, getSuggestedTime, hasTests } from './categories.js';
import { getQuestionsDir } from './paths.js';
import { STARTER_PACK, copyStarterPack, getStarterPackDir } from './starter-pack.js';

// The starter pack's own vitest suites are NOT part of this repo's test run —
// vitest.config.ts only includes cli/** and ui/**, and those suites are meant
// to be red until a user implements the stubs. What IS covered here is that
// the shipped tree matches the manifest, matches each category's file layout,
// and carries the metadata the reconciler parses out of README.md. (The stub
// and test sources themselves are type-checked by the root tsconfig, whose
// `include` covers questions/**.)

const packDir = getStarterPackDir();

const tempRoots: string[] = [];

function makeWorkspaceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-starter-pack-'));
  fs.mkdirSync(path.join(root, 'questions'), { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('starter pack contents', () => {
  it('resolves to a directory that actually exists', () => {
    expect(fs.existsSync(packDir)).toBe(true);
  });

  it('covers a spread of categories and difficulties', () => {
    const categories = new Set(STARTER_PACK.map((q) => q.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
    // A design question exercises the notes.md / no-test layout.
    expect(STARTER_PACK.some((q) => !hasTests(getCategoryConfig(q.category)))).toBe(true);
  });

  it.each(STARTER_PACK.map((q) => [`${q.category}/${q.slug}`, q] as const))(
    '%s ships the files its category prescribes',
    (_id, question) => {
      const dir = path.join(packDir, question.category, question.slug);
      const config = getCategoryConfig(question.category);

      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
      for (const file of [...config.solutionFiles, ...config.testFiles]) {
        expect(fs.existsSync(path.join(dir, file))).toBe(true);
      }
      if (!hasTests(config)) {
        // Design/behavioral questions carry a prose file and no test file.
        expect(config.testFiles).toEqual([]);
      } else {
        expect(config.testFiles.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(STARTER_PACK.map((q) => [`${q.category}/${q.slug}`, q] as const))(
    '%s carries the README metadata the reconciler parses',
    (_id, question) => {
      const readme = fs.readFileSync(
        path.join(packDir, question.category, question.slug, 'README.md'),
        'utf8',
      );

      // Same three reads as cli/server/reconciler.ts.
      expect(readme.match(/^#\s+(.+)$/m)?.[1].trim()).toBe(question.title);

      const difficulty = readme.match(/^\*\*Difficulty:\*\*\s*(easy|medium|hard)\s*$/im)?.[1];
      expect(difficulty).toBeDefined();

      const minutes = readme.match(/^\*\*Suggested Time:\*\*\s*~?(\d+)\s*minutes?\s*$/im)?.[1];
      // The stated time must be the category/difficulty default, so the
      // Library's estimate matches what a generated question would show.
      expect(Number(minutes)).toBe(
        getSuggestedTime(question.category, difficulty as 'easy' | 'medium' | 'hard'),
      );
    },
  );

  it('ships a hidden reference solution for every coding question', () => {
    for (const question of STARTER_PACK) {
      if (!hasTests(getCategoryConfig(question.category))) continue;
      const reference = path.join(packDir, question.category, question.slug, '.reference.md');
      expect(fs.existsSync(reference)).toBe(true);
    }
  });
});

describe('copyStarterPack', () => {
  it('copies every question, dotfiles included', () => {
    const root = makeWorkspaceRoot();

    const result = copyStarterPack(root);

    expect(result.unavailable).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.installed).toEqual(STARTER_PACK.map((q) => `${q.category}/${q.slug}`));

    for (const question of STARTER_PACK) {
      const dir = path.join(getQuestionsDir(root), question.category, question.slug);
      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
      if (hasTests(getCategoryConfig(question.category))) {
        // Dotfiles are easy to lose in a naive copy; the debrief needs this one.
        expect(fs.existsSync(path.join(dir, '.reference.md'))).toBe(true);
      }
    }
  });

  it('is idempotent: a second call installs nothing and rewrites nothing', () => {
    const root = makeWorkspaceRoot();
    copyStarterPack(root);

    const first = STARTER_PACK[0];
    const solutionPath = path.join(
      getQuestionsDir(root),
      first.category,
      first.slug,
      getCategoryConfig(first.category).solutionFiles[0],
    );
    fs.writeFileSync(solutionPath, '// my work in progress\n', 'utf8');

    const second = copyStarterPack(root);

    expect(second.installed).toEqual([]);
    expect(second.skipped).toEqual(STARTER_PACK.map((q) => `${q.category}/${q.slug}`));
    // Re-adding must never clobber a partially solved question.
    expect(fs.readFileSync(solutionPath, 'utf8')).toBe('// my work in progress\n');
  });

  it('installs only the questions that are still missing', () => {
    const root = makeWorkspaceRoot();
    copyStarterPack(root);
    const dropped = STARTER_PACK[1];
    fs.rmSync(path.join(getQuestionsDir(root), dropped.category, dropped.slug), {
      recursive: true,
      force: true,
    });

    const result = copyStarterPack(root);

    expect(result.installed).toEqual([`${dropped.category}/${dropped.slug}`]);
    expect(result.skipped).toHaveLength(STARTER_PACK.length - 1);
  });

  it('reports questions missing from a broken pack instead of throwing', () => {
    const root = makeWorkspaceRoot();
    const emptyPack = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-empty-pack-'));
    tempRoots.push(emptyPack);
    const previous = process.env.ACE_STARTER_PACK_DIR;
    process.env.ACE_STARTER_PACK_DIR = emptyPack;

    try {
      const result = copyStarterPack(root);
      expect(result.installed).toEqual([]);
      expect(result.unavailable).toEqual(STARTER_PACK.map((q) => `${q.category}/${q.slug}`));
    } finally {
      if (previous === undefined) delete process.env.ACE_STARTER_PACK_DIR;
      else process.env.ACE_STARTER_PACK_DIR = previous;
    }
  });
});
