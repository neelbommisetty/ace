import { describe, expect, it } from 'vitest';
import { zodSchema } from 'ai';
import type { z } from 'zod';
import {
  AuthorPacketSchema,
  AuthorSolutionSchema,
  AuthorTestsSchema,
  CalibrationSchema,
  DraftProblemSchema,
  EdgeAuditSchema,
  GeneratedQuestionSchema,
} from './gen-pipeline.js';

// Regression tests for NEE-263: the codex backend enforces OpenAI strict
// structured-output mode regardless of `strictJsonSchema: false`, and strict
// mode requires `required` to list EVERY key in `properties` — one missing
// key (e.g. a `.nullish()` slug) 400s the whole generation call.
// `zodSchema()` is the exact zod→JSON-schema conversion `generateObject`
// applies, so these assertions pin the emitted wire schema, not a
// re-implementation of it.

interface JsonSchemaObjectNode {
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * Walks the emitted JSON schema and asserts that every object node with
 * `properties` lists each property key in `required` — nested objects (e.g.
 * EdgeAuditSchema's edgeCases items) included.
 */
function assertEveryPropertyRequired(node: unknown, path = '$'): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertEveryPropertyRequired(child, `${path}[${i}]`));
    return;
  }
  const { properties, required } = node as JsonSchemaObjectNode;
  if (properties != null) {
    expect([...(required ?? [])].sort(), `object at ${path}`).toEqual(
      Object.keys(properties).sort(),
    );
  }
  for (const [key, value] of Object.entries(node)) {
    assertEveryPropertyRequired(value, `${path}.${key}`);
  }
}

/** True when a property schema admits null (strict-mode optionality). */
function acceptsNull(propertySchema: unknown): boolean {
  const { anyOf, type } = propertySchema as { anyOf?: Array<{ type?: string }>; type?: unknown };
  if (Array.isArray(anyOf) && anyOf.some((variant) => variant.type === 'null')) return true;
  return type === 'null' || (Array.isArray(type) && type.includes('null'));
}

describe('generation schemas are strict-structured-output compatible', () => {
  it('GeneratedQuestionSchema lists every property in required', () => {
    const emitted = zodSchema(GeneratedQuestionSchema).jsonSchema as JsonSchemaObjectNode;
    expect(Object.keys(emitted.properties ?? {}).sort()).toEqual([
      'competency',
      'description',
      'estimatedMinutes',
      'followUps',
      'interviewerPacket',
      'referenceSolution',
      'signature',
      'slug',
      'solutionCode',
      'supportCode',
      'testCode',
      'title',
    ]);
    assertEveryPropertyRequired(emitted);
  });

  it('EdgeAuditSchema lists every property in required, nested objects included', () => {
    const emitted = zodSchema(EdgeAuditSchema).jsonSchema as JsonSchemaObjectNode;
    expect(Object.keys(emitted.properties ?? {}).sort()).toEqual([
      'description',
      'edgeCases',
      'interviewerPacket',
      'referenceSolution',
      'supportCode',
      'testCode',
    ]);
    assertEveryPropertyRequired(emitted);
  });

  it('keeps optionality as nullability — the optional fields admit null on the wire', () => {
    const question = zodSchema(GeneratedQuestionSchema).jsonSchema as JsonSchemaObjectNode;
    for (const key of Object.keys(question.properties ?? {})) {
      if (key === 'title') continue; // the one genuinely mandatory field
      expect(acceptsNull(question.properties?.[key]), `GeneratedQuestionSchema.${key}`).toBe(true);
    }
    const audit = zodSchema(EdgeAuditSchema).jsonSchema as JsonSchemaObjectNode;
    for (const key of [
      'description',
      'testCode',
      'supportCode',
      'referenceSolution',
      'interviewerPacket',
    ]) {
      expect(acceptsNull(audit.properties?.[key]), `EdgeAuditSchema.${key}`).toBe(true);
    }
  });

  it('still parses explicit-null optional fields (runtime semantics unchanged)', () => {
    const question = GeneratedQuestionSchema.parse({
      title: 'Two Sum',
      slug: null,
      description: null,
      signature: null,
      testCode: null,
      supportCode: null,
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: null,
      estimatedMinutes: null,
      competency: null,
      followUps: null,
    });
    expect(question.slug ?? undefined).toBeUndefined();

    const audit = EdgeAuditSchema.parse({
      edgeCases: [{ name: 'empty input', covered: true, action: 'none' }],
      description: null,
      testCode: null,
      supportCode: null,
      referenceSolution: null,
      interviewerPacket: null,
    });
    expect(audit.testCode ?? undefined).toBeUndefined();
  });
});

