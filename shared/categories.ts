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
  | 'design-full';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type QuestionType = 'coding' | 'design';

export type CategoryGroup = 'react' | 'js-ts' | 'leetcode' | 'design';

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
    templateDir: 'js-ts',
  },
  'web-components': {
    slug: 'web-components',
    name: 'React Components',
    shortName: 'React',
    hint: 'Props, events, composition, reusable UI',
    type: 'coding',
    group: 'react',
    suggestedTimes: { easy: 20, medium: 35, hard: 50 },
    solutionFiles: ['Component.tsx'],
    testFiles: ['Component.test.tsx'],
    templateDir: 'web-components',
  },
  'react-apps': {
    slug: 'react-apps',
    name: 'React Web Apps',
    shortName: 'React',
    hint: 'Hooks, state, routing, full features',
    type: 'coding',
    group: 'react',
    suggestedTimes: { easy: 25, medium: 45, hard: 60 },
    solutionFiles: ['App.tsx'],
    testFiles: ['App.test.tsx'],
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
    templateDir: 'design',
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

export function isDesignCategory(slug: CategorySlug): boolean {
  return CATEGORIES[slug].type === 'design';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
