/**
 * Category config moved to shared/categories.ts (NEE-284) so cli/ and ui/
 * compile one table; this module re-exports it for existing importers and
 * keeps the legacy scorecard shapes the SPA never sees.
 */

export * from '../../shared/categories.js';

import type { CategorySlug, Difficulty } from '../../shared/categories.js';

export type QuestionStatus = 'untouched' | 'in-progress' | 'solved' | 'attempted';

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
