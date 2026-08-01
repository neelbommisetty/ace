import { describe, expect, it } from 'vitest';
import { GeneratedQuestionSchema } from './gen-pipeline.js';
import {
  maskPromptText,
  maskSpoilerValues,
  SecretScrubber,
  splitSpoilers,
  SPOILER_KEYS,
  WIRE_SAFE_KEYS,
  WITHHELD_MARKER,
} from './spoilers.js';

describe('splitSpoilers', () => {
  it('partitions spoiler keys out of a generated-question-shaped object', () => {
    const { safe, withheld } = splitSpoilers({
      title: 'T',
      slug: 'slug',
      description: 'visible',
      signature: 'sig',
      testCode: 'tests',
      solutionCode: 'SECRET_SOLUTION',
      referenceSolution: 'SECRET_REFERENCE',
      interviewerPacket: 'SECRET_PACKET',
      competency: 'conflict',
      followUps: ['SECRET_PROBE_1', 'SECRET_PROBE_2'],
    });
    expect(safe).toEqual({
      title: 'T',
      slug: 'slug',
      description: 'visible',
      signature: 'sig',
      testCode: 'tests',
      competency: 'conflict',
    });
    expect(withheld.sort()).toEqual([
      'followUps',
      'interviewerPacket',
      'referenceSolution',
      'solutionCode',
    ]);
  });

  it('lists a spoiler key as withheld even when its value is null', () => {
    const { safe, withheld } = splitSpoilers({ title: 'T', referenceSolution: null });
    expect(safe).toEqual({ title: 'T' });
    expect(withheld).toEqual(['referenceSolution']);
  });

  it('returns an empty withheld list when no spoiler keys are present', () => {
    const { safe, withheld } = splitSpoilers({ a: 1, b: 'two' });
    expect(safe).toEqual({ a: 1, b: 'two' });
    expect(withheld).toEqual([]);
  });
});

describe('drift guard', () => {
  // The four authoring stages, in the order gen-pipeline runs them. Their
  // wire-safe sets are disjoint by construction (each stage authors its own
  // slice of the question), so the union below is a partition check, not a
  // merge.
  const AUTHORING_SLUGS = ['draft-problem', 'author-solution', 'author-tests', 'author-packet'];

  it('GeneratedQuestionSchema keys partition exactly into the authoring stages\' WIRE_SAFE_KEYS ∪ SPOILER_KEYS', () => {
    // Adding a schema field must force a decision: wire-safe (and in WHICH
    // stage) or spoiler.
    const schemaKeys = Object.keys(GeneratedQuestionSchema.shape).sort();
    const safeKeys = AUTHORING_SLUGS.flatMap((slug) => [...WIRE_SAFE_KEYS[slug]]);
    const spoilerKeys: string[] = [...SPOILER_KEYS];
    expect(new Set(safeKeys).size).toBe(safeKeys.length); // no key wire-safe in two stages
    expect(safeKeys.filter((k) => spoilerKeys.includes(k))).toEqual([]);
    expect([...safeKeys, ...spoilerKeys].sort()).toEqual(schemaKeys);
  });

  it('every authoring stage has an entry — a missing one fails CLOSED and would blank that step', () => {
    // WIRE_SAFE_KEYS lookups fall back to the empty set, so an omitted stage
    // is silent in production: its live stream renders as nothing at all.
    for (const slug of AUTHORING_SLUGS) {
      expect(WIRE_SAFE_KEYS[slug], `WIRE_SAFE_KEYS.${slug}`).toBeDefined();
    }
    // author-packet's set is deliberately EMPTY: both of its fields
    // (interviewerPacket, followUps) are spoilers.
    expect([...WIRE_SAFE_KEYS['author-packet']]).toEqual([]);
  });

  it('the repair slug stays whole-object: every wire-safe key of every stage at once', () => {
    // Verify-repair, calibration rework, and regenerate all return the whole
    // question on this one slug.
    const staged = AUTHORING_SLUGS.flatMap((slug) => [...WIRE_SAFE_KEYS[slug]]).sort();
    expect([...WIRE_SAFE_KEYS.repair].sort()).toEqual(staged);
  });
});

describe('maskPromptText — section pass', () => {
  const PROMPT = [
    'Intro line before any heading.',
    '',
    '## Question',
    '',
    'A visible question body.',
    '',
    '## Reference Solution',
    '',
    '```',
    'export function secretAnswer() { return 42; }',
    '```',
    '',
    '## Test File',
    '',
    '```',
    "it('keeps me', () => {});",
    '```',
    '',
    '## Interviewer Packet',
    '',
    'Probe for the hidden invariant.',
  ].join('\n');

  it('withholds each spoiler-heading block and keeps everything else verbatim', () => {
    const masked = maskPromptText(PROMPT);
    expect(masked).not.toContain('secretAnswer');
    expect(masked).not.toContain('hidden invariant');
    expect(masked).toContain(WITHHELD_MARKER);
    expect(masked).toContain('Intro line before any heading.');
    expect(masked).toContain('A visible question body.');
    expect(masked).toContain("it('keeps me', () => {});");
    expect(masked).toContain('## Reference Solution');
    expect(masked).toContain('## Interviewer Packet');
  });

  it('masks Verification Failure Report and Solution Code sections too', () => {
    const text = [
      '## Verification Failure Report',
      '',
      '```',
      '✕ suite › test — expected SECRET_DETAIL',
      '```',
      '',
      '## Solution Code',
      '',
      'const SECRET_IMPL = 1;',
    ].join('\n');
    const masked = maskPromptText(text);
    expect(masked).not.toContain('SECRET_DETAIL');
    expect(masked).not.toContain('SECRET_IMPL');
  });

  it('is fence-aware: a `## Reference Solution` line inside a code fence is content, not a boundary', () => {
    const text = [
      '## Test File',
      '',
      '```',
      '## Reference Solution',
      'stillVisibleInsideFence();',
      '```',
      '',
      '## Interviewer Packet',
      '',
      'SECRET_PACKET_LINE',
    ].join('\n');
    const masked = maskPromptText(text);
    // The fenced pseudo-heading never opened a section, so the test-file
    // content around it survives — while the real packet section is masked.
    expect(masked).toContain('stillVisibleInsideFence();');
    expect(masked).not.toContain('SECRET_PACKET_LINE');
  });
});

