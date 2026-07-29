import { describe, expect, it } from 'vitest';
import { CATEGORIES } from './categories.js';

describe('CATEGORIES', () => {
  it('gives every category a unique shortName (NEE-366)', () => {
    const shortNames = Object.values(CATEGORIES).map((c) => c.shortName);
    expect(new Set(shortNames).size).toBe(shortNames.length);
  });
});
