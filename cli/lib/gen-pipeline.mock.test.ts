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

describe('generateVerifiedQuestion in mock mode', () => {
  it('returns after stage 1 — no audit, no sandbox verification', async () => {
    const stage1 = {
      title: 'Two Sum',
      slug: 'two-sum',
      description: 'desc',
      signature: 'export function twoSum(nums: number[], target: number): number[]',
      testCode: 'tests',
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: null,
    };
    const chatObject = vi.fn(async () => stage1);
    const verify = vi.fn();

    const result = await generateVerifiedQuestion(
      {
        provider: 'openai',
        category: 'js-ts',
        difficulty: 'easy',
        userMessage: 'topic',
        workspaceRoot: '/nonexistent-not-touched',
      },
      { llm: { chatObject: chatObject as never }, verify: verify as never },
    );

    expect(result.question.title).toBe('Two Sum');
    expect(result.edgeCases).toBeNull();
    expect(chatObject).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });
});
