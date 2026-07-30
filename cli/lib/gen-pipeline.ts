import { z } from 'zod';
import {
  getCategoryConfig,
  getSuggestedTime,
  hasTests,
  type CategorySlug,
  type Difficulty,
  type QuestionType,
} from './categories.js';
import { verifyGeneratedQuestion, type VerifyFn } from './gen-verify.js';
import {
  chatObjectStream,
  isMockLlm,
  type LLMMessage,
  type LLMProvider,
  type LLMPurpose,
} from './llm.js';
import { buildQuestionSection, buildSystemPrompt } from './prompt-builder.js';
import { renderSolutionStub } from './scaffold.js';
import { maskSpoilerValues, SPOILER_KEYS, WITHHELD_MARKER } from './spoilers.js';

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
  // LLM-authored read-only support module (react-apps' `api.ts`) — the fake
  // backend shared by the solution, the tests, and the live preview. Null
  // for every category whose CategoryConfig.supportFiles is empty.
  supportCode: z.string().nullable(),
  solutionCode: z.string().nullable(),
  referenceSolution: z.string().nullable(),
  interviewerPacket: z.string().nullable(),
  // Coding categories only: the model's own honest whole-minute estimate
  // (10-60) for a strong candidate to read, implement, and pass the tests.
  // The calibrate stage (2.5, below) independently re-derives and owns the
  // final value — this is only the model's first guess. Null for
  // design/behavioral (they keep the static suggestedTimes table).
  estimatedMinutes: z.number().nullable(),
  // Behavioral-only (NEE-343): the single competency this question probes,
  // freeform text normalized downstream via shared/competencies.js's
  // normalizeCompetency (never a z.enum here — a near-miss casing/spacing
  // variant should be tolerated, not 400 the whole paid call). Null for
  // every coding/design category.
  competency: z.string().nullable(),
  // Behavioral-only (NEE-343): candidate follow-up probes for the interview
  // drill-down, written to the hidden `.probes.md` bank (NEE-345 reads it).
  // Null for every coding/design category.
  followUps: z.array(z.string()).nullable(),
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
  // New tests may need new fixtures or error triggers — the audit may
  // revise supportCode, same as testCode/description. It must NEVER revise
  // estimatedMinutes (there is no such field here): the calibrate stage
  // owns time, so audit-driven scope creep has to surface as a calibration
  // failure, not a silently bigger number.
  supportCode: z.string().nullable(),
  referenceSolution: z.string().nullable(),
  interviewerPacket: z.string().nullable(),
});

export type EdgeAuditResult = z.infer<typeof EdgeAuditSchema>;

/**
 * Stage-2.5 output: an independent, skeptical read on whether the
 * question's claimed time and complexity are honest — run for coding AND
 * design categories (never behavioral; see generateVerifiedQuestion's
 * gate). Same `.nullable()`-not-`.nullish()` rule as the schemas above.
 */
export const CalibrationSchema = z.object({
  verdict: z.enum(['fits', 'too-big', 'too-small']),
  estimatedMinutes: z.number().nullable(),
  issues: z.string().nullable(),
});

export type CalibrationResult = z.infer<typeof CalibrationSchema>;

export type GenerationPhase = 'generating' | 'auditing' | 'calibrating' | 'verifying' | 'repairing';

