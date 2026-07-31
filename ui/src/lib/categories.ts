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
  CATEGORY_SLUGS,
  GENERATABLE_CATEGORY_SLUGS,
  isPlayground,
  lookupCategoryConfig,
} from '@shared/categories';

export { CATEGORY_SLUGS, GENERATABLE_CATEGORY_SLUGS, isPlayground };

function configFor(slug: string) {
  return lookupCategoryConfig(slug);
}

export function categoryShortName(slug: string): string {
  return configFor(slug)?.shortName ?? slug;
}

export function categoryHint(slug: string): string {
  return configFor(slug)?.hint ?? '';
}
