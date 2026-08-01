import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { generateVerifiedQuestion as GenerateFn } from './gen-pipeline.js';

// isMockLlm() reads a module-level const at import time, so ACE_E2E_MOCK_LLM
// must be set BEFORE cli/lib/llm.ts is first imported — dynamic import in
// beforeAll, same pattern as cli/lib/llm.test.ts.
let generateVerifiedQuestion: typeof GenerateFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ generateVerifiedQuestion } = await import('./gen-pipeline.js'));
});

const STAGE1 = {
  title: 'Two Sum',
  slug: 'two-sum',
  description: 'desc',
  signature: 'export function twoSum(nums: number[], target: number): number[]',
  testCode: 'tests',
  solutionCode: null,
  referenceSolution: null,
  interviewerPacket: null,
};

const PARAMS = {
  category: 'js-ts' as const,
  difficulty: 'easy' as const,
  userMessage: 'topic',
  workspaceRoot: '/nonexistent-not-touched',
};

describe('generateVerifiedQuestion in mock mode', () => {
  it('authors the whole capsule in ONE call and returns — no staged authoring, no audit, no sandbox verification', async () => {
    const chatObjectStream = vi.fn(async (_slot: string) => STAGE1);
    const verify = vi.fn();

    const result = await generateVerifiedQuestion(PARAMS, {
      llm: { chatObjectStream: chatObjectStream as never },
      verify: verify as never,
    });

    expect(result.question.title).toBe('Two Sum');
    expect(result.edgeCases).toBeNull();
    // ONE call, on the first stage's slot: the mock payload is whole-object,
    // and keyless e2e must not pay four round trips to prove the plumbing.
    expect(chatObjectStream).toHaveBeenCalledTimes(1);
    expect(chatObjectStream.mock.calls[0][0]).toBe('draft-problem');
    expect(verify).not.toHaveBeenCalled();
  });

  it('records the stages it stood in for — and edge-audit, calibrate, verify — as skipped ("mock LLM mode") so keyless e2e renders a complete feed', async () => {
    const events: Array<{ slug: string; status: string; reason?: string }> = [];
    const sink = {
      step(spec: { slug: string }) {
        return {
          append() {},
          partial() {},
          done() {
            events.push({ slug: spec.slug, status: 'done' });
          },
          fail() {
            events.push({ slug: spec.slug, status: 'error' });
          },
          skip(reason?: string) {
            events.push({ slug: spec.slug, status: 'skipped', reason });
          },
        };
      },
      registerSecret() {},
    };

    await generateVerifiedQuestion(PARAMS, {
      llm: { chatObjectStream: (async () => STAGE1) as never },
      verify: vi.fn() as never,
      steps: sink,
    });

    expect(events).toEqual([
      { slug: 'draft-problem', status: 'done' },
      { slug: 'author-solution', status: 'skipped', reason: 'mock LLM mode' },
      { slug: 'author-tests', status: 'skipped', reason: 'mock LLM mode' },
      { slug: 'author-packet', status: 'skipped', reason: 'mock LLM mode' },
      { slug: 'edge-audit', status: 'skipped', reason: 'mock LLM mode' },
      { slug: 'calibrate', status: 'skipped', reason: 'mock LLM mode' },
      { slug: 'verify', status: 'skipped', reason: 'mock LLM mode' },
    ]);
  });
});