// Per-call timeout budget (NEE-264): the old 300s wall clock was smaller
// than a full MAX_OUTPUT_TOKENS answer at the ~60 tok/s measured through the
// proxy, so healthy-but-large generations died at exactly the deadline. Now
// a call is cut only when the stream goes SILENT for the stall window, with
// a generous absolute ceiling bounding even a steadily-flowing call.
// Liveness is RAW STREAM ACTIVITY, not parsed partials (NEE-322): a
// buffering proxy (NEE-321) can deliver zero partials for an entire healthy
// turn — only ping frames reach the SDK — so a partial-only re-arm degrades
// back to exactly the 300s wall clock this design removed.
const GENERATE_STALL_TIMEOUT_MS = 300_000;
const GENERATE_MAX_TIMEOUT_MS = 900_000;
// 32K, was 16K (NEE-274): adaptive thinking is on by default on the Claude
// 5-series and counts against this cap alongside the streamed JSON — and
// edge-audit's claude-sonnet-5 tokenizer spends ~30% more tokens on the
// same text — so the old value sized for the visible object alone could
// truncate mid-answer. Still inside every mapped model's max output.
const MAX_OUTPUT_TOKENS = 32_000;
/** 1 initial verify + 2 repair-and-reverify rounds. Exported for the activity log's terminal phrasing. */
export const MAX_VERIFY_ATTEMPTS = 3;
/**
 * 1 initial calibration + at most 1 rework-and-recalibrate round. Kept
 * small: calibration is a size CHECK, not the verify/repair loop's
 * pass/fail gate — a budget-exhausted question proceeds with a warning
 * rather than dying, so there is no need for a long rework tail.
 */
export const MAX_CALIBRATE_ATTEMPTS = 2;

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

/** Cap for the joined failing-test names in a verify step's outcome line. */
const VERIFY_DETAIL_CAP = 200;

/**
 * Maps a red verify outcome to the activity log's CLOSED detail vocabulary —
 * never free text from the failure report (assertion diffs, stderr tails and
 * compiler frames can quote the reference solution; a diff like
 * "expected [0,1] to equal [1,0]" IS the answer). The only report-derived
 * content allowed through is the failing test NAMES from buildFailureReport's
 * `✕ name` lines — model-authored test titles, already wire-safe via
 * testCode. Everything else maps to a fixed phrase, failing closed on any
 * unrecognized shape (e.g. the raw stderr-tail fallbacks).
 */
export function verifyFailureDetail(failureReport: string): string {
  const names = [...failureReport.matchAll(/^✕ (.+)$/gm)].map((m) => m[1]);
  if (names.length > 0) {
    const joined = names.join(' · ');
    return joined.length > VERIFY_DETAIL_CAP ? `${joined.slice(0, VERIFY_DETAIL_CAP)}…` : joined;
  }
  if (failureReport.startsWith('verification run timed out')) return 'verification run timed out';
  if (failureReport.startsWith('stub verification run timed out')) {
    return 'stub verification run timed out';
  }
  if (failureReport.startsWith('no tests ran — the suite failed to load or compile')) {
    return 'no tests ran — the suite failed to load or compile';
  }
  if (failureReport.startsWith('the test file contains no tests')) {
    return 'the test file contains no tests';
  }
  if (failureReport.startsWith('no tests ran against the starter stub')) {
    return 'no tests ran against the starter stub';
  }
  if (failureReport.startsWith('every test passes against the unimplemented starter stub')) {
    return 'the suite is vacuous';
  }
  if (
    failureReport.startsWith('vitest produced no parseable JSON report') ||
    failureReport.startsWith('the stub verification run produced no parseable JSON report')
  ) {
    return 'vitest produced no parseable report';
  }
  if (failureReport === 'verification failed with no report') {
    return 'verification failed with no report';
  }
  return 'verification failed';
}

/**
 * Edge-audit step label, per question type — a Record so widening
 * QuestionType forces a new entry here instead of silently falling through
 * a design/coding ternary.
 */
const AUDIT_LABEL: Record<QuestionType, string> = {
  coding: 'Auditing edge cases',
  design: 'Critiquing requirements',
  behavioral: 'Critiquing the prompt',
};

/**
 * Sandbox-verify skip reason, per question type, for categories with no test
 * suite. `coding` is never read (coding always hasTests) but the entry is
 * required so the map stays exhaustive over QuestionType. The `design`
 * string is asserted verbatim in gen-pipeline.test.ts — never reword it.
 */
const VERIFY_SKIP_REASON: Record<QuestionType, string> = {
  coding: 'not applicable — this category is sandbox-verified above',
  design: 'not applicable to design questions',
  behavioral: 'not applicable to behavioral questions',
};

