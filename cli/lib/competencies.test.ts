// Lives under cli/lib (not shared/) because vitest.config.ts's `include`
// only globs cli/** and ui/** — shared/ modules are exercised through a
// cli or ui importer, same convention as shared/categories.ts.
import { describe, expect, it } from 'vitest';
import {
  COMPETENCIES,
  extractCompetencyFromReadme,
  normalizeCompetency,
  type Competency,
} from '../../shared/competencies.js';

describe('normalizeCompetency', () => {
  it('accepts an already-canonical slug', () => {
    expect(normalizeCompetency('conflict')).toBe('conflict');
    expect(normalizeCompetency('influence-without-authority')).toBe(
      'influence-without-authority',
    );
  });

  it('lowercases and collapses spaces/underscores to hyphens', () => {
    expect(normalizeCompetency('Influence Without Authority')).toBe(
      'influence-without-authority',
    );
    expect(normalizeCompetency('influence_without_authority')).toBe(
      'influence-without-authority',
    );
    expect(normalizeCompetency('  Prioritisation  ')).toBe('prioritisation');
  });

  it('drops stray punctuation and collapses repeated hyphens', () => {
    expect(normalizeCompetency('Receiving Feedback!')).toBe('receiving-feedback');
    expect(normalizeCompetency('receiving--feedback')).toBe('receiving-feedback');
  });

  it('returns null for empty input', () => {
    expect(normalizeCompetency('')).toBeNull();
    expect(normalizeCompetency('   ')).toBeNull();
  });

  it('returns null for text that never lands on a known competency (never guesses)', () => {
    expect(normalizeCompetency('leadership')).toBeNull();
    expect(normalizeCompetency('conflicts')).toBeNull(); // near-miss, not fuzzy-matched
    expect(normalizeCompetency('technical depth')).toBeNull();
  });

  it('every member of COMPETENCIES round-trips through itself', () => {
    for (const c of COMPETENCIES) {
      expect(normalizeCompetency(c)).toBe(c);
    }
  });
});

describe('extractCompetencyFromReadme', () => {
  it('reads the **Competency:** line readme.md.hbs renders', () => {
    const readme = [
      '# A Conflict You Navigated',
      '',
      '**Category:** Behavioral',
      '**Difficulty:** medium',
      '**Suggested Time:** ~8 minutes',
      '**Competency:** conflict',
      '',
      '---',
      '',
      'Tell me about a time you disagreed with a technical decision.',
    ].join('\n');
    expect(extractCompetencyFromReadme(readme)).toBe('conflict');
  });

  it('normalizes the extracted value', () => {
    const readme = '**Competency:** Influence Without Authority\n';
    expect(extractCompetencyFromReadme(readme)).toBe('influence-without-authority');
  });

  it('returns null when the line is absent (every non-behavioral README)', () => {
    const readme = [
      '# Two Sum',
      '',
      '**Category:** JS/TS Puzzles',
      '**Difficulty:** medium',
      '**Suggested Time:** ~30 minutes',
      '',
      '---',
      '',
      'Return indices of the two numbers that add up to target.',
    ].join('\n');
    expect(extractCompetencyFromReadme(readme)).toBeNull();
  });

  it('returns null when the value is not a known competency', () => {
    expect(extractCompetencyFromReadme('**Competency:** leadership\n')).toBeNull();
  });

  it('type-checks as Competency | null', () => {
    const result: Competency | null = extractCompetencyFromReadme('**Competency:** mentorship\n');
    expect(result).toBe('mentorship');
  });
});
