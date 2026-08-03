import { describe, expect, it } from 'vitest';
import { zodSchema } from 'ai';
import { getDisputeMockPayload } from '../lib/llm.js';
import { DisputeResultSchema } from './disputes.js';

// Regression for the dispute-flow twin of NEE-378 (same class as NEE-263):
// the codex backend enforces OpenAI strict structured-output mode, which
// requires `required` to list every key in `properties` — a `.nullish()`
// field is emitted as optional and 400s the whole call. `zodSchema()` is the
// conversion the streaming call applies, so this pins the emitted wire
// schema, not a re-implementation of it.
describe('DisputeResultSchema is strict-structured-output compatible', () => {
  const emitted = zodSchema(DisputeResultSchema).jsonSchema;

  it('lists every property in required, nested objects included', () => {
    const walk = (node: unknown, path: string): void => {
      if (node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      const { properties, required } = node as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      if (properties != null) {
        expect([...(required ?? [])].sort(), `object at ${path}`).toEqual(
          Object.keys(properties).sort(),
        );
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    };
    walk(emitted, '$');
  });

  it('parses the mock payload (keeps mock mode honest about the wire shape)', () => {
    expect(() => DisputeResultSchema.parse(getDisputeMockPayload())).not.toThrow();
  });

  it('parses a solution_incorrect result with explicit nulls', () => {
    const result = DisputeResultSchema.parse({
      verdict: 'solution_incorrect',
      summary: 'The solution mishandles the empty input case.',
      details: 'Trace: [] returns undefined instead of [].',
      failingTests: [
        {
          testName: 'handles empty input',
          verdict: 'solution_incorrect',
          explanation: 'The test matches the spec; the solution returns undefined.',
          fixedAssertion: null,
        },
      ],
      fixedTestCode: null,
      hint: 'Check what the function returns before the main loop runs.',
    });
    expect(result.fixedTestCode).toBeNull();
    expect(result.failingTests[0].fixedAssertion).toBeNull();
  });

  // NEE-411: fixedTestCode is a whole file, so a double-encoded response is
  // still a valid string and would be applied to the user's test file as-is.
  it('rejects a fixedTestCode holding the whole response re-encoded', () => {
    const base = {
      verdict: 'test_incorrect' as const,
      summary: 'The test encodes the wrong expectation.',
      details: 'Trace: the spec says [] , the test asserts undefined.',
      failingTests: [],
      hint: null,
    };
    const real = 'import { it } from "vitest";\nit("works", () => {});';
    expect(DisputeResultSchema.safeParse({ ...base, fixedTestCode: real }).success).toBe(true);
    expect(
      DisputeResultSchema.safeParse({
        ...base,
        fixedTestCode: JSON.stringify({ fixedTestCode: real }),
      }).success,
    ).toBe(false);
  });
});