describe('maskPromptText — json-fence pass', () => {
  it('re-serialises parseable fences with spoiler values withheld and safe values kept', () => {
    const text = [
      '## Previous Output',
      '',
      '```json',
      JSON.stringify(
        {
          title: 'Visible Title',
          testCode: 'visible tests',
          referenceSolution: 'SECRET_REFERENCE',
          interviewerPacket: 'SECRET_PACKET',
          solutionCode: null,
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
    const masked = maskPromptText(text);
    expect(masked).toContain('Visible Title');
    expect(masked).toContain('visible tests');
    expect(masked).not.toContain('SECRET_REFERENCE');
    expect(masked).not.toContain('SECRET_PACKET');
    expect(masked).toContain(`"referenceSolution": "${WITHHELD_MARKER}"`);
    // A null spoiler stays null — there is nothing to withhold.
    expect(masked).toContain('"solutionCode": null');
  });

  it('replaces an unparseable fence whole — fail closed', () => {
    const text = ['```json', '{"referenceSolution": "SECRET_REFERENCE', '```'].join('\n');
    const masked = maskPromptText(text);
    expect(masked).not.toContain('SECRET_REFERENCE');
    expect(masked).not.toContain('```json');
    expect(masked).toContain(WITHHELD_MARKER);
  });

  it('leaves non-json fences alone', () => {
    const text = ['```', 'plain fence, untouched', '```'].join('\n');
    expect(maskPromptText(text)).toBe(text);
  });
});

describe('maskSpoilerValues', () => {
  it('walks nested objects and arrays', () => {
    const masked = maskSpoilerValues({
      jobs: [{ result: { referenceSolution: 'SECRET', title: 'ok' } }],
    }) as { jobs: Array<{ result: Record<string, unknown> }> };
    expect(masked.jobs[0].result.referenceSolution).toBe(WITHHELD_MARKER);
    expect(masked.jobs[0].result.title).toBe('ok');
  });

  it('collapses an array-valued spoiler (followUps) to a single withheld marker, not per-item', () => {
    const masked = maskSpoilerValues({
      followUps: ['SECRET_PROBE_1', 'SECRET_PROBE_2'],
      competency: 'conflict',
    }) as { followUps: unknown; competency: string };
    expect(masked.followUps).toBe(WITHHELD_MARKER);
    expect(masked.competency).toBe('conflict');
  });
});

describe('SecretScrubber', () => {
  const SECRET = [
    'export function secretReference(nums: number[]): number[] {',
    '  return nums.map((n) => n * 2); // the actual answer',
    '}',
  ].join('\n');

  it('replaces a registered literal wherever it appears', () => {
    const scrubber = new SecretScrubber();
    scrubber.register(SECRET);
    const scrubbed = scrubber.scrub(`provider error while processing:\n${SECRET}\nplease retry`);
    expect(scrubbed).not.toContain('secretReference');
    expect(scrubbed).toContain(WITHHELD_MARKER);
    expect(scrubbed).toContain('provider error while processing:');
    expect(scrubbed).toContain('please retry');
  });

  it('replaces individual non-blank lines of ≥40 chars echoed on their own', () => {
    const scrubber = new SecretScrubber();
    scrubber.register(SECRET);
    // Both lines are ≥40 chars; a partial echo of just one still gets caught.
    const scrubbed = scrubber.scrub(
      'the model said: "  return nums.map((n) => n * 2); // the actual answer" and stopped',
    );
    expect(scrubbed).not.toContain('the actual answer');
    expect(scrubbed).toContain(WITHHELD_MARKER);
  });

  it('does not scrub short (<40 char) lines on their own — only as part of the full literal', () => {
    const scrubber = new SecretScrubber();
    scrubber.register(SECRET);
    // '}' is a registered secret's line but far under 40 chars; scrubbing it
    // alone would eat innocent braces everywhere.
    expect(scrubber.scrub('function ok() {}')).toBe('function ok() {}');
  });

  it('ignores blank registrations and is a no-op with nothing registered', () => {
    const scrubber = new SecretScrubber();
    scrubber.register('   \n  ');
    expect(scrubber.scrub('anything at all')).toBe('anything at all');
  });
});
