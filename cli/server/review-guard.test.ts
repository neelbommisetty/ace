// Regression coverage for the NEE-342 review-guard fixes: the prose branch
// (design/behavioral) must reject a freshly scaffolded, untouched question
// exactly like the coding branch does — both via the content heuristic
// (no db) and via the template-independent scaffold-baseline hash (with db).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldQuestionAt } from '../lib/scaffold.js';
import { openDb } from './db.js';
import { sha1, toWorkspaceRelPath } from './files.js';
import { getReviewGuardError, hasMeaningfulNotes } from './reviews.js';
import type { AceDb, QuestionRow } from './types.js';

let tempRoot = '';
let db: AceDb;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-review-guard-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Scaffolds a question on disk, upserts its row, and records the pristine
 * scaffold snapshot for its primary solution file — mirroring what the real
 * "open a room for the first time" path does before a user ever edits it. */
function scaffoldAndRegister(opts: {
  category: 'design-fe' | 'behavioral';
  slug: string;
  title: string;
  primary: string;
}): QuestionRow {
  const { dir } = scaffoldQuestionAt(tempRoot, {
    title: opts.title,
    slug: opts.slug,
    category: opts.category,
    difficulty: 'medium',
    description: 'A description of the prompt, spanning multiple lines.\nSecond line.',
  });
  const question = db.upsertQuestion({
    category: opts.category,
    slug: opts.slug,
    title: opts.title,
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: dir,
    source: 'manual',
  });
  const primaryAbs = path.join(dir, opts.primary);
  const content = fs.readFileSync(primaryAbs, 'utf8');
  db.addSnapshot({
    questionId: question.id,
    attemptId: null,
    relPath: toWorkspaceRelPath(tempRoot, primaryAbs),
    hash: sha1(content),
    trigger: 'scaffold',
  });
  return question;
}

describe('getReviewGuardError — prose categories (design, behavioral)', () => {
  it('rejects a freshly scaffolded, untouched behavioral question (heuristic path, no db)', () => {
    const { dir } = scaffoldQuestionAt(tempRoot, {
      title: 'A Conflict You Navigated',
      slug: 'conflict-navigated',
      category: 'behavioral',
      difficulty: 'medium',
      description: 'Tell me about a time you disagreed with a decision.',
    });
    const question = db.upsertQuestion({
      category: 'behavioral',
      slug: 'conflict-navigated',
      title: 'A Conflict You Navigated',
      difficulty: 'medium',
      suggestedMinutes: 8,
      dirPath: dir,
      source: 'manual',
    });

    expect(getReviewGuardError(question)).not.toBeNull();
  });

  it('rejects a freshly scaffolded, untouched behavioral question (baseline path, with db)', () => {
    const question = scaffoldAndRegister({
      category: 'behavioral',
      slug: 'conflict-navigated-2',
      title: 'A Conflict You Navigated',
      primary: 'story.md',
    });

    expect(getReviewGuardError(question, db)).not.toBeNull();
  });

  it('rejects a freshly scaffolded, untouched design question (heuristic path, no db) — regression guard', () => {
    const { dir } = scaffoldQuestionAt(tempRoot, {
      title: 'Infinite Scroll',
      slug: 'infinite-scroll',
      category: 'design-fe',
      difficulty: 'medium',
      description: 'Design an infinite scroll component.',
    });
    const question = db.upsertQuestion({
      category: 'design-fe',
      slug: 'infinite-scroll',
      title: 'Infinite Scroll',
      difficulty: 'medium',
      suggestedMinutes: 40,
      dirPath: dir,
      source: 'manual',
    });

    expect(getReviewGuardError(question)).not.toBeNull();
  });

  it('rejects a freshly scaffolded, untouched design question (baseline path, with db) — regression guard', () => {
    const question = scaffoldAndRegister({
      category: 'design-fe',
      slug: 'infinite-scroll-2',
      title: 'Infinite Scroll',
      primary: 'notes.md',
    });

    expect(getReviewGuardError(question, db)).not.toBeNull();
  });

  it('passes a behavioral question with a real written story', () => {
    const question = scaffoldAndRegister({
      category: 'behavioral',
      slug: 'conflict-navigated-3',
      title: 'A Conflict You Navigated',
      primary: 'story.md',
    });
    fs.writeFileSync(
      path.join(question.dirPath, 'story.md'),
      `# A Conflict You Navigated — My Story

## Situation
On the payments team, two engineers disagreed on the retry strategy for a
flaky downstream API, and the launch was two days out.

## Task
I owned resolving the disagreement without blowing the deadline.

## Action
I pulled both engineers into a 20-minute call, wrote the two options on a
doc with their trade-offs, and we picked the simpler one together.

## Result
We shipped on time and the retry logic caused zero incidents in the first
month.

## Reflection
Next time I'd write the trade-off doc before the call, not during it.
`,
      'utf-8',
    );

    expect(getReviewGuardError(question, db)).toBeNull();
    expect(getReviewGuardError(question)).toBeNull();
  });
});

