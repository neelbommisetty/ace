import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyFn, VerifyResult } from '../lib/gen-verify.js';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import { getSuggestedTime } from '../lib/categories.js';
import { createGenerationEngine } from './generation.js';
import { openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb } from './types.js';

// The engine's `resolveProvider` option is the keyless-testable seam for
// provider resolution — no real API key, no ACE_E2E_MOCK_LLM env var, and no
// dependency on settings.ts/lib/llm.js's key-configured-in-~/.ace/config.json
// state. Every test below injects both this and the `llm` fake, so the whole
// pipeline runs deterministically off the fakes, keyless.
const FAKE_PROVIDER: () => LLMProvider | null = () => 'openai';

// The verify seam mirrors llm/resolveProvider: temp workspaces have no vitest
// binary, so every test injects a fake verifier. Green by default.
const VERIFY_GREEN: VerifyResult = {
  green: true,
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1 },
  failureReport: null,
};
const VERIFY_RED: VerifyResult = {
  green: false,
  summary: { total: 1, passed: 0, failed: 1, skipped: 0, durationMs: 1 },
  failureReport: '✕ generated test failed\nexpected 1 to be 2',
};
const FAKE_VERIFY_GREEN: VerifyFn = async () => VERIFY_GREEN;

let tempRoot = '';
let db: AceDb;
let bus: Bus;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-generation-test-'));
  db = openDb(tempRoot);
  bus = createBus();
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const VALID_GENERATED_PAYLOAD = {
  title: 'Two Sum Variant',
  slug: 'two-sum-variant',
  description: 'Return indices of two numbers that add up to a target.',
  signature: 'export function twoSumVariant(nums: number[], target: number): number[]',
  testCode:
    "import { describe, it, expect } from 'vitest';\nimport { twoSumVariant } from './solution.js';\n\ndescribe('twoSumVariant', () => {\n  it('works', () => {\n    expect(twoSumVariant([2, 7], 9)).toEqual([0, 1]);\n  });\n});\n",
  solutionCode: 'export function twoSumVariant(nums, target) { return CHEATER_SOLUTION_MARKER; }',
  // The pipeline's stage-3 static check requires a reference solution for
  // coding categories; without it every run burns all repair attempts.
  referenceSolution:
    'export function twoSumVariant(nums: number[], target: number): number[] {\n  return [0, 1];\n}\n',
  // Required-and-nullable in GeneratedQuestionSchema (strict structured
  // outputs, NEE-263) — the key must be present even when unused.
  interviewerPacket: null,
  // Coding-only LLM time estimate (null here — the estimate-resolution tests
  // below override it per-case) and the react-apps-only support module (null
  // — leetcode-ds has no supportFiles). Same required-and-nullable rule.
  estimatedMinutes: null,
  supportCode: null,
  // competency/followUps (NEE-343, behavioral-only) — same required-and-
  // nullable rule; this fixture drives coding-category tests, so both stay
  // null.
  competency: null,
  followUps: null,
};

/** The opts shape the pipeline's streaming call passes through to the fake. */
interface FakeLlmOpts {
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  purpose?: string;
  onPartial?: (partial: Record<string, unknown>) => void;
}

/**
 * Queue-based fake `chatObjectStream` (the pipeline's sole entry point since
 * NEE-264): each invocation pops the next handler. Handlers return a raw
 * payload — validated against the CALLER's own schema, mirroring what the
 * real call does — or throw directly.
 */
function makeFakeLlm(
  handlers: Array<
    (
      provider: LLMProvider,
      messages: LLMMessage[],
      opts?: FakeLlmOpts,
    ) => unknown | Promise<unknown>
  >,
  /**
   * The stage-2.5 calibrate call (coding AND design, never behavioral) also
   * needs a generic default response, same rationale as edge-audit below: it
   * must not consume the `handlers` queue, or every pre-existing coding/
   * design test would need to grow an extra handler entry just to survive
   * this new stage. `estimatedMinutes` is the one knob the estimate-
   * resolution tests below actually need to vary.
   */
  calibration: { estimatedMinutes?: number | null } = {},
) {
  const calls: Array<{
    provider: LLMProvider;
    messages: LLMMessage[];
    opts?: FakeLlmOpts;
  }> = [];
  let i = 0;
  const chatObjectStream = async (
    provider: LLMProvider,
    messages: LLMMessage[],
    schema: any,
    opts?: FakeLlmOpts,
  ) => {
    // The pipeline's stage-2 edge-audit call is answered generically (no
    // changed artifacts) so handler queues — and the generate-call log —
    // stay exactly as before the pipeline landed.
    if (opts?.purpose === 'edge-audit') {
      return schema.parse({
        edgeCases: [],
        description: null,
        testCode: null,
        supportCode: null,
        referenceSolution: null,
        interviewerPacket: null,
      });
    }
    if (opts?.purpose === 'calibrate') {
      return schema.parse({
        verdict: 'fits',
        estimatedMinutes: calibration.estimatedMinutes ?? null,
        issues: null,
      });
    }
    calls.push({ provider, messages, opts });
    const handler = handlers[i++];
    if (!handler) throw new Error('fake llm: no more handlers queued');
    const payload = await handler(provider, messages, opts);
    return schema.parse(payload);
  };
  return {
    llm: { chatObjectStream } as unknown as Parameters<typeof createGenerationEngine>[0]['llm'],
    calls,
  };
}

/**
 * Wraps a real AceDb so its `patchGenerationJob` throws once, the first time
 * it's called with `status: 'llm_done'` — simulating a db write failure right
 * after a paid LLM call succeeds, to exercise the salvage-to-disk path.
 * Every other method (and every other call) forwards to the real db.
 */
