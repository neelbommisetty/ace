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

export const CATEGORY_SLUGS = Object.keys(CATEGORY_SHORT_NAMES);

export function categoryShortName(slug: string): string {
  return CATEGORY_SHORT_NAMES[slug] ?? slug;
}