export interface GenerateParams {
  provider: LLMProvider;
  category: CategorySlug;
  difficulty: Difficulty;
  /** Complete user message (topic brief or brainstorm summary) — caller-built. */
  userMessage: string;
  /** Workspace whose node_modules/.ace/tmp the sandbox verification uses. */
  workspaceRoot: string;
}

/**
 * Structural twin of the ai-log recorder's step handle (NEE-268): cli/lib
 * must never import cli/server, so the pipeline takes the recorder
 * structurally — the server's `AiRunHandle` happens to satisfy
 * `GenerationStepsSink`.
 */
export interface GenerationStepHandle {
  append(text: string): void;
  partial(obj: Record<string, unknown>): void;
  done(detail?: string): void;
  fail(message: string): void;
  skip(reason?: string): void;
}

export interface GenerationStepsSink {
  step(spec: {
    slug: string;
    label: string;
    kind: 'llm' | 'sandbox' | 'static-check' | 'scaffold';
    attempt?: number;
    prompt?: string;
    withholdPrompt?: boolean;
  }): GenerationStepHandle;
  /** Literal-scrub backstop: hand every spoiler value to the recorder as it materialises. */
  registerSecret(text: string): void;
}

/** Inert sink so the pipeline can call the recorder unconditionally. */
const NULL_STEP_HANDLE: GenerationStepHandle = {
  append() {},
  partial() {},
  done() {},
  fail() {},
  skip() {},
};

const NULL_STEPS: GenerationStepsSink = {
  step: () => NULL_STEP_HANDLE,
  registerSecret() {},
};

export interface GeneratePipelineOpts {
  /** Injectable seams so unit tests never need an API key or a vitest binary. */
  llm?: { chatObjectStream: typeof chatObjectStream };
  verify?: VerifyFn;
  onProgress?: (phase: GenerationPhase, attempt: number) => void;
  /** Called with each paid, parsed stage output so callers can persist it. */
  onStageResult?: (parsed: GeneratedQuestion) => void;
  /**
   * Activity-log step recorder (NEE-268). Purely additive: `onProgress`
   * keeps carrying the phase label, so existing consumers are untouched.
   */
  steps?: GenerationStepsSink;
}

export interface GeneratedVerifiedQuestion {
  question: GeneratedQuestion;
  /** Stage-2 audit trail; null when the audit was skipped (mock mode). */
  edgeCases: EdgeAuditResult['edgeCases'] | null;
}

/**
 * A prompt user message plus its spoiler-free twin, built from the SAME
 * tagged section array so the masked variant is constructed, never parsed
 * (spoilers.ts's maskPromptText is the second line of defence for a caller
 * who forgets, not the primary mechanism). NEE-268's activity log records
 * maskedPrompt.
 */
export interface BuiltPrompt {
  prompt: string;
  maskedPrompt: string;
}

/** A prompt section: full text for the model, optional masked stand-in. */
interface TaggedSection {
  text: string;
  masked?: string;
}

function renderSections(sections: TaggedSection[]): BuiltPrompt {
  return {
    prompt: sections.map((s) => s.text).join('\n\n'),
    maskedPrompt: sections.map((s) => s.masked ?? s.text).join('\n\n'),
  };
}

/**
 * The support module (react-apps' `api.ts`) is WIRE-SAFE — candidate-
 * visible, not answer-key material — so it is appended unmasked in both the
 * model-bound prompt and the recorder's masked twin. Shared by
 * buildAuditUserMessage and buildCalibrationUserMessage so the heading text
 * (which reviews.ts's README section and the audit prompt must agree on)
 * never drifts between the two call sites.
 */
function supportModuleSection(supportCode: string): TaggedSection {
  return {
    text: `## Support Module (read-only, shared by App and tests)\n\n\`\`\`\n${supportCode}\n\`\`\``,
  };
}

