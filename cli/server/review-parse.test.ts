import { describe, expect, it } from 'vitest';
import {
  isEffectivelyStub,
  parseReviewDimensions,
  parseReviewScore,
  parseReviewVerdict,
} from './reviews.js';

const designReviewBody = `# Design Review

### Scores (1–5 each)

- Requirements Gathering: 4/5
- High-Level Architecture: 3/5
- API Design: 4/5
- Data Model: 2/5
- Deep Dive / Trade-offs: 3/5
- Communication Clarity: 5/5

### Overall Assessment

**Lean Hire**

### 3 Strengths

- Clear separation between the ingest path and the read path
- The capacity estimation is grounded in concrete numbers
- Good use of a sequence diagram for the write flow

### 3 Areas to Improve (with concrete suggestions)

- The data model skips indexing strategy — add a section on hot query paths
- No failure mode analysis for the queue consumer
- Consider a CDN layer for the media reads
`;

const codeReviewBody = `# Code Review

Solid submission — the core algorithm is correct and readable.

### Scores

- Correctness: 5/5
- Edge Case Handling: 3/5
- Time/Space Complexity: 4/5

**Overall: 4/5**

### Overall Assessment

**Hire**

### 3 Things Done Well

- \`twoSum\` uses a Map for O(n) lookups
- Early return keeps the happy path flat
- Types are precise, no \`any\`

### 3 Areas to Improve

- Handle an empty input array explicitly
- Name \`m\` something like \`seenByValue\`
- Add a complexity note in a comment
`;

// llm.ts mock mode (ACE_MOCK_LLM_MODE=feedback) produces exactly this shape.
const mockFeedbackBody =
  'Overall 4/5\n\nClear solution structure and correct approach. Add a brief complexity note.';

const plainBody = `Thanks for sharing this. The refactor reads well and the naming is
consistent. I would tighten the error handling around the fetch call and add a
test for the retry path. Nothing else stands out.`;

describe('parseReviewScore', () => {
  it('parses "Overall N/5" from a code review', () => {
    expect(parseReviewScore(codeReviewBody)).toBe(4);
  });

  it('parses the mock feedback body', () => {
    expect(parseReviewScore(mockFeedbackBody)).toBe(4);
  });

  it('parses decimal scores and tolerates spacing around the slash', () => {
    expect(parseReviewScore('### Overall: 4.5/5')).toBe(4.5);
    expect(parseReviewScore('overall 3 / 5')).toBe(3);
    expect(parseReviewScore('**Overall (weighted): 2/5**')).toBe(2);
  });

  it('is case-insensitive', () => {
    expect(parseReviewScore('OVERALL SCORE: 5/5')).toBe(5);
  });

  it('returns null when "overall" and the score are too far apart', () => {
    expect(
      parseReviewScore('Overall the solution across all evaluated dimensions lands at 4/5'),
    ).toBeNull();
  });

  it('returns null for a design body with per-dimension scores but no overall score', () => {
    expect(parseReviewScore(designReviewBody)).toBeNull();
  });

  it('returns null when there is no score at all', () => {
    expect(parseReviewScore(plainBody)).toBeNull();
    expect(parseReviewScore('')).toBeNull();
  });
});

describe('parseReviewVerdict', () => {
  it('finds the verdict in a design rubric body', () => {
    expect(parseReviewVerdict(designReviewBody)).toBe('Lean Hire');
  });

  it('finds the verdict in a code review body', () => {
    expect(parseReviewVerdict(codeReviewBody)).toBe('Hire');
  });

  it('prefers the longer verdict when they overlap ("Strong Hire" over "Hire")', () => {
    expect(parseReviewVerdict('Assessment: **Strong Hire** — great work')).toBe('Strong Hire');
    expect(parseReviewVerdict('Assessment: **No Hire** — fundamental gaps')).toBe('No Hire');
  });

  it('returns the first verdict when several appear', () => {
    expect(
      parseReviewVerdict('This sits between Lean Hire and Hire; I land on Lean Hire.'),
    ).toBe('Lean Hire');
  });

  it('ignores lowercase prose mentions of hiring', () => {
    expect(parseReviewVerdict('I would hire this candidate for a junior role.')).toBeNull();
  });

  it('returns null for bodies without a verdict', () => {
    expect(parseReviewVerdict(mockFeedbackBody)).toBeNull();
    expect(parseReviewVerdict(plainBody)).toBeNull();
  });
});

