import { z } from 'zod';
import { getCategoryConfig, isDesignCategory, type CategorySlug, type Difficulty } from './categories.js';
import { verifyGeneratedQuestion, type VerifyFn } from './gen-verify.js';
import { chatObject, isMockLlm, type LLMMessage, type LLMProvider } from './llm.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { renderSolutionStub } from './scaffold.js';

// Canonical generated-question shape — the single source of truth for both
// the server engine and the CLI command (ends the duplicated-schema
// convention). Optional fields are `.nullable()` (required-and-nullable),
// NOT `.nullish()`: OpenAI strict structured outputs demand that `required`
// list EVERY key in `properties`, and the codex backend enforces strict mode
// regardless of `strictJsonSchema: false` (NEE-263) — a `.nullish()` field
// is omitted from `required` and 400s the whole call. Runtime semantics for
// consumers are unchanged (fields still read as null via `??`/`?.`); the
// model just writes `null` explicitly instead of omitting the key.
export const GeneratedQuestionSchema = z.object({
  title: z.string(),
  slug: z.string().nullable(),
  description: z.string().nullable(),
  signature: z.string().nullable(),
  testCode: z.string().nullable(),
  solutionCode: z.string().nullable(),
  referenceSolution: z.string().nullable(),
  interviewerPacket: z.string().nullable(),
});

export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

// Stage-2 output: only changed artifacts come back; non-null fields are
// merged over the stage-1 result. `edgeCases` is kept for debuggability.
// Same `.nullable()`-not-`.nullish()` rule as GeneratedQuestionSchema above:
// strict structured outputs require every property key in `required`.
export const EdgeAuditSchema = z.object({
  edgeCases: z.array(
    z.object({
      name: z.string(),
      covered: z.boolean(),
      action: z.enum(['none', 'add-test', 'update-question', 'both']),
    }),
  ),
  description: z.string().nullable(),
  testCode: z.string().nullable(),
  referenceSolution: z.string().nullable(),
  interviewerPacket: z.string().nullable(),
});

export type EdgeAuditResult = z.infer<typeof EdgeAuditSchema>;

export type GenerationPhase = 'generating' | 'auditing' | 'verifying' | 'repairing';

const GENERATE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 16_000;
/** 1 initial verify + 2 repair-and-reverify rounds. */
const MAX_VERIFY_ATTEMPTS = 3;

/** Thrown when the verify/repair loop exhausts its attempts. */
export class GenerationVerifyError extends Error {
  readonly lastResult: GeneratedQuestion;
  readonly failureReport: string;

  constructor(lastResult: GeneratedQuestion, failureReport: string) {
    super(
      `generated tests could not be verified after ${MAX_VERIFY_ATTEMPTS} attempts — ${failureReport.split('\n')[0]}`,
    );
    this.name = 'GenerationVerifyError';
    this.lastResult = lastResult;
    this.failureReport = failureReport;
  }
}

// Everything a generated test file may import: the workspace deps ace init
// installs, minus user-event/jsdom (classic model habits that are not
// installed). Relative './x' imports resolve inside the sandbox; '../'
// escapes it and is rejected.
const ALLOWED_TEST_PACKAGES = new Set([
  'vitest',
  'react',
  'react-dom',
  '@testing-library/react',
  '@testing-library/jest-dom',
]);

