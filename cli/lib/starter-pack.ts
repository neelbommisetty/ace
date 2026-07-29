import fs from 'node:fs';
import path from 'node:path';
import type { CategorySlug } from './categories.js';
import { getImportMetaDirname } from './import-meta.js';
import { getQuestionsDir } from './paths.js';

/**
 * The hand-authored questions bundled with the package (NEE-301), so a fresh
 * `ace init` + `ace ui` lands on a Library you can practise in with no API key
 * and no paid generation.
 *
 * This manifest — NOT a directory scan — is the source of truth for what gets
 * copied. The pack lives in the repo's own `questions/` tree (which is also
 * what `package.json` "files" publishes), and that tree is a plausible place
 * for a contributor to leave a scratch question; walking the manifest means
 * such a stray directory can never end up in someone else's workspace.
 *
 * `cli/lib/starter-pack.test.ts` keeps this list and the on-disk tree honest.
 */
export interface StarterQuestion {
  category: CategorySlug;
  slug: string;
  title: string;
}

export const STARTER_PACK: readonly StarterQuestion[] = [
  { category: 'js-ts', slug: 'debounce-with-cancel', title: 'Debounce with Cancel and Flush' },
  { category: 'leetcode-algo', slug: 'best-revenue-window', title: 'Best Revenue Window' },
  {
    category: 'leetcode-ds',
    slug: 'lru-cache',
    title: 'LRU Cache with Peek and Eviction Order',
  },
  { category: 'web-components', slug: 'star-rating', title: 'Accessible Star Rating' },
  { category: 'react-apps', slug: 'task-board', title: 'Sprint Task Board' },
  { category: 'design-fe', slug: 'infinite-news-feed', title: 'Infinite News Feed' },
];

/**
 * Absolute path of the packaged `questions/` tree.
 *
 * Two candidates because this module runs from two layouts: `cli/lib/` in the
 * repo (and under tsx), and `dist/cli/lib/` in the published package, where
 * `questions/` sits at the package root — one level further up.
 *
 * `ACE_STARTER_PACK_DIR` overrides both; it exists so tests can point at a
 * fixture pack without shipping test data inside the real one.
 */
export function getStarterPackDir(): string {
  const override = process.env.ACE_STARTER_PACK_DIR;
  if (override) return path.resolve(override);

  const here = getImportMetaDirname(import.meta);
  const candidates = [
    path.resolve(here, '..', '..', 'questions'), // <repo>/cli/lib -> <repo>/questions
    path.resolve(here, '..', '..', '..', 'questions'), // dist/cli/lib -> <pkg>/questions
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export interface StarterPackResult {
  /** "<category>/<slug>" ids copied by this call. */
  installed: string[];
  /** Ids whose destination directory already existed and was left untouched. */
  skipped: string[];
  /** Ids missing from the packaged tree — a broken install, not a user error. */
  unavailable: string[];
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Copies the starter pack into `<workspaceRoot>/questions/`.
 *
 * Idempotent by construction: a question whose destination directory already
 * exists is skipped whole, never merged into and never overwritten — so a
 * second call cannot duplicate a question or clobber work in progress. Nothing
 * here touches the database; callers reconcile afterwards.
 */
export function copyStarterPack(workspaceRoot: string): StarterPackResult {
  const packDir = getStarterPackDir();
  const questionsDir = getQuestionsDir(workspaceRoot);
  const result: StarterPackResult = { installed: [], skipped: [], unavailable: [] };

  for (const { category, slug } of STARTER_PACK) {
    const id = `${category}/${slug}`;
    const src = path.join(packDir, category, slug);
    if (!fs.existsSync(src)) {
      result.unavailable.push(id);
      continue;
    }
    const dest = path.join(questionsDir, category, slug);
    if (fs.existsSync(dest)) {
      result.skipped.push(id);
      continue;
    }
    copyDirRecursive(src, dest);
    result.installed.push(id);
  }

  return result;
}
