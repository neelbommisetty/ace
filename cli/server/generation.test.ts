import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
});