// `[^'"]*?` (not `[^'"\n]*?`) so Prettier-style multi-line named imports
// still match; excluding quotes keeps the non-greedy scan from ever crossing
// into a different statement's string.
const IMPORT_SPEC_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Blanks comments and template literals so import-like text inside them
 * (e.g. "avoid: import userEvent from ..." in a block comment) is never
 * flagged. Deliberately naive — a rare mis-strip only means one wasted
 * sandbox run, where the missing module still fails loudly.
 */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // [^:] keeps 'https://…' strings intact
    .replace(/`[^`]*`/g, "''");
}

/** Returns the import specifiers in `testCode` that violate the allowlist. */
export function findDisallowedImports(testCode: string): string[] {
  const bad: string[] = [];
  for (const match of stripNonCode(testCode).matchAll(IMPORT_SPEC_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!spec) continue;
    if (spec.startsWith('./')) continue; // sandbox-relative is fine
    const base = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!ALLOWED_TEST_PACKAGES.has(base)) bad.push(spec);
  }
  return [...new Set(bad)];
}

export interface GenerateParams {
  provider: LLMProvider;
  category: CategorySlug;
  difficulty: Difficulty;
  /** Complete user message (topic brief or brainstorm summary) — caller-built. */
  userMessage: string;
  /** Workspace whose node_modules/.ace/tmp the sandbox verification uses. */
  workspaceRoot: string;
}

export interface GeneratePipelineOpts {
  /** Injectable seams so unit tests never need an API key or a vitest binary. */
  llm?: { chatObject: typeof chatObject };
  verify?: VerifyFn;
  onProgress?: (phase: GenerationPhase, attempt: number) => void;
  /** Called with each paid, parsed stage output so callers can persist it. */
  onStageResult?: (parsed: GeneratedQuestion) => void;
}

export interface GeneratedVerifiedQuestion {
  question: GeneratedQuestion;
  /** Stage-2 audit trail; null when the audit was skipped (mock mode). */
  edgeCases: EdgeAuditResult['edgeCases'] | null;
}

function buildAuditUserMessage(
  params: GenerateParams,
  question: GeneratedQuestion,
  design: boolean,
): string {
  const sections = [
    `Audit this freshly generated ${params.difficulty} ${params.category} interview question.`,
    `## Problem Statement\n\n${question.description ?? ''}`,
  ];
  if (!design) {
    sections.push(
      `## Signature\n\n\`\`\`\n${question.signature ?? ''}\n\`\`\``,
      `## Reference Solution\n\n\`\`\`\n${question.referenceSolution ?? ''}\n\`\`\``,
      `## Test File\n\n\`\`\`\n${question.testCode ?? ''}\n\`\`\``,
    );
  }
  sections.push(`## Interviewer Packet\n\n${question.interviewerPacket ?? '(none provided)'}`);
  return sections.join('\n\n');
}

function buildRepairUserMessage(question: GeneratedQuestion, failureReport: string): string {
  return `Your previously generated question failed verification. Repair it.

## Previous Output

\`\`\`json
${JSON.stringify(question, null, 2)}
\`\`\`

## Verification Failure Report

\`\`\`
${failureReport}
\`\`\`

The problem statement is the source of truth — change it only if the report
proves it self-contradictory. Fix the minimum needed so the tests pass
against the reference solution and still fail against the starter stub.
Keep "title" and "slug" exactly as they were. Return the complete JSON
object with ALL fields (not only the ones you changed).`;
}

/** Merges the audit's non-null changed artifacts over the stage-1 result. */
function mergeAudit(question: GeneratedQuestion, audit: EdgeAuditResult): GeneratedQuestion {
  return {
    ...question,
    description: audit.description ?? question.description,
    testCode: audit.testCode ?? question.testCode,
    referenceSolution: audit.referenceSolution ?? question.referenceSolution,
    interviewerPacket: audit.interviewerPacket ?? question.interviewerPacket,
  };
}

/**
 * The verified-generation pipeline: (1) generate a question + hidden
 * reference solution + interviewer packet, (2) run an adversarial edge-case
 * audit (design categories: a requirements critique — the pipeline ends
 * there), (3) execute the tests in a sandbox — pass-vs-reference AND
 * fail-vs-stub — repairing on red, at most ${MAX_VERIFY_ATTEMPTS} verify
 * attempts. Mock mode (ACE_E2E_MOCK_LLM) returns after stage 1 so keyless
 * e2e runs never need a vitest binary.
 *
 * Throws GenerationVerifyError (carrying the last result + failure report)
 * when verification is exhausted; other errors propagate as-is.
 */