describe('parseReviewDimensions', () => {
  it('parses design-rubric dimensions, keyed as written', () => {
    expect(parseReviewDimensions(designReviewBody)).toEqual({
      'Requirements Gathering': 4,
      'High-Level Architecture': 3,
      'API Design': 4,
      'Data Model': 2,
      'Deep Dive / Trade-offs': 3,
      'Communication Clarity': 5,
    });
  });

  it('parses the shipped prompt format: bare 1–5 without "/5"', () => {
    // the pre-overhaul review rubrics requested exactly "- Name: X"
    expect(parseReviewDimensions('- Correctness: 4\n- Edge Case Handling: 2')).toEqual({
      Correctness: 4,
      'Edge Case Handling': 2,
    });
  });

  it('parses code-review score lists too', () => {
    expect(parseReviewDimensions(codeReviewBody)).toEqual({
      Correctness: 5,
      'Edge Case Handling': 3,
      'Time/Space Complexity': 4,
    });
  });

  it('keeps the first mention when a dimension appears twice', () => {
    expect(parseReviewDimensions('API Design: 5/5\nAPI Design: 1/5')).toEqual({
      'API Design': 5,
    });
  });

  it('ignores scores buried in prose', () => {
    expect(
      parseReviewDimensions(
        'The architecture discussion was thorough and the reviewers agreed it deserved a 4/5',
      ),
    ).toBeNull();
  });

  it('ignores numbers outside 1–5 and non-score list lines', () => {
    expect(parseReviewDimensions('- Attempts: 12\n- Retries allowed: 0')).toBeNull();
  });

  it('returns null for bodies with no dimension lines', () => {
    expect(parseReviewDimensions(mockFeedbackBody)).toBeNull();
    expect(parseReviewDimensions(plainBody)).toBeNull();
    expect(parseReviewDimensions('')).toBeNull();
  });
});

describe('isEffectivelyStub', () => {
  const emptyStub = '// TODO: implement your solution here';
  const scaffoldedStub = `export function twoSum(nums: number[], target: number): number[] {
  // TODO: implement
}
`;
  const realSolution = `export function twoSum(nums: number[], target: number): number[] {
  // TODO: implement — leftover comment the author forgot to delete
  const seen = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    const j = seen.get(need);
    if (j !== undefined) return [j, i];
    seen.set(nums[i], i);
  }
  throw new Error('no solution');
}
`;

  it('flags empty and whitespace-only files', () => {
    expect(isEffectivelyStub('', emptyStub)).toBe(true);
    expect(isEffectivelyStub('   \n\n  ', emptyStub)).toBe(true);
  });

  it('flags the rendered empty-placeholder stub (fresh-attempt reset output)', () => {
    expect(isEffectivelyStub(emptyStub, emptyStub)).toBe(true);
  });

  it('flags comment-only files', () => {
    expect(isEffectivelyStub('// notes to self\n// more notes\n', emptyStub)).toBe(true);
  });

  it('flags a scaffolded signature + TODO body (the generated-question stub)', () => {
    expect(isEffectivelyStub(scaffoldedStub, emptyStub)).toBe(true);
  });

  it('passes a real solution even with a leftover TODO comment', () => {
    expect(isEffectivelyStub(realSolution, emptyStub)).toBe(false);
  });

  it('passes a short real solution without TODO markers', () => {
    expect(isEffectivelyStub('export const add = (a: number, b: number) => a + b;\n', emptyStub)).toBe(
      false,
    );
  });
});
