/**
 * UI-only display helpers over the shared category table (NEE-284). The
 * hardcoded mirror tables are gone — everything derives from the real
 * `CATEGORIES` object in shared/categories.ts.
 *
 * The helpers take plain `string` slugs (wire rows carry `category: string`,
 * not `CategorySlug`) and degrade gracefully on unknown slugs, matching the
 * old lookup-table fallbacks.
 */

import {
  CATEGORIES,
  CATEGORY_SLUGS,
  type CategoryConfig,
  type Difficulty,
} from '@shared/categories';

export { CATEGORY_SLUGS };

function configFor(slug: string): CategoryConfig | undefined {
  return (CATEGORIES as Record<string, CategoryConfig | undefined>)[slug];
}

export function categoryShortName(slug: string): string {
  return configFor(slug)?.shortName ?? slug;
}

export function categoryHint(slug: string): string {
  return configFor(slug)?.hint ?? '';
}

export function suggestedMinutes(slug: string, difficulty: Difficulty): number | null {
  return configFor(slug)?.suggestedTimes[difficulty] ?? null;
}
