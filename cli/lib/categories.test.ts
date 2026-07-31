import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_SLUGS, GENERATABLE_CATEGORY_SLUGS, isPlayground } from './categories.js';

describe('CATEGORIES', () => {
  it('gives every category a unique shortName (NEE-366)', () => {
    const shortNames = Object.values(CATEGORIES).map((c) => c.shortName);
    expect(new Set(shortNames).size).toBe(shortNames.length);
  });

  it('GENERATABLE_CATEGORY_SLUGS is every slug except the two playground categories (NEE-387)', () => {
    expect(new Set(GENERATABLE_CATEGORY_SLUGS)).toEqual(
      new Set(CATEGORY_SLUGS.filter((s) => s !== 'playground' && s !== 'playground-ts')),
    );
    expect(GENERATABLE_CATEGORY_SLUGS).not.toContain('playground');
    expect(GENERATABLE_CATEGORY_SLUGS).not.toContain('playground-ts');
  });

  it('pins preview:"mount" to group:"react", with playground-ts as the only "import" (NEE-387)', () => {
    for (const config of Object.values(CATEGORIES)) {
      if (config.group === 'react') {
        expect(config.preview).toBe('mount');
      } else if (config.slug === 'playground-ts') {
        expect(config.preview).toBe('import');
      } else {
        expect(config.preview).toBe('none');
      }
    }
  });

  it('both playground categories are non-generatable, test-free scratch pads (NEE-387)', () => {
    for (const slug of ['playground', 'playground-ts'] as const) {
      const config = CATEGORIES[slug];
      expect(config.testFiles).toEqual([]);
      expect(config.supportFiles).toEqual([]);
      expect(isPlayground(config)).toBe(true);
    }
  });
});
