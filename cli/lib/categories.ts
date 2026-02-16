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

export type QuestionStatus = 'untouched' | 'in-progress' | 'solved' | 'attempted';

export type QuestionType = 'coding' | 'design';

export interface CategoryConfig {
  slug: CategorySlug;
  name: string;
  shortName: string;
  type: QuestionType;
  suggestedTimes: Record<Difficulty, number>;
  solutionFiles: string[];
  testFiles: string[];
  templateDir: string;
}

export interface Attempt {
  attempt: number;
  testsTotal: number;
  testsPassed: number;
  llmScore: number | null;
}

export interface Scorecard {
  title: string;
  category: CategorySlug;
  difficulty: Difficulty;
  suggestedTime: number;
  status: QuestionStatus;
  attempts: Attempt[];
  llmFeedback: string | null;
}

export interface QuestionMeta {
  title: string;
  slug: string;
  category: CategorySlug;
  difficulty: Difficulty;
  description: string;
  signature?: string;
  suggestedTime: number;
}

export const CATEGORIES: Record<CategorySlug, CategoryConfig> = {
  'js-ts': {
    slug: 'js-ts',
    name: 'JS/TS Puzzles',
    shortName: 'JS/TS',
    type: 'coding',
    suggestedTimes: { easy: 15, medium: 30, hard: 45 },
    solutionFiles: ['solution.ts'],
    testFiles: ['solution.test.ts'],
    templateDir: 'js-ts',
  },
  'web-components': {
    slug: 'web-components',
    name: 'React Components',
    shortName: 'React',
    type: 'coding',
    suggestedTimes: { easy: 20, medium: 35, hard: 50 },
    solutionFiles: ['Component.tsx'],
    testFiles: ['Component.test.tsx'],
    templateDir: 'web-components',
  },
  'react-apps': {
    slug: 'react-apps',
    name: 'React Web Apps',
    shortName: 'React',
    type: 'coding',
    suggestedTimes: { easy: 25, medium: 45, hard: 60 },
    solutionFiles: ['App.tsx'],
    testFiles: ['App.test.tsx'],
    templateDir: 'react-apps',
  },
  'leetcode-ds': {
    slug: 'leetcode-ds',
    name: 'LeetCode Data Structures',
    shortName: 'LC-DS',
    type: 'coding',
    suggestedTimes: { easy: 15, medium: 30, hard: 45 },
    solutionFiles: ['solution.ts'],
    testFiles: ['solution.test.ts'],
    templateDir: 'leetcode-ds',
  },
  'leetcode-algo': {
    slug: 'leetcode-algo',
    name: 'LeetCode Algorithms',
    shortName: 'LC-Algo',
    type: 'coding',
    suggestedTimes: { easy: 15, medium: 30, hard: 45 },
    solutionFiles: ['solution.ts'],
    testFiles: ['solution.test.ts'],
    templateDir: 'leetcode-algo',
  },
  'design-fe': {
    slug: 'design-fe',
    name: 'System Design — Frontend',
    shortName: 'Design-FE',
    type: 'design',
    suggestedTimes: { easy: 25, medium: 40, hard: 55 },
    solutionFiles: ['notes.md'],
    testFiles: [],
    templateDir: 'design',
  },
  'design-be': {
    slug: 'design-be',
    name: 'System Design — Backend',
    shortName: 'Design-BE',
    type: 'design',
    suggestedTimes: { easy: 25, medium: 40, hard: 55 },
    solutionFiles: ['notes.md'],
    testFiles: [],
    templateDir: 'design',
  },
  'design-full': {
    slug: 'design-full',
    name: 'System Design — Full Stack',
    shortName: 'Design-Full',
    type: 'design',
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
