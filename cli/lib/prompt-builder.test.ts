import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATEGORY_SLUGS } from './categories.js';
import {
  buildBrainstormPrompt,
  buildQuestionSection,
  buildSystemPrompt,
  parseCapsuleSections,
  type PromptFeature,
} from './prompt-builder.js';

const FEATURES: PromptFeature[] = ['generate', 'edge-audit', 'review', 'calibrate'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSystemPrompt', () => {
  it.each(FEATURES.flatMap((f) => CATEGORY_SLUGS.map((c) => [f, c] as const)))(
    'assembles a non-empty, slot-free prompt for %s × %s',
    (feature, category) => {
      const prompt = buildSystemPrompt(feature, category);
      expect(prompt.length).toBeGreaterThan(500);
      // No slot survives assembly — a leftover {{...}} means a skeleton/capsule drifted.
      expect(prompt).not.toMatch(/\{\{.+?\}\}/);
    },
  );

  it('puts the charter first', () => {
    const prompt = buildSystemPrompt('generate', 'js-ts');
    expect(prompt.startsWith('# Interviewer Charter')).toBe(true);
  });

  it('splices category-specific capsule content into the skeleton', () => {
    const prompt = buildSystemPrompt('generate', 'js-ts');
    expect(prompt).toContain('`js-ts`');
    expect(prompt).toContain('solution.test.ts');
  });

  it('carries all five behavioral STAR dimension names into the assembled review prompt (NEE-344)', () => {
    // Catches a capsule section rename breaking the {{review-dimensions}}
    // slot silently — the names are also parseReviewDimensions' extraction
    // keys, so a drift here is a drift in production score history.
    const prompt = buildSystemPrompt('review', 'behavioral');
    for (const dimension of ['Structure', 'Specificity', 'Ownership', 'Impact', 'Reflection']) {
      expect(prompt).toContain(`**${dimension}**`);
    }
  });

  it('throws with the capsule path when a required section is missing', () => {
    const real = fs.readFileSync.bind(fs);
    const fake = ((file: Parameters<typeof fs.readFileSync>[0], options?: never) => {
      if (typeof file === 'string' && file.endsWith('categories/js-ts.md')) {
        return '# Capsule\n\n## Identity\n\nOnly identity, nothing else.\n';
      }
      return real(file, options);
    }) as typeof fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(fake);
    expect(() => buildSystemPrompt('generate', 'js-ts')).toThrow(
      /missing required section "## Difficulty Calibration" in cli\/prompts\/categories\/js-ts\.md/,
    );
  });

  it('treats an empty required section as missing', () => {
    const real = fs.readFileSync.bind(fs);
    const fake = ((file: Parameters<typeof fs.readFileSync>[0], options?: never) => {
      if (typeof file === 'string' && file.endsWith('categories/js-ts.md')) {
        const original = real(file, 'utf8') as string;
        return original.replace(
          /## Identity[\s\S]*?(?=\n## )/,
          '## Identity\n\n',
        );
      }
      return real(file, options);
    }) as typeof fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(fake);
    expect(() => buildSystemPrompt('generate', 'js-ts')).toThrow(
      /missing required section "## Identity"/,
    );
  });
});

describe('charter preference-section canary (NEE-273)', () => {
  // The charter carries the evaluation contract, not a preference list: the
  // Priority Domains and Exclusions sections were deleted, and no assembled
  // prompt may still contain them or dangling references to them.
  const BANNED = [
    /## Priority Domains/i,
    /## Exclusions/i,
    /priority domains?/i,
    /charter(?:'s)? exclusions?/i,
    /charter domains?/i,
  ];

  it.each(FEATURES.flatMap((f) => CATEGORY_SLUGS.map((c) => [f, c] as const)))(
    'leaves no domain-list or exclusion-list residue in %s × %s',
    (feature, category) => {
      const prompt = buildSystemPrompt(feature, category);
      for (const pattern of BANNED) {
        expect(prompt).not.toMatch(pattern);
      }
    },
  );

  it('leaves no domain-list or exclusion-list residue in the brainstorm prompt', () => {
    const prompt = buildBrainstormPrompt();
    for (const pattern of BANNED) {
      expect(prompt).not.toMatch(pattern);
    }
  });
});

describe('buildBrainstormPrompt', () => {
  it('assembles charter + a digest of all 8 capsules, slot-free', () => {
    const prompt = buildBrainstormPrompt();
    expect(prompt.startsWith('# Interviewer Charter')).toBe(true);
    expect(prompt).not.toMatch(/\{\{.+?\}\}/);
    for (const slug of CATEGORY_SLUGS) {
      expect(prompt).toContain(`(\`${slug}\`)`);
    }
  });
});

describe('buildQuestionSection', () => {
  it('emits generated-shape content verbatim under a bare ## Question delimiter', () => {
    const generated = [
      '## Problem Statement',
      '',
      'Build a debounced autosave queue.',
      '',
      '## Signature',
      '',
      '```ts',
      'export function createAutosaver(): Autosaver',
      '```',
      '',
      '## Constraints',
      '',
      '- Coalesce saves within 500ms.',
    ].join('\n');

    const section = buildQuestionSection(generated);

    expect(section).toBe(`## Question\n\n${generated}`);
    // The old wrapper doubled this heading and claimed the sibling sections
    // (NEE-275) — each of the description's own headings must appear once.
    expect(section.match(/^## Problem Statement$/gm)).toHaveLength(1);
    expect(section.match(/^## Signature$/gm)).toHaveLength(1);
  });

  it('reads sensibly for a manual/pre-overhaul README with no section structure', () => {
    const manual = '# Debounce\n\nWrite a debounce function that delays calls.\n';
    expect(buildQuestionSection(manual)).toBe(
      '## Question\n\n# Debounce\n\nWrite a debounce function that delays calls.',
    );
  });
});

describe('parseCapsuleSections', () => {
  it('splits on ## headings and trims bodies', () => {
    const sections = parseCapsuleSections(
      '# Title\n\nintro\n\n## Alpha\n\na-body\n\n## Beta\nb-body\n',
    );
    expect([...sections.keys()]).toEqual(['Alpha', 'Beta']);
    expect(sections.get('Alpha')).toBe('a-body');
    expect(sections.get('Beta')).toBe('b-body');
  });

  it('ignores ## lines inside code fences', () => {
    const raw = '## Real\n\n```md\n## Not A Section\n```\nafter\n\n## Next\nx\n';
    const sections = parseCapsuleSections(raw);
    expect([...sections.keys()]).toEqual(['Real', 'Next']);
    expect(sections.get('Real')).toContain('## Not A Section');
    expect(sections.get('Real')).toContain('after');
  });
});