function makeThrowOnLlmDoneDb(realDb: AceDb): AceDb {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'patchGenerationJob') {
        return (id: string, patch: Parameters<AceDb['patchGenerationJob']>[1]) => {
          if (patch.status === 'llm_done') {
            throw new Error('simulated db failure on llm_done patch');
          }
          return target.patchGenerationJob(id, patch);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AceDb;
}

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

describe('createGenerationEngine', () => {
  it('runs the happy path in order: started -> llm -> persisted+scaffolded -> done, with db state terminal before generation-done is observable', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);

    let sawDbTerminalInsideEmit = false;
    bus.subscribe((name, data) => {
      if (name === 'generation-done') {
        const { jobId, question } = data as { jobId: string; question: any };
        const job = db.getGenerationJob(jobId)!;
        expect(job.status).toBe('done');
        expect(job.questionId).toBe(question.id);
        expect(db.getQuestionById(question.id)).not.toBeNull();
        sawDbTerminalInsideEmit = true;
      }
    });

    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const done = waitFor('generation-done');

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'medium',
      topic: 'two sum variant',
    });

    const { question } = await done;
    expect(sawDbTerminalInsideEmit).toBe(true);
    expect(question.category).toBe('leetcode-ds');
    expect(question.slug).toBe('two-sum-variant');
    expect(question.source).toBe('generated');

    const job = db.getGenerationJob(jobId)!;
    expect(job.status).toBe('done');
    expect(job.slug).toBe('two-sum-variant');
    expect(job.title).toBe('Two Sum Variant');
    expect(job.result).toEqual(VALID_GENERATED_PAYLOAD);

    expect(calls).toHaveLength(1);
    expect(engine.isAnyRunning()).toBe(false);
    expect(engine.runningCount()).toBe(0);
  });

  it('emits generation-started with the full row (category/topic/createdAt) before the llm call is made', async () => {
    const order: string[] = [];
    const { llm } = makeFakeLlm([
      () => {
        order.push('llm-called');
        return VALID_GENERATED_PAYLOAD;
      },
    ]);

    const startedEvents: any[] = [];
    bus.subscribe((name, data) => {
      if (name === 'generation-started') {
        order.push('generation-started');
        startedEvents.push(data);
      }
    });

    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const done = waitFor('generation-done');

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'hard',
      topic: 'a topic string',
    });

    expect(startedEvents).toHaveLength(1);
    const { job } = startedEvents[0];
    expect(job.id).toBe(jobId);
    expect(job.status).toBe('running');
    expect(job.category).toBe('leetcode-ds');
    expect(job.difficulty).toBe('hard');
    expect(job.topic).toBe('a topic string');
    expect(typeof job.createdAt).toBe('string');
    expect(job.createdAt.length).toBeGreaterThan(0);

    await done;
    expect(order).toEqual(['generation-started', 'llm-called']);
  });

  it('discards the LLM solutionCode — the scaffolded file on disk is the signature-based stub, not the LLM solution', async () => {
    const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const done = waitFor('generation-done');

    engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
    const { question } = await done;

    const solutionPath = path.join(question.dirPath, 'solution.ts');
    const content = fs.readFileSync(solutionPath, 'utf8');
    expect(content).not.toContain('CHEATER_SOLUTION_MARKER');
    expect(content).toContain('TODO: implement');
    expect(content).toContain(VALID_GENERATED_PAYLOAD.signature);

    const testPath = path.join(question.dirPath, 'solution.test.ts');
    expect(fs.readFileSync(testPath, 'utf8').trim()).toBe(VALID_GENERATED_PAYLOAD.testCode.trim());
  });

  it('lands on status error with a message when the llm call is aborted mid-stream (simulating the stall timeout)', async () => {
    const { llm, calls } = makeFakeLlm([
      (provider, messages, opts) => {
        // Real behavior: the pipeline passes its stall/ceiling controller's
        // signal as opts.abortSignal; simulate the stall abort landing
        // mid-stream — after partials already flowed — without waiting 300s.
        expect(opts?.abortSignal).toBeInstanceOf(AbortSignal);
        opts?.onPartial?.({ title: 'Two' });
        opts?.onPartial?.({ title: 'Two Sum Variant' });
        throw new DOMException(
          'no output from the model for 300s — generation looks stalled',
          'TimeoutError',
        );
      },
    ]);

    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const errored = waitFor('generation-error');

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'medium',
      topic: 'two sum variant',
    });

    const { message } = await errored;
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);

    const job = db.getGenerationJob(jobId)!;
    expect(job.status).toBe('error');
    expect(job.errorMessage).toBe(message);
    expect(job.questionId).toBeNull();
    // Persist-before-ack still holds with the abort landing mid-stream:
    // un-parsed partials are never persisted (onStageResult only fires on
    // complete stage outputs), so no unverified junk lands in `result`.
    expect(job.result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(engine.isAnyRunning()).toBe(false);
  });

  it('emits nothing and writes nothing after dispose(), even though the llm resolves later', async () => {
    let resolvePayload!: (v: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolvePayload = resolve;
    });
    const { llm, calls } = makeFakeLlm([async () => pending]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });

    const events: string[] = [];
    bus.subscribe((name) => events.push(name));

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'medium',
      topic: 'two sum variant',
    });
    expect(calls).toHaveLength(1);

    engine.dispose();
    const countAtDispose = events.length;

    resolvePayload(VALID_GENERATED_PAYLOAD);
    // Let the microtask/timer queue drain so runJob's continuation runs.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.length).toBe(countAtDispose);

    // No further writes past the point dispose() flipped: the job row is
    // still 'running' (the initial create is the only write that happened).
    const job = db.getGenerationJob(jobId)!;
    expect(job.status).toBe('running');
    expect(job.result).toBeNull();

    // No question dir should have been scaffolded either.
    expect(fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant'))).toBe(
      false,
    );
  });

  it('leaves status error with result_json intact when scaffolding fails after a successful LLM call', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const errored = waitFor('generation-error');

    // Fail exactly the mkdirSync call scaffoldQuestionAt makes for the
    // question dir (the slug is already unique, so this is a pure I/O
    // failure, not a collision) — mockImplementationOnce falls back to the
    // real implementation afterward, so nothing else in the test is affected.
    const mkdirSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied, mkdir');
      });

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'medium',
      topic: 'two sum variant',
    });

    const { message } = await errored;
    expect(message).toContain('question files could not be written');
    mkdirSpy.mockRestore();

    const job = db.getGenerationJob(jobId)!;
    expect(job.status).toBe('error');
    expect(job.errorMessage).toBe(message);
    // The paid LLM result must survive a scaffold failure — a retry can
    // reuse it without spending a second LLM call.
    expect(job.result).toEqual(VALID_GENERATED_PAYLOAD);
    expect(job.title).toBe(VALID_GENERATED_PAYLOAD.title);
    expect(job.slug).toBe('two-sum-variant');
    expect(job.questionId).toBeNull();

    expect(calls).toHaveLength(1);
    expect(
      fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant')),
    ).toBe(false);
  });

  it('retry re-scaffolds (rather than landing done with an empty dir) when the question dir exists but is empty from a prior write failure', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const errored = waitFor('generation-error');

    // Unlike the mkdirSync-failure test above, let mkdir succeed (the dir
    // gets created) but fail the very first file write inside it
    // (README.md) — leaves an empty, partially-scaffolded dir on disk.
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device, write');
      });

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'medium',
      topic: 'two sum variant',
    });
    await errored;
    writeSpy.mockRestore();

    const dir = path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);

    const failedJob = db.getGenerationJob(jobId)!;
    expect(failedJob.status).toBe('error');

    const done = waitFor('generation-done');
    engine.retry(failedJob);
    const { question } = await done;

    // Must NOT land 'done' with the empty dir left untouched — the empty
    // dir is wiped and re-scaffolded from scratch.
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);

    const finalJob = db.getGenerationJob(jobId)!;
    expect(finalJob.status).toBe('done');
    expect(finalJob.questionId).toBe(question.id);
    expect(calls).toHaveLength(1); // scaffold-only resume, no second llm call
  });

  it('salvages the parsed JSON to disk when the llm_done db write throws', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const throwingDb = makeThrowOnLlmDoneDb(db);
    const engine = createGenerationEngine({
      db: throwingDb,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    const errored = waitFor('generation-error');

    const { jobId } = engine.start({
      category: 'leetcode-ds',
      difficulty: 'medium',
      topic: 'two sum variant',
    });

    const { message } = await errored;
    expect(message).toContain('could not be saved');
    expect(message).toContain('salvaged to');

    const salvagePath = path.join(tempRoot, '.ace', `generation-salvage-${jobId}.json`);
    expect(fs.existsSync(salvagePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(salvagePath, 'utf8'))).toEqual(VALID_GENERATED_PAYLOAD);

    // Only the final llm_done patch threw; the per-stage onStageResult
    // patches (plain { result }, no status) landed fine — so the paid output
    // survives in BOTH the db row and the salvage file.
    const job = db.getGenerationJob(jobId)!;
    expect(job.status).toBe('error');
    expect((job.result as { title?: string } | null)?.title).toBe('Two Sum Variant');
    expect(calls).toHaveLength(1);
  });

  describe('slug sanitization and collision handling', () => {
    it('suffixes -2 on a same-slug collision, keeping both question dirs and rows', async () => {
      const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD, () => VALID_GENERATED_PAYLOAD]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });

      const firstDone = waitFor('generation-done');
      engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
      const { question: q1 } = await firstDone;

      const secondDone = waitFor('generation-done');
      engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
      const { question: q2 } = await secondDone;

      expect(q1.slug).toBe('two-sum-variant');
      expect(q2.slug).toBe('two-sum-variant-2');
      expect(q1.id).not.toBe(q2.id);

      expect(
        fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant-2')),
      ).toBe(true);

      expect(db.getQuestionById(q1.id)).not.toBeNull();
      expect(db.getQuestionById(q2.id)).not.toBeNull();
    });

    it('rejects a path-traversal slug from the LLM and falls back to slugify(title)', async () => {
      const maliciousPayload = {
        ...VALID_GENERATED_PAYLOAD,
        title: 'Sneaky Title',
        slug: '../evil',
      };
      const { llm } = makeFakeLlm([() => maliciousPayload]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });
      const done = waitFor('generation-done');

      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'irrelevant topic',
      });
      const { question } = await done;

      expect(question.slug).toBe('sneaky-title');
      const job = db.getGenerationJob(jobId)!;
      expect(job.slug).toBe('sneaky-title');

      const questionsRoot = path.resolve(tempRoot, 'questions', 'leetcode-ds');
      expect(path.resolve(question.dirPath)).toBe(path.join(questionsRoot, 'sneaky-title'));
      expect(path.resolve(question.dirPath).startsWith(questionsRoot + path.sep)).toBe(true);

      // Never escaped the questions dir: no 'evil' directory anywhere near it.
      expect(fs.existsSync(path.join(tempRoot, 'questions', 'evil'))).toBe(false);
      expect(fs.existsSync(path.join(tempRoot, 'evil'))).toBe(false);
    });

    it('falls back to a default base slug when neither title nor topic slugify to anything (non-ASCII input)', async () => {
      // Both slugify(title) and slugify(topic) collapse to '' here — no LLM
      // slug, no ASCII alphanumerics anywhere. Without a fallback default,
      // every -N candidate starts with '-' (or is '') and fails SLUG_RE,
      // so resolveSlug would throw "too many collisions" (a misleading
      // diagnosis — nothing collided) and strand the already-paid-for LLM
      // result on the job row forever.
      const nonAsciiPayload = {
        ...VALID_GENERATED_PAYLOAD,
        title: '二分探索の問題',
        // "No LLM slug" is an explicit null under the required-and-nullable
        // schema (NEE-263) — an absent/undefined key no longer parses.
        slug: null,
      };
      const { llm } = makeFakeLlm([() => nonAsciiPayload]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });
      const done = waitFor('generation-done');

      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: '二分探索',
      });
      const { question } = await done;

      expect(question.slug).toBe('question');
      const job = db.getGenerationJob(jobId)!;
      expect(job.status).toBe('done');
      expect(job.slug).toBe('question');
    });
  });

  describe('retry', () => {
    it('resumes scaffold-only from a persisted result_json — the llm is never called a second time', async () => {
      const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });

      // Force the first attempt to fail purely at the scaffold-I/O step, so
      // result_json/title/slug are already persisted before it errors out.
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementationOnce(() => {
          throw new Error('EACCES: permission denied, mkdir');
        });

      const errored = waitFor('generation-error');
      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'two sum variant',
      });
      await errored;
      mkdirSpy.mockRestore();

      const failedJob = db.getGenerationJob(jobId)!;
      expect(failedJob.status).toBe('error');
      expect(failedJob.result).toEqual(VALID_GENERATED_PAYLOAD);
      expect(failedJob.slug).toBe('two-sum-variant');

      const startedEvents: any[] = [];
      bus.subscribe((name, data) => {
        if (name === 'generation-started') startedEvents.push(data);
      });

      const done = waitFor('generation-done');
      const { jobId: retryJobId } = engine.retry(failedJob);
      expect(retryJobId).toBe(jobId); // same jobId, re-emitted

      const { question } = await done;
      expect(question.slug).toBe('two-sum-variant');
      expect(question.source).toBe('generated');

      const finalJob = db.getGenerationJob(jobId)!;
      expect(finalJob.status).toBe('done');
      expect(finalJob.questionId).toBe(question.id);
      expect(finalJob.errorMessage).toBeNull();

      // The llm fake's queue only ever had one handler — a second call would
      // throw "no more handlers queued" and fail the job, so a 'done' status
      // here already proves no second call happened; this is the direct count check.
      expect(calls).toHaveLength(1);

      expect(startedEvents.some((e) => e.job.id === jobId)).toBe(true);
      expect(
        fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant')),
      ).toBe(true);
    });

    it('re-runs the full pipeline (new llm call) when no result_json was ever persisted', async () => {
      const { llm, calls } = makeFakeLlm([
        () => {
          throw new Error('simulated transient provider failure');
        },
        () => VALID_GENERATED_PAYLOAD,
      ]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });

      const errored = waitFor('generation-error');
      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'two sum variant',
      });
      await errored;

      const failedJob = db.getGenerationJob(jobId)!;
      expect(failedJob.status).toBe('error');
      expect(failedJob.result).toBeNull();
      expect(failedJob.slug).toBeNull();

      const done = waitFor('generation-done');
      const { jobId: retryJobId } = engine.retry(failedJob);
      expect(retryJobId).toBe(jobId);

      const { question } = await done;
      expect(question.slug).toBe('two-sum-variant');

      expect(calls).toHaveLength(2);
      const finalJob = db.getGenerationJob(jobId)!;
      expect(finalJob.status).toBe('done');
      expect(finalJob.result).toEqual(VALID_GENERATED_PAYLOAD);
    });

    it('re-stamps run_started_at (elapsed clock restarts) without moving created_at (NEE-277)', async () => {
      const { llm } = makeFakeLlm([
        () => {
          throw new Error('simulated transient provider failure');
        },
        () => VALID_GENERATED_PAYLOAD,
      ]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
        verify: FAKE_VERIFY_GREEN,
      });

      const errored = waitFor('generation-error');
      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'two sum variant',
      });
      await errored;

      // Backdate the row so the retry's fresh stamp is unambiguously newer
      // even when this whole test runs within a single millisecond.
      const PAST = '2026-01-01T00:00:00.000Z';
      const raw = new DatabaseSync(path.join(tempRoot, '.ace', 'ace.db'));
      raw
        .prepare('UPDATE generation_jobs SET created_at = ?, run_started_at = ? WHERE id = ?')
        .run(PAST, PAST, jobId);
      raw.close();

      const startedEvents: any[] = [];
      bus.subscribe((name, data) => {
        if (name === 'generation-started') startedEvents.push(data);
      });

      const done = waitFor('generation-done');
      engine.retry(db.getGenerationJob(jobId)!);

      const retried = db.getGenerationJob(jobId)!;
      // created_at anchors strip ordering and must never move on a retry.
      expect(retried.createdAt).toBe(PAST);
      expect(Date.parse(retried.runStartedAt)).toBeGreaterThan(Date.parse(PAST));
      // The re-emitted 'generation-started' row carries the fresh stamp — the
      // strip's clock reads it straight off the SSE payload after a retry.
      expect(startedEvents[0].job.runStartedAt).toBe(retried.runStartedAt);
      await done;
    });

    it('corrects provenance to generated when a question row was already pre-inserted as manual (boot-reconcile race)', async () => {
      const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });

      // First attempt fails at the scaffold step — result/slug persisted,
      // no files/question row created yet.
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementationOnce(() => {
          throw new Error('EACCES: permission denied, mkdir');
        });
      const errored = waitFor('generation-error');
      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'two sum variant',
      });
      await errored;
      mkdirSpy.mockRestore();

      const failedJob = db.getGenerationJob(jobId)!;
      expect(failedJob.slug).toBe('two-sum-variant');

      // Simulate boot-time reconcile racing the retry: it finds the
      // scorecard-less dir on disk (from some earlier partial write in a
      // real crash) and inserts it as 'manual' before the engine's own
      // upsert runs.
      const preInserted = db.upsertQuestion({
        category: 'leetcode-ds',
        slug: 'two-sum-variant',
        title: 'stale title',
        difficulty: 'medium',
        suggestedMinutes: 30,
        dirPath: path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant'),
        source: 'manual',
      });
      expect(preInserted.source).toBe('manual');

      const done = waitFor('generation-done');
      engine.retry(failedJob);
      const { question } = await done;

      expect(question.id).toBe(preInserted.id); // same row, re-asserted provenance
      expect(question.source).toBe('generated');
      expect(db.getQuestionById(question.id)!.source).toBe('generated');
      expect(calls).toHaveLength(1);
    });

    it('does not merge onto another job\'s completed question when the recorded slug was claimed by that job before this one retries', async () => {
      const { llm, calls } = makeFakeLlm([
        () => VALID_GENERATED_PAYLOAD, // job1's first (failing-at-scaffold) attempt
        () => VALID_GENERATED_PAYLOAD, // job2's successful attempt
        // job1's retry reuses its persisted result (resumeFromResult) — no
        // third handler needed, and none queued proves it isn't called.
      ]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });

      // job1: fails at mkdir — slug 'two-sum-variant' is recorded on its job
      // row, but the dir is never created, so the slug is invisible to any
      // fs-only or db-only collision check.
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementationOnce(() => {
          throw new Error('EACCES: permission denied, mkdir');
        });
      const job1Errored = waitFor('generation-error');
      const { jobId: job1Id } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'two sum variant',
      });
      await job1Errored;
      mkdirSpy.mockRestore();

      const job1Failed = db.getGenerationJob(job1Id)!;
      expect(job1Failed.slug).toBe('two-sum-variant');

      // job2: fresh job, same topic — resolveSlug's fs probe finds no dir
      // (job1 never created one) so it claims the SAME slug and completes
      // fully, becoming the real owner of 'two-sum-variant'.
      const job2Done = waitFor('generation-done');
      engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
      const { question: q2 } = await job2Done;
      expect(q2.slug).toBe('two-sum-variant');
      expect(q2.source).toBe('generated');
      expect(q2.title).toBe(VALID_GENERATED_PAYLOAD.title);

      // Retrying job1 must NOT upsert onto q2's row (that would silently
      // overwrite q2's title/difficulty via ON CONFLICT and strand job1
      // pointing at a question it doesn't own). It drops the now-stale
      // reservation and gets a fresh, re-suffixed slug instead. Dropping the
      // reservation means the persisted `result` is also stale for slug
      // purposes but is still reused (no result was invalidated) — the llm
      // is NOT called again; this is still a scaffold-only resume.
      const job1Done = waitFor('generation-done');
      engine.retry(job1Failed);
      const { question: q1 } = await job1Done;

      expect(q1.id).not.toBe(q2.id);
      expect(q1.slug).toBe('two-sum-variant-2');
      expect(q1.source).toBe('generated');

      // q2 must be completely untouched by job1's retry.
      const q2Reloaded = db.getQuestionById(q2.id)!;
      expect(q2Reloaded.title).toBe(VALID_GENERATED_PAYLOAD.title);
      expect(q2Reloaded.slug).toBe('two-sum-variant');

      expect(
        fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tempRoot, 'questions', 'leetcode-ds', 'two-sum-variant-2')),
      ).toBe(true);

      // Only 2 llm calls: job1's original attempt + job2's attempt. job1's
      // retry reuses its persisted result (resumeFromResult) — the stale
      // slug is corrected without spending a third llm call.
      expect(calls).toHaveLength(2);

      const job1Final = db.getGenerationJob(job1Id)!;
      expect(job1Final.status).toBe('done');
      expect(job1Final.slug).toBe('two-sum-variant-2');
      expect(job1Final.questionId).toBe(q1.id);
    });

    it('throws synchronously when retrying a job that is not in an error state', async () => {
      const pending = new Promise<unknown>(() => {
        // never resolves — job stays 'running'
      });
      const { llm } = makeFakeLlm([async () => pending]);
      const engine = createGenerationEngine({
        db,
        bus,
        workspaceRoot: tempRoot,
        llm,
        resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
      });

      const { jobId } = engine.start({
        category: 'leetcode-ds',
        difficulty: 'medium',
        topic: 'two sum variant',
      });

      const runningJob = db.getGenerationJob(jobId)!;
      expect(runningJob.status).toBe('running');
      expect(() => engine.retry(runningJob)).toThrow(/not in an error state/);
    });
  });
});