describe('getReviewGuardError — guard messages are per-type, not hardcoded to design', () => {
  it('keeps the design message byte-identical to the pre-NEE-342 wording', () => {
    const { dir } = scaffoldQuestionAt(tempRoot, {
      title: 'Infinite Scroll',
      slug: 'infinite-scroll-msg',
      category: 'design-fe',
      difficulty: 'medium',
      description: 'Design an infinite scroll component.',
    });
    const question = db.upsertQuestion({
      category: 'design-fe',
      slug: 'infinite-scroll-msg',
      title: 'Infinite Scroll',
      difficulty: 'medium',
      suggestedMinutes: 40,
      dirPath: dir,
      source: 'manual',
    });

    expect(getReviewGuardError(question)).toBe(
      'notes.md has no design notes yet — write your design before requesting a review',
    );
  });

  it('gives behavioral its own message instead of the design one', () => {
    const { dir } = scaffoldQuestionAt(tempRoot, {
      title: 'A Conflict You Navigated',
      slug: 'conflict-navigated-msg',
      category: 'behavioral',
      difficulty: 'medium',
      description: 'Tell me about a time you disagreed with a decision.',
    });
    const question = db.upsertQuestion({
      category: 'behavioral',
      slug: 'conflict-navigated-msg',
      title: 'A Conflict You Navigated',
      difficulty: 'medium',
      suggestedMinutes: 8,
      dirPath: dir,
      source: 'manual',
    });

    const message = getReviewGuardError(question);
    expect(message).toBe(
      'story.md has no story notes yet — write your story before requesting a review',
    );
    expect(message).not.toContain('notes.md');
    expect(message).not.toContain('design');
  });
});

describe('getReviewGuardError — playgrounds are never reviewable (NEE-387)', () => {
  // No scaffoldQuestionAt here (the playground scaffold templates land in a
  // later subtask) — the guard only reads the row + a real file on disk, so
  // the dir/file are built by hand, same shape scaffoldQuestionAt would leave.
  it('rejects a playground question even with a real, non-stub solution file', () => {
    const dir = path.join(tempRoot, 'questions', 'playground', 'scratch-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'App.tsx'),
      'export default function App() { return <div>hello</div>; }\n',
      'utf-8',
    );
    const question = db.upsertQuestion({
      category: 'playground',
      slug: 'scratch-1',
      title: 'Scratch #1',
      difficulty: 'easy',
      suggestedMinutes: 30,
      dirPath: dir,
      source: 'manual',
    });

    expect(getReviewGuardError(question)).toBe(
      'playgrounds are scratch pads — reviews are not available here',
    );
    expect(getReviewGuardError(question, db)).toBe(
      'playgrounds are scratch pads — reviews are not available here',
    );
  });
});

describe('hasMeaningfulNotes', () => {
  it('treats a wrapped multi-line HTML comment block as a comment in full', () => {
    const notes = `# Title

## Situation
<!-- Set the scene in 2-3 sentences: what was the context, the team, the
     stakes? This is the least important section — don't spend your word
     budget here. -->
`;
    expect(hasMeaningfulNotes(notes)).toBe(false);
  });

  it('still finds real content after a wrapped comment block', () => {
    const notes = `## Situation
<!-- Set the scene in 2-3 sentences: what was the context, the team, the
     stakes? -->
We shipped a retry strategy under deadline pressure.
`;
    expect(hasMeaningfulNotes(notes)).toBe(true);
  });

  it('counts content typed on the same line as a comment, on either side', () => {
    // Writing straight after the hint instead of on a fresh line is a normal
    // editing habit; a line-prefix scan would silently discard it.
    expect(hasMeaningfulNotes('## Situation\n<!-- hint --> I owned the rollback.\n')).toBe(true);
    expect(hasMeaningfulNotes('## Situation\nI owned the rollback. <!-- hint -->\n')).toBe(true);
    expect(
      hasMeaningfulNotes('## Situation\n<!-- hint spanning\n     two lines --> I owned it.\n'),
    ).toBe(true);
  });

  it('still rejects the pre-existing single-line-comment cases (unchanged behaviour)', () => {
    expect(hasMeaningfulNotes('# Heading\n<!-- a hint -->\n')).toBe(false);
    expect(hasMeaningfulNotes('# Heading\n\nSome real content.\n')).toBe(true);
    expect(hasMeaningfulNotes('')).toBe(false);
  });
});
