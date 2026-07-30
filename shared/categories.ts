/**
 * Category configuration shared by cli/ and ui/ (NEE-284).
 *
 * Single source of truth for the category table: slugs, display names, hints,
 * suggested times, and scaffold file layout. `cli/lib/categories.ts` re-exports
 * this module for the server/CLI side; the SPA imports it via the `@shared`
 * alias. Internal imports here use `.js` extensions (NodeNext-style) — Vite
 * and `moduleResolution: bundler` both resolve them fine.
 */

export type CategorySlug =
  | 'js-ts'
  | 'web-components'
  | 'react-apps'
  | 'leetcode-ds'
  | 'leetcode-algo'
  | 'design-fe'
  | 'design-be'
  | 'design-full'
  | 'behavioral';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type QuestionType = 'coding' | 'design' | 'behavioral';

export type CategoryGroup = 'react' | 'js-ts' | 'leetcode' | 'design' | 'behavioral';

export interface CategoryConfig {
  slug: CategorySlug;
  name: string;
  shortName: string;
  hint: string;
  type: QuestionType;
  group: CategoryGroup;
  suggestedTimes: Record<Difficulty, number>;
  solutionFiles: string[];
  testFiles: string[];
  /** LLM-authored read-only support code (e.g. a fake API module) shared by the solution, tests, and the live preview. */
  supportFiles: string[];
  templateDir: string;
}

export const CATEGORIES: Record<CategorySlug, CategoryConfig> = {
  'js-ts': {
    slug: 'js-ts',
    name: 'JS/TS Puzzles',
    shortName: 'JS/TS',
    hint: 'Closures, async patterns, type utilities',
    type: 'coding',
    group: 'js-ts',
    suggestedTimes: { easy: 15, medium: 30, hard: 45 },
    solutionFiles: ['solution.ts'],
    testFiles: ['solution.test.ts'],
    supportFiles: [],
    templateDir: 'js-ts',
  },
  'web-components': {
    slug: 'web-components',
    name: 'React Components',
    shortName: 'Components',
    hint: 'Props, events, composition, reusable UI',
    type: 'coding',
    group: 'react',
    suggestedTimes: { easy: 20, medium: 35, hard: 50 },
    solutionFiles: ['Component.tsx'],
    testFiles: ['Component.test.tsx'],
    supportFiles: [],
    templateDir: 'web-components',
  },
  'react-apps': {
    slug: 'react-apps',
    name: 'React Web Apps',
    shortName: 'React App',
    hint: 'Hooks, state, routing, full features',
    type: 'coding',
    group: 'react',
    suggestedTimes: { easy: 25, medium: 45, hard: 60 },
    solutionFiles: ['App.tsx'],
    testFiles: ['App.test.tsx'],
    supportFiles: ['api.ts'],
    templateDir: 'react-apps',
  },
  'leetcode-ds': {
    slug: 'leetcode-ds',
    name: 'LeetCode Data Structures',
    shortName: 'LC-DS',
    hint: 'Trees, graphs, heaps, hash maps',
    type: 'coding',
    group: 'leetcode',
    suggestedTimes: { easy: 15, medium: 30, hard: 45 },
    solutionFiles: ['solution.ts'],
    testFiles: ['solution.test.ts'],
    supportFiles: [],
    templateDir: 'leetcode-ds',
  },
  'leetcode-algo': {
    slug: 'leetcode-algo',
    name: 'LeetCode Algorithms',
    shortName: 'LC-Algo',
    hint: 'DP, greedy, two pointers, sorting',
    type: 'coding',
    group: 'leetcode',
    suggestedTimes: { easy: 15, medium: 30, hard: 45 },
    solutionFiles: ['solution.ts'],
    testFiles: ['solution.test.ts'],
    supportFiles: [],
    templateDir: 'leetcode-algo',
  },
  'design-fe': {
    slug: 'design-fe',
    name: 'System Design — Frontend',
    shortName: 'Design-FE',
    hint: 'Component architecture, state, rendering',
    type: 'design',
    group: 'design',
    suggestedTimes: { easy: 25, medium: 40, hard: 55 },
    solutionFiles: ['notes.md'],
    testFiles: [],
    supportFiles: [],
    templateDir: 'design',
  },
  'design-be': {
    slug: 'design-be',
    name: 'System Design — Backend',
    shortName: 'Design-BE',
    hint: 'APIs, databases, caching, queues',
    type: 'design',
    group: 'design',
    suggestedTimes: { easy: 25, medium: 40, hard: 55 },
    solutionFiles: ['notes.md'],
    testFiles: [],
    supportFiles: [],
    templateDir: 'design',
  },
  'design-full': {
    slug: 'design-full',
    name: 'System Design — Full Stack',
    shortName: 'Design-Full',
    hint: 'End-to-end systems, trade-offs',
    type: 'design',
    group: 'design',
    suggestedTimes: { easy: 30, medium: 45, hard: 60 },
    solutionFiles: ['notes.md'],
    testFiles: [],
    supportFiles: [],
    templateDir: 'design',
  },
  behavioral: {
    slug: 'behavioral',
    name: 'Behavioral',
    shortName: 'Behavioral',
    hint: 'Conflict, failure, influence, ownership — your real stories',
    type: 'behavioral',
    group: 'behavioral',
    suggestedTimes: { easy: 5, medium: 8, hard: 10 },
    solutionFiles: ['story.md'],
    testFiles: [],
    supportFiles: [],
    templateDir: 'behavioral',
  },
};

export const CATEGORY_SLUGS = Object.keys(CATEGORIES) as CategorySlug[];

export function getCategoryConfig(slug: CategorySlug): CategoryConfig {
  return CATEGORIES[slug];
}

/** Config for a db-sourced category string, or null when the slug is unknown. */
export function lookupCategoryConfig(category: string): CategoryConfig | null {
  return (CATEGORIES as Record<string, CategoryConfig | undefined>)[category] ?? null;
}

/** Type guard so a validated category can be narrowed once, not asserted repeatedly. */
export function isCategorySlug(category: string): category is CategorySlug {
  return category in CATEGORIES;
}

export function getSuggestedTime(slug: CategorySlug, difficulty: Difficulty): number {
  return CATEGORIES[slug].suggestedTimes[difficulty];
}

/** True when this category has a sandbox-verifiable test suite. */
export function hasTests(config: CategoryConfig): boolean {
  return config.testFiles.length > 0;
}

/** True when the candidate's answer is a single markdown document, not code. */
export function isProseAnswer(config: CategoryConfig): boolean {
  return config.solutionFiles.length > 0 && config.solutionFiles.every((f) => f.endsWith('.md'));
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