describe('verified pipeline wiring', () => {
  it('emits generation-progress phases over the bus during a run', async () => {
    const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const phases: Array<{ phase: string; attempt: number }> = [];
    bus.subscribe((name, data) => {
      if (name === 'generation-progress') {
        const p = data as { phase: string; attempt: number };
        phases.push({ phase: p.phase, attempt: p.attempt });
      }
    });
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'js-ts', difficulty: 'easy', topic: 'progress phases' });
    await waitFor('generation-done');
    expect(phases).toEqual([
      { phase: 'generating', attempt: 1 },
      { phase: 'auditing', attempt: 1 },
      { phase: 'calibrating', attempt: 1 },
      { phase: 'verifying', attempt: 1 },
    ]);
  });

  it('clears the persisted result and lands on error when verification is exhausted', async () => {
    // Initial generate + 2 repair calls, all red — the pipeline gives up.
    const { llm, calls } = makeFakeLlm([
      () => VALID_GENERATED_PAYLOAD,
      () => VALID_GENERATED_PAYLOAD,
      () => VALID_GENERATED_PAYLOAD,
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: async () => VERIFY_RED,
    });
    const { jobId } = engine.start({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'always red',
    });
    const errEvent = await waitFor('generation-error');
    expect(errEvent.jobId).toBe(jobId);

    const row = db.getGenerationJob(jobId)!;
    expect(row.status).toBe('error');
    // result cleared so a retry re-runs the FULL pipeline — unverified tests
    // must never reach the scaffold via the scaffold-only resume path.
    expect(row.result).toBeNull();
    expect(row.rawText).toContain('generated test failed');
    expect(calls.length).toBe(3);
    // nothing scaffolded, no question row
    expect(db.getQuestion('js-ts', 'two-sum-variant')).toBeNull();
    expect(fs.existsSync(path.join(tempRoot, 'questions', 'js-ts', 'two-sum-variant'))).toBe(
      false,
    );
  });

  it('retry after verify-exhaustion re-runs the full pipeline with new llm calls', async () => {
    const verdicts = [VERIFY_RED, VERIFY_RED, VERIFY_RED, VERIFY_GREEN];
    const { llm, calls } = makeFakeLlm([
      () => VALID_GENERATED_PAYLOAD, // run 1: initial
      () => VALID_GENERATED_PAYLOAD, // run 1: repair 1
      () => VALID_GENERATED_PAYLOAD, // run 1: repair 2 — still red, exhausted
      () => VALID_GENERATED_PAYLOAD, // retry: fresh initial — green this time
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: async () => verdicts.shift() ?? VERIFY_GREEN,
    });
    const { jobId } = engine.start({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'red then green',
    });
    await waitFor('generation-error');
    expect(calls.length).toBe(3);

    const done = waitFor('generation-done');
    engine.retry(db.getGenerationJob(jobId)!);
    await done;

    // A 4th generate call proves the retry was a full pipeline re-run, not a
    // scaffold-only resume from a stale (cleared) result.
    expect(calls.length).toBe(4);
    const row = db.getGenerationJob(jobId)!;
    expect(row.status).toBe('done');
    expect(row.questionId).not.toBeNull();
    const question = db.getQuestion('js-ts', 'two-sum-variant');
    expect(question).not.toBeNull();
    // The hidden interviewer artifacts are absent here (payload has none) —
    // but the solution stub must never contain the reference/cheater code.
    const solution = fs.readFileSync(path.join(question!.dirPath, 'solution.ts'), 'utf8');
    expect(solution).not.toContain('CHEATER_SOLUTION_MARKER');
  });

  it('clears the persisted result when the pipeline fails mid-flight, so retry re-runs it fully', async () => {
    // Stage 1 succeeds (and is persisted per-stage); the audit call then
    // dies. The persisted result is UNVERIFIED and must not survive into a
    // scaffold-only resume.
    let generateCalls = 0;
    let auditCalls = 0;
    const llm = {
      chatObjectStream: (async (_p: unknown, _m: unknown, schema: any, opts?: { purpose?: string }) => {
        if (opts?.purpose === 'edge-audit') {
          auditCalls++;
          if (auditCalls === 1) throw new Error('provider 500 during audit');
          return schema.parse({
            edgeCases: [],
            description: null,
            testCode: null,
            supportCode: null,
            referenceSolution: null,
            interviewerPacket: null,
          });
        }
        if (opts?.purpose === 'calibrate') {
          return schema.parse({ verdict: 'fits', estimatedMinutes: null, issues: null });
        }
        generateCalls++;
        return schema.parse(VALID_GENERATED_PAYLOAD);
      }) as never,
    } as Parameters<typeof createGenerationEngine>[0]['llm'];
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });

    const { jobId } = engine.start({
      category: 'js-ts',
      difficulty: 'easy',
      topic: 'audit dies once',
    });
    await waitFor('generation-error');

    const errored = db.getGenerationJob(jobId)!;
    expect(errored.status).toBe('error');
    expect(errored.errorMessage).toContain('provider 500');
    // The stage-1 result WAS patched mid-pipeline, but the error must clear
    // it — otherwise retry would scaffold tests that were never verified.
    expect(errored.result).toBeNull();

    const done = waitFor('generation-done');
    engine.retry(db.getGenerationJob(jobId)!);
    await done;
    // Full pipeline re-ran: a second generate call, not a scaffold resume.
    expect(generateCalls).toBe(2);
    expect(db.getGenerationJob(jobId)!.status).toBe('done');
  });

  it('writes .interviewer.md and .reference.md when the pipeline returns them', async () => {
    const { llm } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        referenceSolution: 'export function twoSumVariant() { return [0, 1]; }',
        interviewerPacket: '## Capability Tested\n\nConcurrency realities.',
      }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'js-ts', difficulty: 'easy', topic: 'dotfiles' });
    const { question } = await waitFor('generation-done');

    const packet = fs.readFileSync(path.join(question.dirPath, '.interviewer.md'), 'utf8');
    expect(packet).toContain('Capability Tested');
    const reference = fs.readFileSync(path.join(question.dirPath, '.reference.md'), 'utf8');
    expect(reference).toContain('# Reference Solution');
    expect(reference).toContain('return [0, 1];');
    // The visible solution stub stays the signature-rendered TODO stub.
    const solution = fs.readFileSync(path.join(question.dirPath, 'solution.ts'), 'utf8');
    expect(solution).toContain('// TODO: implement');
    expect(solution).not.toContain('return [0, 1];');
  });
});

