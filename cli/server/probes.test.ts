// Engine-level tests for follow-up probes (NEE-345) — driven entirely
// through the injected `llm`/`resolveProvider` seams (the generation.test.ts
// pattern), never ACE_E2E_MOCK_LLM: deterministic, keyless, no real vitest
// or API key touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProbeBankMd, scaffoldQuestionAt } from '../lib/scaffold.js';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import { createAiLog } from './ai-log.js';
import { openDb } from './db.js';
import {
  appendProbesToStory,
  createProbeEngine,
  getProbeGuardError,
  hasProbeSetForAttempt,
  parseProbeBank,
  type ProbeLlm,
} from './probes.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, Probe, QuestionRow } from './types.js';

// The engine's `resolveProvider` option is the keyless-testable seam for
// provider resolution — mirrors generation.test.ts's FAKE_PROVIDER exactly.
const FAKE_PROVIDER: () => LLMProvider | null = () => 'openai';

const REAL_STORY =
  '## Situation\nA teammate and I disagreed about the caching strategy for a shared service.\n\n## Action\nI proposed a two-day spike to compare both approaches with real data.\n';

let tempRoot = '';
let db: AceDb;
let bus: Bus;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-probes-test-'));
  fs.mkdirSync(path.join(tempRoot, 'questions'), { recursive: true });
  db = openDb(tempRoot);
  bus = createBus();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Scaffolds a behavioral question on disk and upserts its row. */
function writeQuestion(
  slug: string,
  opts: { story?: string; followUps?: string[] } = {},
): QuestionRow {
  const { dir } = scaffoldQuestionAt(tempRoot, {
    title: 'A Conflict You Navigated',
    slug,
    category: 'behavioral',
    difficulty: 'medium',
    description: 'Tell me about a time you disagreed with a decision.',
    followUps: opts.followUps ?? null,
  });
  if (opts.story !== undefined) {
    fs.writeFileSync(path.join(dir, 'story.md'), opts.story, 'utf8');
  }
  return db.upsertQuestion({
    category: 'behavioral',
    slug,
    title: 'A Conflict You Navigated',
    difficulty: 'medium',
    suggestedMinutes: 20,
    dirPath: dir,
    source: 'manual',
  });
}

interface FakeLlmOpts {
  abortSignal?: AbortSignal;
  purpose?: string;
  onPartial?: (partial: Record<string, unknown>) => void;
}

/** Queue-based fake chatObjectStream, mirroring generation.test.ts's makeFakeLlm. */
function makeFakeLlm(
  handlers: Array<
    (provider: LLMProvider, messages: LLMMessage[], opts?: FakeLlmOpts) => unknown
  >,
): { llm: ProbeLlm; calls: Array<{ provider: LLMProvider; messages: LLMMessage[]; opts?: FakeLlmOpts }> } {
  const calls: Array<{ provider: LLMProvider; messages: LLMMessage[]; opts?: FakeLlmOpts }> = [];
  let i = 0;
  const chatObjectStream = async (
    provider: LLMProvider,
    messages: LLMMessage[],
    schema: any,
    opts?: FakeLlmOpts,
  ) => {
    calls.push({ provider, messages, opts });
    const handler = handlers[i++];
    if (!handler) throw new Error('fake llm: no more handlers queued');
    const payload = handler(provider, messages, opts);
    opts?.onPartial?.(payload as Record<string, unknown>);
    return schema.parse(payload);
  };
  return { llm: { chatObjectStream } as unknown as ProbeLlm, calls };
}

const TWO_PROBES = {
  probes: [
    { question: 'What would the other engineer say about how you handled it?', source: 'derived' },
    { question: 'How would your approach change at 10x the team size?', source: 'derived' },
  ],
};

