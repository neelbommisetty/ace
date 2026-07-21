import type { Difficulty } from '../types';

/**
 * Category display map, hardcoded to mirror cli/lib/categories.ts
 * (the ui tsconfig cannot import from cli/).
 */
export const CATEGORY_SHORT_NAMES: Record<string, string> = {
  'js-ts': 'JS/TS',
  'web-components': 'React',
  'react-apps': 'React Apps',
  'leetcode-ds': 'LC-DS',
  'leetcode-algo': 'LC-Algo',
  'design-fe': 'Design-FE',
  'design-be': 'Design-BE',
  'design-full': 'Design-Full',
};

/** One-line description of what a category covers — mirrors CATEGORIES[*].hint in cli/lib/categories.ts. */
export const CATEGORY_HINTS: Record<string, string> = {
  'js-ts': 'Closures, async patterns, type utilities',
  'web-components': 'Props, events, composition, reusable UI',
  'react-apps': 'Hooks, state, routing, full features',
  'leetcode-ds': 'Trees, graphs, heaps, hash maps',
  'leetcode-algo': 'DP, greedy, two pointers, sorting',
  'design-fe': 'Component architecture, state, rendering',
  'design-be': 'APIs, databases, caching, queues',
  'design-full': 'End-to-end systems, trade-offs',
};

/** Suggested minutes per difficulty — mirrors CATEGORIES[*].suggestedTimes in cli/lib/categories.ts. */
export const CATEGORY_SUGGESTED_TIMES: Record<string, Record<Difficulty, number>> = {
  'js-ts': { easy: 15, medium: 30, hard: 45 },
  'web-components': { easy: 20, medium: 35, hard: 50 },
  'react-apps': { easy: 25, medium: 45, hard: 60 },
  'leetcode-ds': { easy: 15, medium: 30, hard: 45 },
  'leetcode-algo': { easy: 15, medium: 30, hard: 45 },
  'design-fe': { easy: 25, medium: 40, hard: 55 },
  'design-be': { easy: 25, medium: 40, hard: 55 },
  'design-full': { easy: 30, medium: 45, hard: 60 },
};

export const CATEGORY_SLUGS = Object.keys(CATEGORY_SHORT_NAMES);

export function categoryShortName(slug: string): string {
  return CATEGORY_SHORT_NAMES[slug] ?? slug;
}

export function categoryHint(slug: string): string {
  return CATEGORY_HINTS[slug] ?? '';
}

export function suggestedMinutes(slug: string, difficulty: Difficulty): number | null {
  return CATEGORY_SUGGESTED_TIMES[slug]?.[difficulty] ?? null;
}