describe('estimatedMinutes → suggestedMinutes resolution (resolveSuggestedMinutes)', () => {
  it('feeds the calibrator\'s coding estimate straight into the DB row and the README ("~N minutes")', async () => {
    const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD], { estimatedMinutes: 38 });
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
    const { question } = await waitFor('generation-done');

    expect(question.suggestedMinutes).toBe(38);
    const readme = fs.readFileSync(path.join(question.dirPath, 'README.md'), 'utf8');
    expect(readme).toContain('**Suggested Time:** ~38 minutes');
  });

  it('clamps a too-large coding estimate to the 60-minute hard cap', async () => {
    const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD], { estimatedMinutes: 90 });
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
    const { question } = await waitFor('generation-done');

    expect(question.suggestedMinutes).toBe(60);
  });

  it('falls back to the static suggestedTimes table when no estimate is ever produced', async () => {
    // Neither the generate payload nor the calibrator supplies an estimate
    // (both default to null) — resolveSuggestedMinutes must fall back rather
    // than write a null/NaN suggestedMinutes.
    const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'leetcode-ds', difficulty: 'medium', topic: 'two sum variant' });
    const { question } = await waitFor('generation-done');

    expect(question.suggestedMinutes).toBe(getSuggestedTime('leetcode-ds', 'medium'));
  });

  it('ignores the estimate entirely for design and behavioral categories, keeping the static suggestedTimes table', async () => {
    const { llm: designLlm } = makeFakeLlm(
      [
        () => ({
          title: 'Design a Feed',
          slug: 'design-a-feed',
          description: 'Design a social feed system.',
          signature: null,
          testCode: null,
          supportCode: null,
          solutionCode: null,
          referenceSolution: null,
          interviewerPacket: null,
          estimatedMinutes: 5,
          competency: null,
          followUps: null,
        }),
      ],
      { estimatedMinutes: 5 },
    );
    const designEngine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm: designLlm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    designEngine.start({ category: 'design-fe', difficulty: 'medium', topic: 'design a feed' });
    const { question: designQuestion } = await waitFor('generation-done');
    expect(designQuestion.suggestedMinutes).toBe(getSuggestedTime('design-fe', 'medium'));

    const { llm: behavioralLlm } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        title: 'A Story',
        slug: 'a-story',
        estimatedMinutes: 5, // behavioral skips calibrate entirely — ignored regardless
        competency: 'conflict',
        followUps: null,
      }),
    ]);
    const behavioralEngine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm: behavioralLlm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    behavioralEngine.start({ category: 'behavioral', difficulty: 'medium', topic: 'conflict' });
    const { question: behavioralQuestion } = await waitFor('generation-done');
    expect(behavioralQuestion.suggestedMinutes).toBe(getSuggestedTime('behavioral', 'medium'));
  });

  it('passes the LLM-authored supportCode through scaffoldQuestionAt onto disk (react-apps api.ts)', async () => {
    const supportCode = "export async function fetchTasks() {\n  return [];\n}\n";
    const { llm } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        title: 'Sprint Board',
        slug: 'sprint-board',
        signature: "export default function App() {\n  return null;\n}\n",
        testCode:
          "import { describe, it, expect } from 'vitest';\nimport { render } from '@testing-library/react';\nimport App from './App';\n\ndescribe('App', () => {\n  it('renders', () => {\n    render(<App />);\n  });\n});\n",
        supportCode,
      }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'react-apps', difficulty: 'medium', topic: 'sprint board' });
    const { question } = await waitFor('generation-done');

    expect(fs.readFileSync(path.join(question.dirPath, 'api.ts'), 'utf8')).toBe(supportCode);
  });
});