function waitFor<N extends string>(name: N): Promise<any> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe((eventName, data) => {
      if (eventName === name) {
        unsub();
        resolve(data);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseProbeBank', () => {
  it('parses getProbeBankMd\'s numbered-list format back into plain strings', () => {
    const md = getProbeBankMd([
      'What would the other engineer say about how you handled it?',
      'How would your approach change if this happened at 10x the team size?',
    ]);
    expect(parseProbeBank(md)).toEqual([
      'What would the other engineer say about how you handled it?',
      'How would your approach change if this happened at 10x the team size?',
    ]);
  });

  it('returns an empty list for an absent/empty bank', () => {
    expect(parseProbeBank('')).toEqual([]);
  });
});

describe('appendProbesToStory', () => {
  const probes: Probe[] = [
    { question: 'Q1?', source: 'derived' },
    { question: 'Q2?', source: 'bank' },
  ];

  it('adds a new "## Follow-ups" H2 with numbered probes on the first round', () => {
    const updated = appendProbesToStory('# Title\n\nSome story text.', probes);
    expect(updated).toContain('# Title\n\nSome story text.');
    expect(updated).toContain('## Follow-ups');
    expect(updated).toContain('### Probe 1 — Q1?');
    expect(updated).toContain('### Probe 2 — Q2?');
    // Exactly one Follow-ups heading.
    expect(updated.match(/^## Follow-ups$/gm)).toHaveLength(1);
  });

  it('a second round appends new Probe N entries under the SAME H2, never a second heading', () => {
    const afterRound1 = appendProbesToStory('# Title\n\nSome story text.', probes);
    const roundTwoProbes: Probe[] = [{ question: 'Q3?', source: 'derived' }];
    const afterRound2 = appendProbesToStory(afterRound1, roundTwoProbes);

    expect(afterRound2.match(/^## Follow-ups$/gm)).toHaveLength(1);
    expect(afterRound2).toContain('### Probe 1 — Q1?');
    expect(afterRound2).toContain('### Probe 2 — Q2?');
    expect(afterRound2).toContain('### Probe 3 — Q3?');
    // Purely additive: round 1's output is an exact prefix-preserving subset —
    // nothing before "### Probe 3" was rewritten.
    expect(afterRound2.startsWith(afterRound1.trimEnd())).toBe(true);
  });
});

describe('getProbeGuardError', () => {
  it('rejects an unknown category', () => {
    const question = writeQuestion('conflict-guard');
    const error = getProbeGuardError({ ...question, category: 'not-a-real-category' });
    expect(error).toMatch(/unknown category/);
  });

  it('rejects a non-prose category (nothing to drill into)', () => {
    const { dir } = scaffoldQuestionAt(tempRoot, {
      title: 'Two Sum',
      slug: 'two-sum',
      category: 'js-ts',
      difficulty: 'easy',
      description: 'Return indices of two numbers.',
    });
    const question = db.upsertQuestion({
      category: 'js-ts',
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'easy',
      suggestedMinutes: 15,
      dirPath: dir,
      source: 'manual',
    });
    expect(getProbeGuardError(question)).toMatch(/prose/);
  });

  it('rejects an untouched, freshly scaffolded story (nothing written yet)', () => {
    const question = writeQuestion('conflict-untouched');
    expect(getProbeGuardError(question)).toMatch(/no story yet/);
  });

  it('accepts a story with meaningful content', () => {
    const question = writeQuestion('conflict-meaningful', { story: REAL_STORY });
    expect(getProbeGuardError(question)).toBeNull();
  });
});

describe('hasProbeSetForAttempt', () => {
  it('is false with no probe sets, true once one exists for that attempt, and scoped per-attempt', () => {
    const question = writeQuestion('conflict-bound-unit', { story: REAL_STORY });
    expect(hasProbeSetForAttempt(db, question.id, 'attempt-1')).toBe(false);

    db.createProbeSet({
      questionId: question.id,
      attemptId: 'attempt-1',
      probes: [{ question: 'x', source: 'derived' }],
      model: 'm',
    });

    expect(hasProbeSetForAttempt(db, question.id, 'attempt-1')).toBe(true);
    expect(hasProbeSetForAttempt(db, question.id, 'attempt-2')).toBe(false);
    expect(hasProbeSetForAttempt(db, question.id, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe('createProbeEngine', () => {
  it('happy path: started -> done, persists a probe set, and appends additively to story.md with a snapshot', async () => {
    const question = writeQuestion('conflict-happy', { story: REAL_STORY });
    const { llm } = makeFakeLlm([() => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    const started = waitFor('probes-started');
    const done = waitFor('probes-done');
    const { probeJobId } = engine.start(question, 'attempt-1');

    const startedPayload = await started;
    expect(startedPayload).toEqual({ probeJobId, questionId: question.id });

    const { probeSet } = await done;
    expect(probeSet.questionId).toBe(question.id);
    expect(probeSet.attemptId).toBe('attempt-1');
    expect(probeSet.model).toBe('gpt-5.6-terra'); // probe purpose resolves to the 'mid' tier
    expect(probeSet.appliedAt).not.toBeNull();
    expect(probeSet.probes).toEqual(TWO_PROBES.probes);

    const rows = db.listProbeSets(question.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(probeSet.id);

    const storyContent = fs.readFileSync(path.join(question.dirPath, 'story.md'), 'utf8');
    expect(storyContent).toContain(REAL_STORY.trim());
    expect(storyContent).toContain('## Follow-ups');
    expect(storyContent).toContain(
      '### Probe 1 — What would the other engineer say about how you handled it?',
    );
    expect(storyContent).toContain('### Probe 2 — How would your approach change at 10x the team size?');

    const snapshots = db.getFirstSnapshot(
      question.id,
      `questions/behavioral/${question.slug}/story.md`,
      'probe-append',
    );
    expect(snapshots).not.toBeNull();

    expect(engine.isRunning(question.id)).toBe(false);
  });

  it('degrades gracefully with no .probes.md: the prompt says "none" and every probe returned is still accepted', async () => {
    const question = writeQuestion('conflict-no-bank', { story: REAL_STORY }); // no followUps
    expect(fs.existsSync(path.join(question.dirPath, '.probes.md'))).toBe(false);

    const { llm, calls } = makeFakeLlm([() => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    const done = waitFor('probes-done');
    engine.start(question, null);
    await done;

    const userMessage = calls[0].messages.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain('## Probe Bank');
    expect(userMessage.content).toContain('(none — derive every probe from the story below)');
  });

  it('uses the .probes.md bank when NEE-343 shipped one', async () => {
    const question = writeQuestion('conflict-with-bank', {
      story: REAL_STORY,
      followUps: [
        'What would the other engineer say about how you handled it?',
        'How would your approach change if this happened at 10x the team size?',
      ],
    });
    expect(fs.existsSync(path.join(question.dirPath, '.probes.md'))).toBe(true);

    const { llm, calls } = makeFakeLlm([() => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    const done = waitFor('probes-done');
    engine.start(question, null);
    await done;

    const userMessage = calls[0].messages.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain(
      '1. What would the other engineer say about how you handled it?',
    );
    expect(userMessage.content).toContain(
      '2. How would your approach change if this happened at 10x the team size?',
    );
    expect(userMessage.content).not.toContain('(none — derive every probe from the story below)');
  });

  it('idempotent across two rounds: the second run appends Probe 3/4 under the SAME Follow-ups heading', async () => {
    const question = writeQuestion('conflict-two-rounds', { story: REAL_STORY });
    const { llm } = makeFakeLlm([() => TWO_PROBES, () => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    const firstDone = waitFor('probes-done');
    engine.start(question, 'attempt-1');
    await firstDone;

    const secondDone = waitFor('probes-done');
    engine.start(question, 'attempt-2');
    await secondDone;

    const storyContent = fs.readFileSync(path.join(question.dirPath, 'story.md'), 'utf8');
    expect(storyContent.match(/^## Follow-ups$/gm)).toHaveLength(1);
    expect(storyContent).toContain('### Probe 1 —');
    expect(storyContent).toContain('### Probe 2 —');
    expect(storyContent).toContain('### Probe 3 —');
    expect(storyContent).toContain('### Probe 4 —');
    expect(db.listProbeSets(question.id)).toHaveLength(2);
  });

  it('keyless (no resolvable provider) errors without ever calling the llm', async () => {
    const question = writeQuestion('conflict-keyless', { story: REAL_STORY });
    const { llm, calls } = makeFakeLlm([() => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: () => null,
    });

    const errored = waitFor('probes-error');
    engine.start(question, null);
    const payload = await errored;

    expect(payload.message).toMatch(/no LLM API key configured/);
    expect(calls).toHaveLength(0);
    expect(db.listProbeSets(question.id)).toEqual([]);
  });

  it('a schema violation (fewer than 2 probes) surfaces as probes-error, not a crash', async () => {
    const question = writeQuestion('conflict-bad-schema', { story: REAL_STORY });
    const { llm } = makeFakeLlm([
      () => ({ probes: [{ question: 'only one', source: 'derived' }] }),
    ]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    const errored = waitFor('probes-error');
    engine.start(question, null);
    await errored;

    expect(db.listProbeSets(question.id)).toEqual([]);
  });

  it('assertNotRunning: a second start() for the same question while one is in flight throws synchronously', () => {
    const question = writeQuestion('conflict-double-start', { story: REAL_STORY });
    const { llm } = makeFakeLlm([() => TWO_PROBES, () => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    engine.start(question, null);
    expect(engine.isRunning(question.id)).toBe(true);
    expect(() => engine.start(question, null)).toThrow(/already in progress/);
  });

  it('a paid call resolving after dispose() writes nothing and emits nothing', async () => {
    const question = writeQuestion('conflict-disposed', { story: REAL_STORY });
    let resolveLlm!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveLlm = resolve;
    });
    const llm: ProbeLlm = {
      chatObjectStream: (async (...args: any[]) => {
        const value = await pending;
        return (args[2] as { parse: (v: unknown) => unknown }).parse(value);
      }) as any,
    };
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });

    let sawDoneOrError = false;
    bus.subscribe((name) => {
      if (name === 'probes-done' || name === 'probes-error') sawDoneOrError = true;
    });

    engine.start(question, null);
    engine.dispose();
    resolveLlm(TWO_PROBES);
    // Let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(sawDoneOrError).toBe(false);
    expect(db.listProbeSets(question.id)).toEqual([]);
    const storyContent = fs.readFileSync(path.join(question.dirPath, 'story.md'), 'utf8');
    expect(storyContent).not.toContain('## Follow-ups');
  });

  it('assertNotDisposed: start() after dispose() throws', () => {
    const question = writeQuestion('conflict-start-after-dispose', { story: REAL_STORY });
    const { llm } = makeFakeLlm([() => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });
    engine.dispose();
    expect(() => engine.start(question, null)).toThrow(/disposed/);
  });

  it('isAnyRunning reflects in-flight state across questions', () => {
    const q1 = writeQuestion('conflict-any-1', { story: REAL_STORY });
    const q2 = writeQuestion('conflict-any-2', { story: REAL_STORY });
    const { llm } = makeFakeLlm([() => TWO_PROBES, () => TWO_PROBES]);
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
    });
    expect(engine.isAnyRunning()).toBe(false);
    engine.start(q1, null);
    expect(engine.isAnyRunning()).toBe(true);
    engine.start(q2, null);
    expect(engine.isAnyRunning()).toBe(true);
  });
});

describe('createProbeEngine activity log integration (NEE-268/spoilers)', () => {
  it('records a done run with a single wire-safe "probe" step — the probe questions are never withheld', async () => {
    const question = writeQuestion('conflict-activity', { story: REAL_STORY });
    const { llm } = makeFakeLlm([() => TWO_PROBES]);
    const aiLog = createAiLog({ db, bus });
    const engine = createProbeEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      aiLog,
    });

    const done = waitFor('probes-done');
    const { probeJobId } = engine.start(question, null);
    await done;

    const runs = db.listAiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'probe',
      refId: probeJobId,
      questionId: question.id,
      status: 'done',
    });

    const steps = db.listAiSteps(runs[0].id);
    expect(steps.map((s) => [s.slug, s.status])).toEqual([['probe', 'done']]);

    const step = db.getAiStep(steps[0].id)!;
    expect(step.promptText).toContain("Candidate's Story");
    // An empty withheld-keys list persists as null (db.ts's createAiStep
    // convention) — WIRE_SAFE_KEYS.probe covers the whole schema, so there
    // is nothing to withhold.
    expect(step.withheldKeys).toBeNull();
    expect(step.responseText).toContain(
      'What would the other engineer say about how you handled it?',
    );
  });
});