/** Exported for tests (masked-variant assertions), not for callers. */
export function buildAuditUserMessage(
  params: GenerateParams,
  question: GeneratedQuestion,
  design: boolean,
): BuiltPrompt {
  const sections: TaggedSection[] = [
    {
      text: `Audit this freshly generated ${params.difficulty} ${params.category} interview question.`,
    },
    { text: buildQuestionSection(question.description ?? '') },
  ];
  if (!design) {
    // No sibling `## Signature` section: the description's own `## Signature`
    // already carries it, and repeating it doubled the heading (NEE-275).
    sections.push(
      {
        text: `## Reference Solution\n\n\`\`\`\n${question.referenceSolution ?? ''}\n\`\`\``,
        masked: `## Reference Solution\n\n${WITHHELD_MARKER}`,
      },
      { text: `## Test File\n\n\`\`\`\n${question.testCode ?? ''}\n\`\`\`` },
    );
    if (question.supportCode) sections.push(supportModuleSection(question.supportCode));
  }
  sections.push({
    text: `## Interviewer Packet\n\n${question.interviewerPacket ?? '(none provided)'}`,
    masked: `## Interviewer Packet\n\n${WITHHELD_MARKER}`,
  });
  return renderSections(sections);
}

/**
 * Exported for tests (masked-variant assertions), not for callers. Coding:
 * description + reference solution + tests (+ support module when present).
 * Design: description + the static per-category/difficulty time budget in
 * place of code sections — the calibrator judges design scope against that
 * number, never the coding 45/60 figures. Both variants carry the
 * interviewer packet, masked, same as buildAuditUserMessage.
 */
export function buildCalibrationUserMessage(
  params: GenerateParams,
  question: GeneratedQuestion,
  design: boolean,
): BuiltPrompt {
  const sections: TaggedSection[] = [
    {
      text: `Calibrate the time and complexity of this freshly generated ${params.difficulty} ${params.category} interview question.`,
    },
    { text: buildQuestionSection(question.description ?? '') },
  ];
  if (!design) {
    sections.push(
      {
        text: `## Reference Solution\n\n\`\`\`\n${question.referenceSolution ?? ''}\n\`\`\``,
        masked: `## Reference Solution\n\n${WITHHELD_MARKER}`,
      },
      { text: `## Test File\n\n\`\`\`\n${question.testCode ?? ''}\n\`\`\`` },
    );
    if (question.supportCode) sections.push(supportModuleSection(question.supportCode));
  } else {
    sections.push({
      text: `## Time Budget\n\nThe stated time budget for a ${params.difficulty} ${params.category} question is ${getSuggestedTime(params.category, params.difficulty)} minutes — judge this question's scope against that budget, not the coding 45/60 numbers.`,
    });
  }
  sections.push({
    text: `## Interviewer Packet\n\n${question.interviewerPacket ?? '(none provided)'}`,
    masked: `## Interviewer Packet\n\n${WITHHELD_MARKER}`,
  });
  return renderSections(sections);
}

/**
 * Exported for tests (masked-variant assertions), not for callers. Built the
 * same way buildRepairUserMessage is: the calibrator's `issues` prose can
 * quote spoiler-derived reasoning (it was written having seen the reference
 * solution/tests), so it is withheld wholesale in the masked twin — only the
 * closed-vocabulary `verdict` survives masking.
 */
export function buildCalibrationReworkUserMessage(
  params: GenerateParams,
  question: GeneratedQuestion,
  calibration: CalibrationResult,
): BuiltPrompt {
  const verb = calibration.verdict === 'too-big' ? 'Shrink' : 'Grow';
  return renderSections([
    { text: params.userMessage },
    {
      text: `## Current Output\n\n\`\`\`json\n${JSON.stringify(question, null, 2)}\n\`\`\``,
      masked: `## Current Output\n\n\`\`\`json\n${JSON.stringify(maskSpoilerValues(question), null, 2)}\n\`\`\``,
    },
    {
      text: `## Calibration Feedback\n\nVerdict: ${calibration.verdict}\n\n${calibration.issues ?? '(no issues provided)'}`,
      masked: `## Calibration Feedback\n\nVerdict: ${calibration.verdict}\n\n${WITHHELD_MARKER}`,
    },
    {
      text: `${verb} the question's scope to address the calibration feedback above. Keep
"title" and "slug" exactly as they were. Return the complete JSON object
with ALL fields (not only the ones you changed).`,
    },
  ]);
}