describe('behavioral generation (NEE-343)', () => {
  /** Seeds an existing behavioral question directly on disk + in the db, mirroring what a prior scaffold produced. */
  function seedBehavioralQuestion(opts: { slug: string; title: string; competency: string | null }) {
    const dir = path.join(tempRoot, 'questions', 'behavioral', opts.slug);
    fs.mkdirSync(dir, { recursive: true });
    const competencyLine = opts.competency ? `**Competency:** ${opts.competency}\n` : '';
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      `# ${opts.title}\n\n**Category:** Behavioral\n**Difficulty:** medium\n**Suggested Time:** ~8 minutes\n${competencyLine}\n---\n\nSome prompt.\n`,
    );
    db.upsertQuestion({
      category: 'behavioral',
      slug: opts.slug,
      title: opts.title,
      difficulty: 'medium',
      suggestedMinutes: 8,
      dirPath: dir,
      source: 'manual',
    });
  }

  it('feeds existing behavioral titles + competencies into the generate user message, requiring a distinct competency', async () => {
    seedBehavioralQuestion({
      slug: 'a-conflict-story',
      title: 'A Conflict You Navigated',
      competency: 'conflict',
    });
    seedBehavioralQuestion({
      slug: 'ambiguous-scope',
      title: 'Ambiguous Scope Mid-Project',
      competency: 'ambiguity',
    });

    const { llm, calls } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        title: 'A New Story',
        slug: 'a-new-story',
        competency: 'mentorship',
        followUps: ['probe'],
      }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'behavioral', difficulty: 'medium', topic: 'mentoring' });
    await waitFor('generation-done');

    expect(calls).toHaveLength(1);
    const userMessage = calls[0].messages[1]?.content ?? '';
    expect(userMessage).toContain('Existing Behavioral Questions');
    expect(userMessage).toContain('"A Conflict You Navigated" — competency: conflict');
    expect(userMessage).toContain('"Ambiguous Scope Mid-Project" — competency: ambiguity');
    expect(userMessage).toContain('choose a distinct');
    expect(userMessage).toContain('competency from the closed vocabulary');
  });

  it('does not append a corpus note for coding categories, and appends nothing when no behavioral questions exist yet', async () => {
    const { llm: llmCoding, calls: callsCoding } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const engineCoding = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm: llmCoding,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engineCoding.start({ category: 'js-ts', difficulty: 'medium', topic: 'irrelevant' });
    await waitFor('generation-done');
    expect(callsCoding[0].messages[1]?.content ?? '').not.toContain('Existing Behavioral Questions');

    const { llm: llmBehavioral, calls: callsBehavioral } = makeFakeLlm([
      () => ({ ...VALID_GENERATED_PAYLOAD, competency: 'conflict', followUps: ['probe'] }),
    ]);
    const engineBehavioral = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm: llmBehavioral,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engineBehavioral.start({ category: 'behavioral', difficulty: 'medium', topic: 'first one' });
    await waitFor('generation-done');
    expect(callsBehavioral[0].messages[1]?.content ?? '').not.toContain(
      'Existing Behavioral Questions',
    );
  });

  it('writes the competency into the README and the followUps into a hidden .probes.md', async () => {
    const { llm } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        title: 'A Conflict You Navigated',
        slug: 'conflict-story',
        competency: 'conflict',
        followUps: ['What would the other engineer say?', 'How would this scale to 10x?'],
      }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'behavioral', difficulty: 'medium', topic: 'conflict' });
    const { question } = await waitFor('generation-done');

    const readme = fs.readFileSync(path.join(question.dirPath, 'README.md'), 'utf8');
    expect(readme).toContain('**Competency:** conflict');

    const probes = fs.readFileSync(path.join(question.dirPath, '.probes.md'), 'utf8');
    expect(probes).toContain('What would the other engineer say?');
    expect(probes).toContain('How would this scale to 10x?');

    // .probes.md is a dotfile and never listed among the scaffolded files
    // returned to the caller's own reconciler-facing list — story.md/README
    // only, mirroring .interviewer.md's own invisibility.
    expect(fs.readdirSync(question.dirPath).sort()).toEqual([
      '.probes.md',
      'README.md',
      'story.md',
    ]);
  });

  it('normalizes a model competency with off-vocabulary casing/spacing before writing the README', async () => {
    const { llm } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        title: 'Influence Story',
        slug: 'influence-story',
        competency: '  Influence Without Authority  ',
        followUps: null,
      }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'behavioral', difficulty: 'medium', topic: 'influence' });
    const { question } = await waitFor('generation-done');

    const readme = fs.readFileSync(path.join(question.dirPath, 'README.md'), 'utf8');
    expect(readme).toContain('**Competency:** influence-without-authority');
  });

  it('degrades an unrecognized competency to no README line rather than failing the job', async () => {
    const { llm } = makeFakeLlm([
      () => ({
        ...VALID_GENERATED_PAYLOAD,
        title: 'Unrecognized Value',
        slug: 'unrecognized-value',
        competency: 'leadership', // not in the closed vocabulary
        followUps: null,
      }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      verify: FAKE_VERIFY_GREEN,
    });
    engine.start({ category: 'behavioral', difficulty: 'medium', topic: 'odd' });
    const { question } = await waitFor('generation-done');

    const readme = fs.readFileSync(path.join(question.dirPath, 'README.md'), 'utf8');
    expect(readme).not.toContain('**Competency:**');
  });

  it('never emits a phantom verify step in the generation-progress/done flow for behavioral', async () => {
    const phases: string[] = [];
    const { llm } = makeFakeLlm([
      () => ({ ...VALID_GENERATED_PAYLOAD, competency: 'failure', followUps: ['probe'] }),
    ]);
    const engine = createGenerationEngine({
      db,
      bus,
      workspaceRoot: tempRoot,
      llm,
      resolveProvider: FAKE_PROVIDER,
      // A verifier that would fail loudly if ever invoked — behavioral must
      // never reach it.
      verify: (async () => {
        throw new Error('verify must never be called for a no-test category');
      }) as VerifyFn,
    });
    bus.subscribe((name, data) => {
      if (name === 'generation-progress') phases.push((data as { phase: string }).phase);
    });
    engine.start({ category: 'behavioral', difficulty: 'medium', topic: 'failure story' });
    await waitFor('generation-done');

    expect(phases).not.toContain('verifying');
    expect(phases).not.toContain('repairing');
  });
});
