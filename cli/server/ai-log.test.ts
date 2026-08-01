import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WITHHELD_MARKER } from '../lib/spoilers.js';
import {
  AI_CHUNK_FLUSH_MS,
  AI_STEP_STREAM_CAP,
  createAiLog,
  NULL_AI_LOG,
  PartialDiffer,
  type AiLog,
} from './ai-log.js';
import { AI_LOG_TEXT_CAP, openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb, AiStepSummary } from './types.js';

describe('PartialDiffer', () => {
  const SAFE: ReadonlySet<string> = new Set(['title', 'tags', 'count']);

  it('emits suffix appends for monotonically growing string values', () => {
    const differ = new PartialDiffer();
    expect(differ.diff({ title: 'He' }, SAFE)).toEqual([
      { key: 'title', op: 'append', text: 'He' },
    ]);
    expect(differ.diff({ title: 'Hello' }, SAFE)).toEqual([
      { key: 'title', op: 'append', text: 'llo' },
    ]);
    // Unchanged value → no op at all.
    expect(differ.diff({ title: 'Hello' }, SAFE)).toEqual([]);
  });

  it('falls back to a wholesale set when a value stops being a prefix of its successor', () => {
    const differ = new PartialDiffer();
    differ.diff({ title: 'Hello' }, SAFE);
    expect(differ.diff({ title: 'Goodbye' }, SAFE)).toEqual([
      { key: 'title', op: 'set', text: 'Goodbye' },
    ]);
  });

  it('JSON-stringifies non-string values (array reshape → set)', () => {
    const differ = new PartialDiffer();
    expect(differ.diff({ tags: ['a'], count: 1 }, SAFE)).toEqual([
      { key: 'tags', op: 'append', text: '["a"]' },
      { key: 'count', op: 'append', text: '1' },
    ]);
    // '["a","b"]' is not an extension of '["a"]' — the closing bracket moved.
    expect(differ.diff({ tags: ['a', 'b'] }, SAFE)).toEqual([
      { key: 'tags', op: 'set', text: '["a","b"]' },
    ]);
  });

  it('filters non-safe keys BEFORE diffing — they never produce ops', () => {
    const differ = new PartialDiffer();
    const ops = differ.diff({ referenceSolution: 'SECRET BODY', title: 'ok' }, SAFE);
    expect(ops).toEqual([{ key: 'title', op: 'append', text: 'ok' }]);
    expect(JSON.stringify(ops)).not.toContain('SECRET');
  });
});

