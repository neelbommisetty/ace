// NEE-344 acceptance #3 ("existing code and design reviews are byte-for-byte
// unaffected") plus the behavioral arm this ticket adds. Snapshots the exact
// user-message shape buildReviewMessages produces per kind so a future edit
// to the behavioral branch (or an accidental touch of the code/design ones)
// shows up as a failing assertion here, not a silent prompt drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCategoryConfig } from '../lib/categories.js';
import { buildReviewMessages } from './reviews.js';
import type { QuestionRow } from './types.js';

let tempRoot = '';

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-review-messages-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeQuestion(overrides: Partial<QuestionRow> & { category: string; slug: string }): QuestionRow {
  const dirPath = path.join(tempRoot, overrides.category, overrides.slug);
  fs.mkdirSync(dirPath, { recursive: true });
  return {
    id: 'q1',
    category: overrides.category,
    slug: overrides.slug,
    title: overrides.title ?? 'Test Question',
    difficulty: overrides.difficulty ?? 'medium',
    suggestedMinutes: overrides.suggestedMinutes ?? 30,
    dirPath,
    source: overrides.source ?? 'manual',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    archivedAt: overrides.archivedAt ?? null,
    missingAt: overrides.missingAt ?? null,
  };
}

function writeFile(dirPath: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dirPath, name), content, 'utf8');
}

describe('buildReviewMessages — code arm (byte-for-byte unaffected)', () => {
  it('assembles the exact solution/test user-message shape', () => {
    const config = getCategoryConfig('js-ts');
    const question = makeQuestion({ category: 'js-ts', slug: 'debounce' });
    writeFile(question.dirPath, 'README.md', '# Debounce\n\nWrite a debounce function.\n');
    writeFile(question.dirPath, 'solution.ts', 'export function debounce() {}\n');
    writeFile(question.dirPath, 'solution.test.ts', "it('works', () => {});\n");

    const { messages, maskedPrompt } = buildReviewMessages(question, config, 'code');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe(`## Question

# Debounce

Write a debounce function.

## Candidate's Solution Code

--- solution.ts ---
export function debounce() {}



## Test Cases

--- solution.test.ts ---
it('works', () => {});

`);
    // No interviewer packet on disk — masked and real prompts must match.
    expect(maskedPrompt).toBe(messages[1].content);
  });

  it('withholds the interviewer packet behind the masking marker while the real prompt still carries it', () => {
    const config = getCategoryConfig('js-ts');
    const question = makeQuestion({ category: 'js-ts', slug: 'debounce-2' });
    writeFile(question.dirPath, 'README.md', '# Debounce\n');
    writeFile(question.dirPath, 'solution.ts', 'export function debounce() {}\n');
    writeFile(question.dirPath, 'solution.test.ts', '');
    writeFile(question.dirPath, '.interviewer.md', 'Staff bar: handles trailing calls.\n');

    const { messages, maskedPrompt } = buildReviewMessages(question, config, 'code');

    expect(messages[1].content).toContain('## Interviewer Packet\nStaff bar: handles trailing calls.');
    expect(maskedPrompt).toContain('## Interviewer Packet');
    expect(maskedPrompt).not.toContain('Staff bar');
  });
});

describe('buildReviewMessages — design arm (byte-for-byte unaffected)', () => {
  it('assembles the exact design-notes user-message shape, including the sub-type line', () => {
    const config = getCategoryConfig('design-fe');
    const question = makeQuestion({ category: 'design-fe', slug: 'infinite-scroll' });
    writeFile(question.dirPath, 'README.md', '# Infinite Scroll\n\nDesign it.\n');
    writeFile(question.dirPath, 'notes.md', '## Situation\nMy notes here.\n');

    const { messages, maskedPrompt } = buildReviewMessages(question, config, 'design');

    expect(messages[1].content).toBe(`## Design Sub-Type: frontend

## Question

# Infinite Scroll

Design it.

## Candidate's Design Notes
## Situation
My notes here.
`);
    expect(maskedPrompt).toBe(messages[1].content);
  });

  it.each([
    ['design-fe', 'frontend'],
    ['design-be', 'backend'],
    ['design-full', 'full-stack'],
  ] as const)('maps %s to the "%s" sub-type', (category, expectedSubType) => {
    const config = getCategoryConfig(category);
    const question = makeQuestion({ category, slug: `notes-${category}` });
    writeFile(question.dirPath, 'README.md', 'Prompt.\n');
    writeFile(question.dirPath, 'notes.md', 'Notes.\n');

    const { messages } = buildReviewMessages(question, config, 'design');
    expect(messages[1].content).toContain(`## Design Sub-Type: ${expectedSubType}`);
  });
});

describe('buildReviewMessages — behavioral arm', () => {
  it('assembles README + Candidate\'s Story from config.solutionFiles[0]', () => {
    const config = getCategoryConfig('behavioral');
    const question = makeQuestion({ category: 'behavioral', slug: 'conflict' });
    writeFile(
      question.dirPath,
      'README.md',
      '# A Conflict You Navigated\n\nTell me about a time you disagreed with a decision.\n',
    );
    writeFile(
      question.dirPath,
      'story.md',
      '## Situation\nOn the payments team...\n\n## Result\nWe shipped on time.\n',
    );

    const { messages, maskedPrompt } = buildReviewMessages(question, config, 'behavioral');

    expect(messages[1].content).toBe(`## Question

# A Conflict You Navigated

Tell me about a time you disagreed with a decision.

## Candidate's Story
## Situation
On the payments team...

## Result
We shipped on time.
`);
    expect(maskedPrompt).toBe(messages[1].content);
  });

  it('withholds the interviewer packet the same way the code/design arms do', () => {
    const config = getCategoryConfig('behavioral');
    const question = makeQuestion({ category: 'behavioral', slug: 'conflict-2' });
    writeFile(question.dirPath, 'README.md', 'Tell me about a conflict.\n');
    writeFile(question.dirPath, 'story.md', 'My real story.\n');
    writeFile(question.dirPath, '.interviewer.md', 'Competency: conflict resolution.\n');

    const { messages, maskedPrompt } = buildReviewMessages(question, config, 'behavioral');

    expect(messages[1].content).toContain('## Interviewer Packet\nCompetency: conflict resolution.');
    expect(maskedPrompt).toContain('## Interviewer Packet');
    expect(maskedPrompt).not.toContain('Competency: conflict resolution');
  });
});
