import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import type { createGenerationEngine as CreateGenerationEngineFn } from './generation.js';
import { openDb } from './db.js';
import { createBus, type Bus } from './sse.js';
import type { AceDb } from './types.js';

// `resolveProvider` (called by the engine) transitively imports lib/llm.js,
// whose mock-vs-real behavior is a module-level const read at import time —
// same reason cli/lib/llm.test.ts and brainstorm.test.ts set the env var in
// beforeAll before a dynamic import, rather than a static top-level one.
let createGenerationEngine: typeof CreateGenerationEngineFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ createGenerationEngine } = await import('./generation.js'));
});

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
};

/**
 * Queue-based fake `chatObject`: each invocation pops the next handler.
 * Handlers return a raw payload — validated against the CALLER's own schema,
 * mirroring what `generateObject` really does — or throw directly.
 */
function makeFakeLlm(
  handlers: Array<
    (
      provider: LLMProvider,
      messages: LLMMessage[],
      opts?: { abortSignal?: AbortSignal; maxOutputTokens?: number },
    ) => unknown | Promise<unknown>
  >,
) {
  const calls: Array<{
    provider: LLMProvider;
    messages: LLMMessage[];
    opts?: { abortSignal?: AbortSignal; maxOutputTokens?: number };
  }> = [];
  let i = 0;
  const chatObject = async (
    provider: LLMProvider,
    messages: LLMMessage[],
    schema: any,
    opts?: { abortSignal?: AbortSignal; maxOutputTokens?: number },
  ) => {
    calls.push({ provider, messages, opts });
    const handler = handlers[i++];
    if (!handler) throw new Error('fake llm: no more handlers queued');
    const payload = await handler(provider, messages, opts);
    return schema.parse(payload);
  };
  return {
    llm: { chatObject } as unknown as Parameters<typeof CreateGenerationEngineFn>[0]['llm'],
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

    const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });
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

    const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });
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
    const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });
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

  it('lands on status error with a message when the llm call is aborted (simulating the 180s timeout)', async () => {
    const { llm, calls } = makeFakeLlm([
      (provider, messages, opts) => {
        // Real behavior: AbortSignal.timeout(180_000) is passed through as
        // opts.abortSignal; simulate it firing without waiting 180s.
        expect(opts?.abortSignal).toBeInstanceOf(AbortSignal);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ]);

    const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });
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
    expect(calls).toHaveLength(1);
    expect(engine.isAnyRunning()).toBe(false);
  });

  it('emits nothing and writes nothing after dispose(), even though the llm resolves later', async () => {
    let resolvePayload!: (v: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolvePayload = resolve;
    });
    const { llm, calls } = makeFakeLlm([async () => pending]);
    const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });

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
    const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });
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

  it('salvages the parsed JSON to disk when the llm_done db write throws', async () => {
    const { llm, calls } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD]);
    const throwingDb = makeThrowOnLlmDoneDb(db);
    const engine = createGenerationEngine({ db: throwingDb, bus, workspaceRoot: tempRoot, llm });
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

    // The db write itself never landed, so the job row's own result column
    // stays null — the salvage file on disk is the copy of record here.
    const job = db.getGenerationJob(jobId)!;
    expect(job.status).toBe('error');
    expect(job.result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  describe('slug sanitization and collision handling', () => {
    it('suffixes -2 on a same-slug collision, keeping both question dirs and rows', async () => {
      const { llm } = makeFakeLlm([() => VALID_GENERATED_PAYLOAD, () => VALID_GENERATED_PAYLOAD]);
      const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });

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
      const engine = createGenerationEngine({ db, bus, workspaceRoot: tempRoot, llm });
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
  });
});
