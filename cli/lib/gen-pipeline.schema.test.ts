import { describe, expect, it } from 'vitest';
import { zodSchema } from 'ai';
import { EdgeAuditSchema, GeneratedQuestionSchema } from './gen-pipeline.js';

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
      'followUps',
      'interviewerPacket',
      'referenceSolution',
      'signature',
      'slug',
      'solutionCode',
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
    for (const key of ['description', 'testCode', 'referenceSolution', 'interviewerPacket']) {
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
      solutionCode: null,
      referenceSolution: null,
      interviewerPacket: null,
      competency: null,
      followUps: null,
    });
    expect(question.slug ?? undefined).toBeUndefined();

    const audit = EdgeAuditSchema.parse({
      edgeCases: [{ name: 'empty input', covered: true, action: 'none' }],
      description: null,
      testCode: null,
      referenceSolution: null,
      interviewerPacket: null,
    });
    expect(audit.testCode ?? undefined).toBeUndefined();
  });
});
