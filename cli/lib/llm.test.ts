import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATEGORY_SLUGS } from './categories.js';
import type { chatObject as ChatObjectFn } from './llm.js';

// `mockLlm` inside ./llm.js is a module-level const read once at import
// time, so ACE_E2E_MOCK_LLM must be set BEFORE the module is first
// imported — a static top-level `import` is hoisted ahead of any statement
// in this file, so we set the env var in beforeAll and import dynamically
// (same pattern used by cli/server/workspace-reset.test.ts).
let chatObject: typeof ChatObjectFn;

beforeAll(async () => {
  process.env.ACE_E2E_MOCK_LLM = '1';
  ({ chatObject } = await import('./llm.js'));
});

// Mirrors cli/commands/generate.ts's GeneratedQuestionSchema.
const GeneratedQuestionSchema = z.object({
  title: z.string(),
  slug: z.string().nullish(),
  description: z.string().nullish(),
  signature: z.string().nullish(),
  testCode: z.string().nullish(),
  solutionCode: z.string().nullish(),
});

// Mirrors the planned brainstorm-engine IdeaListSchema.
const IdeaListSchema = z.object({
  reply: z.string(),
  ideas: z
    .array(
      z.object({
        title: z.string(),
        category: z.enum(CATEGORY_SLUGS),
        difficulty: z.enum(['easy', 'medium', 'hard']),
        pitch: z.string(),
        topic: z.string(),
      }),
    )
    .max(5),
});

// Loose enough to validate against ANY plain object — used to prove that an
// explicit ACE_MOCK_LLM_MODE override wins even when schema-dispatch would
// otherwise have matched a different (earlier-tried) candidate.
const PermissiveSchema = z.record(z.string(), z.unknown());

// Matches none of the mock candidates (generate/dispute/brainstorm/
// review-extraction all lack a `foo` field), so it exercises the existing
// parse-failure fallback.
const UnmatchedSchema = z.object({ foo: z.string() });

const originalMode = process.env.ACE_MOCK_LLM_MODE;

beforeEach(() => {
  delete process.env.ACE_MOCK_LLM_MODE;
});

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.ACE_MOCK_LLM_MODE;
  } else {
    process.env.ACE_MOCK_LLM_MODE = originalMode;
  }
});

describe('chatObject mock schema-dispatch', () => {
  it('returns the generate payload for a GeneratedQuestionSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('openai', [], GeneratedQuestionSchema);
    expect(result.title).toBe('Two Sum');
    expect(result.slug).toBe('two-sum');
  });

  it('returns the brainstorm payload for an IdeaListSchema-shaped call, no mode var set', async () => {
    const result = await chatObject('openai', [], IdeaListSchema);
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.ideas.length).toBeGreaterThan(0);
    for (const idea of result.ideas) {
      expect(CATEGORY_SLUGS).toContain(idea.category);
      expect(['easy', 'medium', 'hard']).toContain(idea.difficulty);
    }
  });

  it('honors an explicit ACE_MOCK_LLM_MODE override even when the schema would otherwise match generate', async () => {
    process.env.ACE_MOCK_LLM_MODE = 'dispute';
    const result = (await chatObject('openai', [], PermissiveSchema)) as Record<string, unknown>;
    expect(result.verdict).toBe('test_incorrect');
    expect(result.title).toBeUndefined();
  });

  it('falls through to the existing parse-failure behavior when no candidate matches', async () => {
    await expect(chatObject('openai', [], UnmatchedSchema)).rejects.toThrow();
  });
});