describe('the four authoring-stage schemas', () => {
  const STAGE_SCHEMAS: Array<[string, z.ZodObject]> = [
    ['draft-problem', DraftProblemSchema],
    ['author-solution', AuthorSolutionSchema],
    ['author-tests', AuthorTestsSchema],
    ['author-packet', AuthorPacketSchema],
  ];

  it.each(STAGE_SCHEMAS)(
    '%s lists every property in required and keeps optionality as nullability',
    (stage, schema) => {
      const emitted = zodSchema(schema).jsonSchema as JsonSchemaObjectNode;
      assertEveryPropertyRequired(emitted);
      for (const key of Object.keys(emitted.properties ?? {})) {
        if (key === 'title') continue; // the one genuinely mandatory field
        expect(acceptsNull(emitted.properties?.[key]), `${stage}.${key}`).toBe(true);
      }
    },
  );

  it('partition GeneratedQuestionSchema exactly — every field is authored by exactly one stage', () => {
    const staged = STAGE_SCHEMAS.flatMap(([, schema]) => Object.keys(schema.shape));
    expect(new Set(staged).size).toBe(staged.length); // no field authored twice
    expect([...staged].sort()).toEqual(Object.keys(GeneratedQuestionSchema.shape).sort());
  });

  it('parses explicit-null optional fields the same way the whole-object schema does', () => {
    expect(
      AuthorSolutionSchema.parse({
        referenceSolution: null,
        supportCode: null,
        solutionCode: null,
      }).referenceSolution,
    ).toBeNull();
    expect(AuthorTestsSchema.parse({ testCode: null }).testCode).toBeNull();
    expect(
      AuthorPacketSchema.parse({ interviewerPacket: 'packet', followUps: null }).followUps,
    ).toBeNull();
  });
});

// NEE-411: a double-encoded response is still a perfectly good STRING, so a
// field typed `string` accepts the whole payload and writes it to disk as if
// it were a test file or a packet. Probe's failure was loud only because its
// one field is an array. These pin the guard onto the real schemas — the unit
// tests for payloadString itself build their own schema and would not notice
// a field quietly reverting to a bare z.string().
describe('artifact fields reject the whole response re-encoded', () => {
  // Stage and field first so it.each's %s title consumes those two and never
  // interpolates the zod object itself.
  const GUARDED: Array<[string, string, z.ZodObject]> = [
    ['author-solution', 'referenceSolution', AuthorSolutionSchema],
    ['author-solution', 'supportCode', AuthorSolutionSchema],
    ['author-solution', 'solutionCode', AuthorSolutionSchema],
    ['author-tests', 'testCode', AuthorTestsSchema],
    ['author-packet', 'interviewerPacket', AuthorPacketSchema],
    ['calibrate', 'issues', CalibrationSchema],
  ];

  /** A valid payload for `schema`, with `field` set to `value`. */
  function withField(schema: z.ZodObject, field: string, value: unknown) {
    const payload: Record<string, unknown> = {};
    for (const key of Object.keys(schema.shape)) payload[key] = null;
    if ('title' in schema.shape) payload.title = 'Two Sum';
    if ('verdict' in schema.shape) payload.verdict = 'fits';
    payload[field] = value;
    return payload;
  }

  it.each(GUARDED)('%s.%s rejects a self-encoded value', (_stage, field, schema) => {
    const doubled = JSON.stringify({ [field]: 'the real content' });
    expect(schema.safeParse(withField(schema, field, doubled)).success).toBe(false);
  });

  it.each(GUARDED)('%s.%s still accepts real content and null', (_stage, field, schema) => {
    expect(schema.safeParse(withField(schema, field, 'the real content')).success).toBe(true);
    expect(schema.safeParse(withField(schema, field, null)).success).toBe(true);
  });

  it('does not fire on a JSON fixture that is not the response envelope', () => {
    // Test files legitimately embed JSON. Only the field's OWN name returning
    // marks a double-encode.
    const fixture = '{"users":[{"id":1,"name":"ada"}]}';
    expect(AuthorTestsSchema.safeParse({ testCode: fixture }).success).toBe(true);
  });
});

describe('CalibrationSchema (stage 2.5) is strict-structured-output compatible', () => {
  it('lists every property in required', () => {
    const emitted = zodSchema(CalibrationSchema).jsonSchema as JsonSchemaObjectNode;
    expect(Object.keys(emitted.properties ?? {}).sort()).toEqual([
      'estimatedMinutes',
      'issues',
      'verdict',
    ]);
    assertEveryPropertyRequired(emitted);
  });

  it('keeps optionality as nullability for estimatedMinutes/issues — verdict is the one mandatory field', () => {
    const emitted = zodSchema(CalibrationSchema).jsonSchema as JsonSchemaObjectNode;
    for (const key of ['estimatedMinutes', 'issues']) {
      expect(acceptsNull(emitted.properties?.[key]), `CalibrationSchema.${key}`).toBe(true);
    }
  });

  it('parses every verdict with explicit nulls, and rejects an unknown verdict', () => {
    const fits = CalibrationSchema.parse({ verdict: 'fits', estimatedMinutes: 42, issues: null });
    expect(fits.issues).toBeNull();
    const tooBig = CalibrationSchema.parse({
      verdict: 'too-big',
      estimatedMinutes: 75,
      issues: 'drop the retry branch',
    });
    expect(tooBig.verdict).toBe('too-big');
    expect(() =>
      CalibrationSchema.parse({ verdict: 'about-right', estimatedMinutes: null, issues: null }),
    ).toThrow();
  });
});