export async function generateVerifiedQuestion(
  params: GenerateParams,
  opts: GeneratePipelineOpts = {},
): Promise<GeneratedVerifiedQuestion> {
  const llm = opts.llm ?? { chatObject };
  const verify = opts.verify ?? verifyGeneratedQuestion;
  const onProgress = opts.onProgress ?? (() => {});
  const onStageResult = opts.onStageResult ?? (() => {});
  const design = isDesignCategory(params.category);
  const config = getCategoryConfig(params.category);

  const generateSystemPrompt = buildSystemPrompt('generate', params.category);
  const callGenerate = async (userContent: string): Promise<GeneratedQuestion> => {
    const messages: LLMMessage[] = [
      { role: 'system', content: generateSystemPrompt },
      { role: 'user', content: userContent },
    ];
    return llm.chatObject(params.provider, messages, GeneratedQuestionSchema, {
      purpose: 'generate',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
  };

  // Stage 1 — generate.
  onProgress('generating', 1);
  let question = await callGenerate(params.userMessage);
  onStageResult(question);

  // Mock mode: no audit, no sandbox — e2e workspaces have no vitest binary
  // and the mock payload already matches the schema.
  if (isMockLlm()) {
    return { question, edgeCases: null };
  }

  // Stage 2 — edge-case audit (design categories: requirements critique).
  onProgress('auditing', 1);
  const auditMessages: LLMMessage[] = [
    { role: 'system', content: buildSystemPrompt('edge-audit', params.category) },
    { role: 'user', content: buildAuditUserMessage(params, question, design) },
  ];
  const audit = await llm.chatObject(params.provider, auditMessages, EdgeAuditSchema, {
    purpose: 'edge-audit',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  question = mergeAudit(question, audit);
  onStageResult(question);

  if (design) {
    return { question, edgeCases: audit.edgeCases };
  }

  // Stage 3 — verify + repair loop (coding categories only).
  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    let failureReport: string;

    // Static import-allowlist check first: catches user-event/jsdom before
    // spending a vitest run (those packages are not even installed).
    const disallowed = findDisallowedImports(question.testCode ?? '');
    const missing: string[] = [];
    if (!question.testCode?.trim()) missing.push('testCode');
    if (!question.referenceSolution?.trim()) missing.push('referenceSolution');
    if (!question.signature?.trim()) missing.push('signature');

    // Report every static problem at once — the repair budget is tight, so
    // never spend a round surfacing an issue that was already knowable.
    const staticProblems: string[] = [];
    if (missing.length > 0) {
      staticProblems.push(
        `the generated output is missing required field(s) for a coding question: ${missing.join(', ')} — return the complete JSON object`,
      );
    }
    if (disallowed.length > 0) {
      staticProblems.push(
        `the test file imports package(s) outside the allowlist: ${disallowed.join(', ')} — only vitest, react, react-dom, @testing-library/react and @testing-library/jest-dom are installed; rewrite the tests without them (use fireEvent, not userEvent)`,
      );
    }
    if (staticProblems.length > 0) {
      failureReport = staticProblems.join('\n');
    } else {
      onProgress('verifying', attempt);
      const result = await verify(params.workspaceRoot, params.category, {
        referenceSolution: question.referenceSolution as string,
        testCode: question.testCode as string,
        stubSolution: renderSolutionStub(params.category, config.solutionFiles[0], {
          signature: question.signature ?? undefined,
          title: question.title,
        }),
      });
      if (result.green) {
        return { question, edgeCases: audit.edgeCases };
      }
      failureReport = result.failureReport ?? 'verification failed with no report';
    }

    if (attempt === MAX_VERIFY_ATTEMPTS) {
      throw new GenerationVerifyError(question, failureReport);
    }

    onProgress('repairing', attempt + 1);
    const repaired = await callGenerate(buildRepairUserMessage(question, failureReport));
    // A repair must never drift the question's identity.
    question = { ...repaired, title: question.title, slug: question.slug };
    onStageResult(question);
  }

  // Unreachable: the loop either returns green or throws on the last attempt.
  throw new Error('generateVerifiedQuestion: verify loop exited unexpectedly');
}