describe('createAiLog recorder', () => {
  let tempRoot = '';
  let db: AceDb;
  let bus: Bus;
  let log: AiLog;
  let events: Array<{ name: string; data: any }>;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ai-log-test-'));
    db = openDb(tempRoot);
    bus = createBus();
    log = createAiLog({ db, bus });
    events = [];
    bus.subscribe((name, data) => events.push({ name, data }));
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      db.close();
    } catch {
      // some tests close it themselves
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const chunkEvents = () => events.filter((e) => e.name === 'ai-step-chunk');

  it('persists run/step rows and emits started/done events with the summary shape', () => {
    const run = log.startRun({
      kind: 'generation',
      refId: 'job-1',
      questionId: null,
      label: 'two sum variant',
    });
    expect(run.runId).not.toBe('');

    const startedRun = events.find((e) => e.name === 'ai-run-started')!;
    expect(startedRun.data.run.id).toBe(run.runId);
    expect(startedRun.data.run.label).toBe('two sum variant');
    expect(startedRun.data.run.status).toBe('running');

    const step = run.step({
      slug: 'repair',
      label: 'Revising the question',
      kind: 'llm',
      prompt: 'Generate a question about two sum.',
    });
    const startedStep = events.find((e) => e.name === 'ai-step-started')!;
    const summary = startedStep.data.step as AiStepSummary;
    expect(startedStep.data.runId).toBe(run.runId);
    // Step- and run-level events repeat the run's refId — refId-filtered
    // feeds (the per-job drawer, NEE-272) drop foreign events on it.
    expect(startedStep.data.refId).toBe('job-1');
    expect(summary.slug).toBe('repair');
    expect(summary.promptWithheld).toBe(false);
    // withheldKeys declared on STARTED: schema keys minus WIRE_SAFE_KEYS —
    // the `repair` slug streams the WHOLE question, so all four spoilers.
    // followUps (NEE-343, behavioral-only) joined SPOILER_KEYS alongside
    // interviewerPacket — see spoilers.ts for the reasoning.
    expect(summary.withheldKeys).toEqual([
      'solutionCode',
      'referenceSolution',
      'interviewerPacket',
      'followUps',
    ]);
    // The multi-KB bodies never ride the wire.
    expect('promptText' in summary).toBe(false);
    expect('responseText' in summary).toBe(false);

    const row = db.getAiStep(summary.id)!;
    expect(row.promptText).toBe('Generate a question about two sum.');

    step.done('all good');
    const doneStep = events.find((e) => e.name === 'ai-step-done')!;
    expect(doneStep.data).toMatchObject({
      runId: run.runId,
      refId: 'job-1',
      stepId: summary.id,
      status: 'done',
      detail: 'all good',
      errorMessage: null,
    });
    expect(db.getAiStep(summary.id)!.status).toBe('done');

    run.done();
    const doneRun = events.find((e) => e.name === 'ai-run-done')!;
    expect(doneRun.data).toMatchObject({
      runId: run.runId,
      refId: 'job-1',
      status: 'done',
      errorMessage: null,
    });
    expect(db.getAiRun(run.runId)!.status).toBe('done');
  });

  it('edge-audit steps withhold edgeCases on top of the spoiler keys', () => {
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    run.step({ slug: 'edge-audit', label: 'Auditing edge cases', kind: 'llm' });
    const summary = events.find((e) => e.name === 'ai-step-started')!.data.step as AiStepSummary;
    expect(summary.withheldKeys).toEqual(['edgeCases', 'referenceSolution', 'interviewerPacket']);
  });

  it('withholdPrompt stores a null promptText with promptWithheld set', () => {
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    run.step({
      slug: 'verify',
      label: 'Running tests',
      kind: 'sandbox',
      prompt: 'should not be stored',
      withholdPrompt: true,
    });
    const summary = events.find((e) => e.name === 'ai-step-started')!.data.step as AiStepSummary;
    expect(summary.promptWithheld).toBe(true);
    const row = db.getAiStep(summary.id)!;
    expect(row.promptText).toBeNull();
  });

  it('coalesces partials into one chunk event + one db snapshot per flush window, and always flushes on step end', () => {
    vi.useFakeTimers();
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    const step = run.step({ slug: 'draft-problem', label: 'Writing', kind: 'llm' });
    const stepId = (events.find((e) => e.name === 'ai-step-started')!.data.step as AiStepSummary)
      .id;

    step.partial({ title: 'He' });
    step.partial({ title: 'Hello' });
    step.partial({ title: 'Hello wor' });
    expect(chunkEvents()).toHaveLength(0); // nothing until the window elapses

    vi.advanceTimersByTime(AI_CHUNK_FLUSH_MS);
    expect(chunkEvents()).toHaveLength(1);
    // Three partials coalesced into ONE append op; chunks carry refId too.
    expect(chunkEvents()[0].data.ops).toEqual([{ key: 'title', op: 'append', text: 'Hello wor' }]);
    expect(chunkEvents()[0].data.refId).toBeNull();
    expect(db.getAiStep(stepId)!.responseText).toBe(
      JSON.stringify({ title: 'Hello wor' }, null, 2),
    );

    // Pending ops at step end flush immediately — no timer needed.
    step.partial({ title: 'Hello world' });
    step.done('finished');
    expect(chunkEvents()).toHaveLength(2);
    expect(chunkEvents()[1].data.ops).toEqual([{ key: 'title', op: 'append', text: 'ld' }]);
    const row = db.getAiStep(stepId)!;
    expect(row.responseText).toBe(JSON.stringify({ title: 'Hello world' }, null, 2));
    expect(row.detail).toBe('finished');
  });

  it('caps SSE emission per step (marking the cut) while the db still gets the full text', () => {
    vi.useFakeTimers();
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    const step = run.step({ slug: 'draft-problem', label: 'Writing', kind: 'llm' });
    const stepId = (events.find((e) => e.name === 'ai-step-started')!.data.step as AiStepSummary)
      .id;

    const big = 'x'.repeat(AI_STEP_STREAM_CAP);
    step.partial({ description: big });
    vi.advanceTimersByTime(AI_CHUNK_FLUSH_MS);
    expect(chunkEvents()).toHaveLength(1);

    // The op that crosses the budget is trimmed and marked truncated…
    step.partial({ description: `${big}-over-the-cap` });
    vi.advanceTimersByTime(AI_CHUNK_FLUSH_MS);
    expect(chunkEvents()).toHaveLength(2);
    const lastOp = chunkEvents()[1].data.ops.at(-1)!;
    expect(lastOp.text).toContain('… (stream truncated)');

    // …and after that the step emits NOTHING further.
    step.partial({ description: `${big}-over-the-cap-and-still-growing` });
    vi.advanceTimersByTime(AI_CHUNK_FLUSH_MS * 2);
    expect(chunkEvents()).toHaveLength(2);

    // The db snapshot kept accumulating regardless (head/tail-capped there).
    step.done();
    const row = db.getAiStep(stepId)!;
    expect(row.responseText).not.toBeNull();
    expect(row.responseText!.length).toBeLessThanOrEqual(AI_LOG_TEXT_CAP + 200);
    expect(row.responseText).toContain('chars elided');
  });

  it('masks prompts and scrubs registered secrets from error messages unconditionally', () => {
    const secret = `${'S'.repeat(48)} super secret reference line`;
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    run.registerSecret(secret);

    const step = run.step({
      slug: 'repair',
      label: 'Fixing tests',
      kind: 'llm',
      prompt: `## Reference Solution\n\n\`\`\`\n${secret}\n\`\`\`\n\n## Task\n\nfix it`,
    });
    const stepId = (events.find((e) => e.name === 'ai-step-started')!.data.step as AiStepSummary)
      .id;
    const created = db.getAiStep(stepId)!;
    expect(created.promptText).toContain(WITHHELD_MARKER);
    expect(created.promptText).not.toContain(secret);
    expect(created.promptText).toContain('fix it');

    // Provider errors sometimes echo the prompt — the scrub is the backstop.
    step.fail(`provider 500 — request rejected; echo: ${secret}`);
    const failed = db.getAiStep(stepId)!;
    expect(failed.status).toBe('error');
    expect(failed.errorMessage).not.toContain(secret);
    expect(failed.errorMessage).toContain(WITHHELD_MARKER);
    expect(failed.errorMessage).toContain('provider 500');

    run.fail(`run-level echo: ${secret}`);
    expect(db.getAiRun(run.runId)!.errorMessage).not.toContain(secret);
  });

  it('closes still-running steps when the run ends so nothing pulses forever', () => {
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    run.step({ slug: 'draft-problem', label: 'Writing', kind: 'llm' });
    const stepId = (events.find((e) => e.name === 'ai-step-started')!.data.step as AiStepSummary)
      .id;

    run.fail('provider exploded');
    const step = db.getAiStep(stepId)!;
    expect(step.status).toBe('error');
    expect(db.getAiRun(run.runId)!.status).toBe('error');
    // Steps created after the run ended are inert.
    expect(events.filter((e) => e.name === 'ai-step-started')).toHaveLength(1);
    run.step({ slug: 'scaffold', label: 'late', kind: 'scaffold' }).done();
    expect(events.filter((e) => e.name === 'ai-step-started')).toHaveLength(1);
  });

  it('swallows every db write after close — the log never turns a paid call into a crash', () => {
    vi.useFakeTimers();
    const run = log.startRun({ kind: 'generation', refId: null, questionId: null, label: 't' });
    const step = run.step({ slug: 'draft-problem', label: 'Writing', kind: 'llm' });
    db.close();

    expect(() => {
      step.partial({ title: 'still streaming' });
      vi.advanceTimersByTime(AI_CHUNK_FLUSH_MS);
      step.done('done anyway');
      run.done();
    }).not.toThrow();

    // startRun on a closed db degrades to an inert handle, silently.
    const countBefore = events.length;
    const dead = log.startRun({ kind: 'review', refId: null, questionId: null, label: 'x' });
    expect(dead.runId).toBe('');
    expect(() => {
      dead.step({ slug: 'draft-problem', label: 'x', kind: 'llm' }).done();
      dead.done();
    }).not.toThrow();
    expect(events.length).toBe(countBefore);
  });

  it('NULL_AI_LOG is fully inert', () => {
    const run = NULL_AI_LOG.startRun({
      kind: 'generation',
      refId: null,
      questionId: null,
      label: 'x',
    });
    expect(run.runId).toBe('');
    expect(() => {
      const step = run.step({ slug: 'draft-problem', label: 'x', kind: 'llm' });
      step.append('a');
      step.partial({ title: 'b' });
      step.done();
      run.registerSecret('s');
      run.done();
    }).not.toThrow();
    expect(events).toHaveLength(0);
  });
});