/** Exported for tests (masked-variant assertions), not for callers. */
export function buildRepairUserMessage(
  question: GeneratedQuestion,
  failureReport: string,
): BuiltPrompt {
  return renderSections([
    { text: 'Your previously generated question failed verification. Repair it.' },
    {
      text: `## Previous Output\n\n\`\`\`json\n${JSON.stringify(question, null, 2)}\n\`\`\``,
      masked: `## Previous Output\n\n\`\`\`json\n${JSON.stringify(maskSpoilerValues(question), null, 2)}\n\`\`\``,
    },
    {
      // The report can carry reference-solution fragments or compiler frames.
      text: `## Verification Failure Report\n\n\`\`\`\n${failureReport}\n\`\`\``,
      masked: `## Verification Failure Report\n\n${WITHHELD_MARKER}`,
    },
    {
      text: `The problem statement is the source of truth — change it only if the report
proves it self-contradictory. Fix the minimum needed so the tests pass
against the reference solution and still fail against the starter stub.
Keep "title" and "slug" exactly as they were. Return the complete JSON
object with ALL fields (not only the ones you changed).`,
    },
  ]);
}

/** Merges the audit's non-null changed artifacts over the stage-1 result. */
function mergeAudit(question: GeneratedQuestion, audit: EdgeAuditResult): GeneratedQuestion {
  return {
    ...question,
    description: audit.description ?? question.description,
    testCode: audit.testCode ?? question.testCode,
    supportCode: audit.supportCode ?? question.supportCode,
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
  const llm = opts.llm ?? { chatObjectStream };
  const verify = opts.verify ?? verifyGeneratedQuestion;
  const onProgress = opts.onProgress ?? (() => {});
  const onStageResult = opts.onStageResult ?? (() => {});
  const steps = opts.steps ?? NULL_STEPS;
  const config = getCategoryConfig(params.category);
  const design = !hasTests(config);

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // Backstop registration (NEE-268): every spoiler value that materialises is
  // handed to the recorder's literal scrubber, catching verbatim echoes that
  // structural masking can't (e.g. a provider error quoting the prompt).
  // followUps (NEE-343) is the one array-valued spoiler — each probe string
  // is registered individually so an echo of any single one is still caught.
  const registerSpoilers = (q: GeneratedQuestion): void => {
    for (const key of SPOILER_KEYS) {
      const value = q[key];
      if (typeof value === 'string' && value.length > 0) {
        steps.registerSecret(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.length > 0) steps.registerSecret(item);
        }
      }
    }
  };

  // One streaming LLM call under the no-output-progress budget: a stream
  // whose RAW BYTES stay silent for GENERATE_STALL_TIMEOUT_MS is aborted.
  // Raw stream activity — not parsed partials — is what re-arms the stall
  // clock, because a buffering proxy (NEE-321/NEE-322) can deliver zero
  // partials for an entire healthy turn; GENERATE_MAX_TIMEOUT_MS is the
  // absolute ceiling even while output keeps flowing.
  const callStream = async <T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    purpose: LLMPurpose,
    step?: GenerationStepHandle,
  ): Promise<T> => {
    const controller = new AbortController();
    const abortWith = (message: string) =>
      controller.abort(new DOMException(message, 'TimeoutError'));
    const armStall = () =>
      setTimeout(
        () =>
          abortWith(
            `no output from the model for ${GENERATE_STALL_TIMEOUT_MS / 1000}s — generation looks stalled`,
          ),
        GENERATE_STALL_TIMEOUT_MS,
      );
    let stallTimer = armStall();
    const ceilingTimer = setTimeout(
      () => abortWith(`generation exceeded the ${GENERATE_MAX_TIMEOUT_MS / 1000}s ceiling`),
      GENERATE_MAX_TIMEOUT_MS,
    );
    try {
      return await llm.chatObjectStream(params.provider, messages, schema, {
        purpose,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
        // Both callbacks MUST stay synchronous (NEE-267): an async
        // callback's rejection would bypass chatObjectStream's
        // throw-swallowing guard.
        onPartial: (partial) => {
          clearTimeout(stallTimer);
          stallTimer = armStall();
          // Recorder hook — synchronous by construction (the handle only
          // filters/diffs and arms a flush timer).
          step?.partial(partial);
        },
        // Raw-byte liveness (NEE-322). The recorder is deliberately NOT
        // wired here — raw activity carries no object to record.
        onStreamActivity: () => {
          clearTimeout(stallTimer);
          stallTimer = armStall();
        },
      });
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(ceilingTimer);
    }
  };

  const generateSystemPrompt = buildSystemPrompt('generate', params.category);
  const callGenerate = (
    userContent: string,
    step?: GenerationStepHandle,
  ): Promise<GeneratedQuestion> =>
    callStream(
      [
        { role: 'system', content: generateSystemPrompt },
        { role: 'user', content: userContent },
      ],
      GeneratedQuestionSchema,
      'generate',
      step,
    );

  // Stage 1 — generate. The prompt is the caller's topic brief — no spoilers
  // exist yet, so the recorder gets it as-is (the taxonomy's one shown prompt).
  onProgress('generating', 1);
  const generateStep = steps.step({
    slug: 'generate',
    label: 'Writing the question',
    kind: 'llm',
    prompt: params.userMessage,
  });
  let question = await callGenerate(params.userMessage, generateStep).catch((err: unknown) => {
    // Raw model text is never stored on a parse failure (it is the unparsed
    // answer key) — only the error's own message, masked by the recorder.
    generateStep.fail(errorText(err));
    throw err;
  });
  generateStep.done();
  registerSpoilers(question);
  onStageResult(question);

  // Mock mode: no audit, no sandbox — e2e workspaces have no vitest binary
  // and the mock payload already matches the schema. Recorded as skipped
  // steps so keyless e2e renders a complete, self-explaining feed.
  if (isMockLlm()) {
    steps
      .step({ slug: 'edge-audit', label: 'Auditing edge cases', kind: 'llm' })
      .skip('mock LLM mode');
    steps
      .step({ slug: 'calibrate', label: 'Checking time & complexity', kind: 'llm' })
      .skip('mock LLM mode');
    steps
      .step({ slug: 'verify', label: 'Sandbox verification', kind: 'sandbox' })
      .skip('mock LLM mode');
    return { question, edgeCases: null };
  }

  // Stage 2 — edge-case audit (design categories: requirements critique).
  // The audit prompt embeds the reference solution and interviewer packet,
  // so the recorder gets the constructed masked twin.
  onProgress('auditing', 1);
  const auditPrompt = buildAuditUserMessage(params, question, design);
  const auditStep = steps.step({
    slug: 'edge-audit',
    label: AUDIT_LABEL[config.type],
    kind: 'llm',
    prompt: auditPrompt.maskedPrompt,
  });
  const auditMessages: LLMMessage[] = [
    { role: 'system', content: buildSystemPrompt('edge-audit', params.category) },
    { role: 'user', content: auditPrompt.prompt },
  ];
  const audit = await callStream(auditMessages, EdgeAuditSchema, 'edge-audit', auditStep).catch(
    (err: unknown) => {
      auditStep.fail(errorText(err));
      throw err;
    },
  );
  // Counts only — the edge-case NAMES are hints and stay withheld.
  const changed = audit.edgeCases.filter((c) => c.action !== 'none').length;
  auditStep.done(
    `${audit.edgeCases.length} edge case${audit.edgeCases.length === 1 ? '' : 's'} · ${changed} change${changed === 1 ? '' : 's'} applied`,
  );
  question = mergeAudit(question, audit);
  registerSpoilers(question);
  onStageResult(question);

  // Stage 2.5 — time & complexity calibration. Runs for coding AND design
  // (design has scope to misjudge just like coding does); skipped only for
  // behavioral, where a single prompt+story swap has no size to get wrong.
  // Mock mode never reaches here (isMockLlm() already returned above).
  if (config.type === 'behavioral') {
    steps
      .step({ slug: 'calibrate', label: 'Checking time & complexity', kind: 'llm' })
      .skip(VERIFY_SKIP_REASON.behavioral);
  } else {
    const calibrateSystemPrompt = buildSystemPrompt('calibrate', params.category);
    const callCalibrate = (
      userContent: string,
      step?: GenerationStepHandle,
    ): Promise<CalibrationResult> =>
      callStream(
        [
          { role: 'system', content: calibrateSystemPrompt },
          { role: 'user', content: userContent },
        ],
        CalibrationSchema,
        'calibrate',
        step,
      );

    for (let attempt = 1; attempt <= MAX_CALIBRATE_ATTEMPTS; attempt++) {
      onProgress('calibrating', attempt);
      const calibPrompt = buildCalibrationUserMessage(params, question, design);
      const calibStep = steps.step({
        slug: 'calibrate',
        label: 'Checking time & complexity',
        kind: 'llm',
        attempt,
        prompt: calibPrompt.maskedPrompt,
      });
      const calibration = await callCalibrate(calibPrompt.prompt, calibStep).catch(
        (err: unknown) => {
          calibStep.fail(errorText(err));
          throw err;
        },
      );
      const estimateDetail =
        calibration.estimatedMinutes != null ? ` · ~${calibration.estimatedMinutes}m` : '';

      if (calibration.verdict === 'fits') {
        calibStep.done(`fits${estimateDetail}`);
        question = {
          ...question,
          estimatedMinutes: calibration.estimatedMinutes ?? question.estimatedMinutes,
        };
        break;
      }

      if (attempt === MAX_CALIBRATE_ATTEMPTS) {
        // Budget exhausted on a non-fits verdict: proceed anyway — a
        // slightly-oversized question beats a dead generation. The final
        // clamp to a sane on-disk range happens downstream, once, in
        // resolveSuggestedMinutes (cli/server/generation.ts).
        calibStep.done(`${calibration.verdict}${estimateDetail} — budget exhausted, proceeding anyway`);
        question = {
          ...question,
          estimatedMinutes: calibration.estimatedMinutes ?? question.estimatedMinutes,
        };
        break;
      }

      calibStep.done(`${calibration.verdict}${estimateDetail}`);

      // Rework: reuse the generate purpose/schema and the repair loop's own
      // step slug so the response inherits WIRE_SAFE_KEYS.repair's
      // redaction — a fresh slug here would fail-closed to an empty allowlist.
      const reworkPrompt = buildCalibrationReworkUserMessage(params, question, calibration);
      const reworkStep = steps.step({
        slug: 'repair',
        label: `Adjusting scope (round ${attempt})`,
        kind: 'llm',
        attempt,
        prompt: reworkPrompt.maskedPrompt,
      });
      const reworked = await callGenerate(reworkPrompt.prompt, reworkStep).catch((err: unknown) => {
        reworkStep.fail(errorText(err));
        throw err;
      });
      reworkStep.done();
      // A rework must never drift the question's identity.
      question = { ...reworked, title: question.title, slug: question.slug };
      registerSpoilers(question);
      onStageResult(question);
    }
  }

  if (design) {
    steps
      .step({ slug: 'verify', label: 'Sandbox verification', kind: 'sandbox' })
      .skip(VERIFY_SKIP_REASON[config.type]);
    return { question, edgeCases: audit.edgeCases };
  }

  // Stage 3 — verify + repair loop (coding categories only).
  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    let failureReport: string;
    /** The red step of this attempt (static-check or verify) + its closed-vocabulary outcome. */
    let redStep: GenerationStepHandle;
    let redDetail: string;

    // Static import-allowlist check first: catches user-event/jsdom before
    // spending a vitest run (those packages are not even installed).
    const checkStep = steps.step({
      slug: 'static-check',
      label: 'Checking test imports',
      kind: 'static-check',
      attempt,
    });
    const disallowed = findDisallowedImports(question.testCode ?? '');
    const missing: string[] = [];
    if (!question.testCode?.trim()) missing.push('testCode');
    if (!question.referenceSolution?.trim()) missing.push('referenceSolution');
    if (!question.signature?.trim()) missing.push('signature');
    if (config.supportFiles.length > 0 && !question.supportCode?.trim()) missing.push('supportCode');

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
      const staticDetail: string[] = [];
      if (missing.length > 0) staticDetail.push(`missing: ${missing.join(', ')}`);
      if (disallowed.length > 0) {
        staticDetail.push(`imports outside allowlist: ${disallowed.join(', ')}`);
      }
      redStep = checkStep;
      redDetail = staticDetail.join(' · ');
    } else {
      checkStep.done('ok');
      onProgress('verifying', attempt);
      const verifyStep = steps.step({
        slug: 'verify',
        label: `Running tests (attempt ${attempt}/${MAX_VERIFY_ATTEMPTS})`,
        kind: 'sandbox',
        attempt,
      });
      const result = await verify(params.workspaceRoot, params.category, {
        referenceSolution: question.referenceSolution as string,
        testCode: question.testCode as string,
        stubSolution: renderSolutionStub(params.category, config.solutionFiles[0], {
          signature: question.signature ?? undefined,
          title: question.title,
        }),
        supportCode: question.supportCode,
      }).catch((err: unknown) => {
        // Environment problem (e.g. missing vitest binary) — not a red suite.
        verifyStep.fail(errorText(err));
        throw err;
      });
      if (result.green) {
        // The stub run's own counts never leave verifyGeneratedQuestion —
        // `summary` is always the reference run's.
        const s = result.summary;
        verifyStep.done(
          s
            ? `${s.passed}/${s.total} passed vs reference · stub fails as required`
            : 'passed vs reference · stub fails as required',
        );
        return { question, edgeCases: audit.edgeCases };
      }
      failureReport = result.failureReport ?? 'verification failed with no report';
      redStep = verifyStep;
      // The verify RESPONSE is withheld wholesale (assertion diffs are the
      // answer key) — the outcome line comes from the closed vocabulary only.
      redDetail = verifyFailureDetail(failureReport);
    }

    // The report is prompt-bound (repair) and can quote the reference
    // solution — register it so any verbatim echo is literal-scrubbed.
    steps.registerSecret(failureReport);

    if (attempt === MAX_VERIFY_ATTEMPTS) {
      redStep.fail(`verification exhausted after ${MAX_VERIFY_ATTEMPTS} attempts`);
      throw new GenerationVerifyError(question, failureReport);
    }
    redStep.fail(redDetail);

    onProgress('repairing', attempt + 1);
    const repairPrompt = buildRepairUserMessage(question, failureReport);
    const repairStep = steps.step({
      slug: 'repair',
      label: `Fixing tests (attempt ${attempt + 1}/${MAX_VERIFY_ATTEMPTS})`,
      kind: 'llm',
      attempt: attempt + 1,
      prompt: repairPrompt.maskedPrompt,
    });
    const repaired = await callGenerate(repairPrompt.prompt, repairStep).catch((err: unknown) => {
      repairStep.fail(errorText(err));
      throw err;
    });
    repairStep.done();
    // A repair must never drift the question's identity.
    question = { ...repaired, title: question.title, slug: question.slug };
    registerSpoilers(question);
    onStageResult(question);
  }

  // Unreachable: the loop either returns green or throws on the last attempt.
  throw new Error('generateVerifiedQuestion: verify loop exited unexpectedly');
}
