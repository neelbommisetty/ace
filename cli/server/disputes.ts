import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hasTests, lookupCategoryConfig, type CategoryConfig } from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatObjectStream, type LLMMessage } from '../lib/llm.js';
import { readFileOr } from '../lib/read-file-or.js';
import { buildQuestionSection } from '../lib/prompt-builder.js';
import { maskPromptText } from '../lib/spoilers.js';
import { NULL_AI_LOG, type AiLog } from './ai-log.js';
import { saveBlob } from './blobs.js';
import { readWorkspaceFile, toWorkspaceRelPath, writeWorkspaceFile } from './files.js';
import { uuidv7 } from './ids.js';
import { createJobRegistry, toEngineErrorMessage } from './job-engine.js';
import { resolveProvider } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, DisputeRow, QuestionRow, TestRunRow } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

// Mirrors the contract in cli/prompts/test-dispute.md.
const TestVerdictSchema = z.enum(['test_incorrect', 'solution_incorrect', 'ambiguous']);

// Optional fields are `.nullable()`, NOT `.nullish()`: OpenAI strict
// structured outputs require every property to appear in `required`, and a
// `.nullish()` field is emitted as optional — the codex backend 400s the
// whole call with invalid_json_schema (NEE-263/NEE-378 class; see
// gen-pipeline.ts for the same rule).
export const DisputeResultSchema = z.object({
  verdict: TestVerdictSchema,
  summary: z.string(),
  details: z.string(),
  failingTests: z.array(
    z.object({
      testName: z.string(),
      verdict: TestVerdictSchema,
      explanation: z.string(),
      fixedAssertion: z.string().nullable(),
    }),
  ),
  fixedTestCode: z.string().nullable(),
  hint: z.string().nullable(),
});

type DisputeResult = z.infer<typeof DisputeResultSchema>;

// 180s: same idle-window contract as the review watchdog (reviews.ts) —
// mirrors STREAM_IDLE_TIMEOUT_MS there, kept local since the two engines
// don't otherwise share constants.
const STREAM_IDLE_TIMEOUT_MS = 180_000;

/** Returns an actionable error when the run is not disputable, else null. */
export function getDisputeGuardError(question: QuestionRow, run: TestRunRow): string | null {
  if (run.questionId !== question.id) return 'test run does not belong to this question';
  const config = lookupCategoryConfig(question.category);
  if (!config) return `unknown category "${question.category}"`;
  if (!hasTests(config)) {
    return 'this question has no test files — there is nothing to dispute';
  }
  if (run.status !== 'done') {
    return `only finished test runs can be disputed (this run is "${run.status}")`;
  }
  if (!run.failed || run.failed <= 0) {
    return 'this run has no failing tests — there is nothing to dispute';
  }
  return null;
}

function renderDetailsMd(result: DisputeResult): string {
  let md = result.details;
  if (result.failingTests.length > 0) {
    const lines = result.failingTests.map((t) => {
      let item = `- **${t.testName}** — ${t.verdict}: ${t.explanation}`;
      if (t.fixedAssertion) item += `\n  - Fix: \`${t.fixedAssertion}\``;
      return item;
    });
    md += `\n\n### Per-test\n\n${lines.join('\n')}`;
  }
  return md;
}

function buildFailureOutput(run: TestRunRow): string {
  const failed = (run.results ?? []).filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    return failed
      .map((r) => {
        const name = r.suite ? `${r.suite} › ${r.name}` : r.name;
        return r.error ? `✕ ${name}\n${r.error}` : `✕ ${name}`;
      })
      .join('\n\n');
  }
  const stderr = run.stderr?.trim();
  return stderr ? stderr.slice(-4000) : '(no failure output captured)';
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface DisputeEngine {
  /** Kicks off a dispute analysis; the route must check isRunning first (409). */
  start(
    question: QuestionRow,
    run: TestRunRow,
    argument: string | null,
  ): { disputeJobId: string };
  isRunning(questionId: string): boolean;
  /** True while any dispute analysis is in flight, across all questions. */
  isAnyRunning(): boolean;
  dispose(): void;
}

export function createDisputeEngine(opts: {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
  /**
   * AI activity recorder (NEE-268). Defaults to the zero-behaviour
   * NULL_AI_LOG, so every pre-existing test runs unchanged; the server
   * session passes the shared recorder.
   */
  aiLog?: AiLog;
}): DisputeEngine {
  const { db, bus, workspaceRoot } = opts;
  const aiLog = opts.aiLog ?? NULL_AI_LOG;
  // questionId → disputeJobId
  const inFlight = createJobRegistry<string, string>({ name: 'dispute' });

  async function runJob(
    disputeJobId: string,
    question: QuestionRow,
    run: TestRunRow,
    argument: string | null,
    config: CategoryConfig,
  ): Promise<void> {
    // One activity-log run per dispute job (NEE-271). Created before
    // anything can fail, so even a missing API key leaves a (zero-step)
    // errored run behind for Activity to render. Recording is best-effort
    // throughout and never touches the dispute's own state.
    const aiRun = aiLog.startRun({
      kind: 'dispute',
      refId: disputeJobId,
      questionId: question.id,
      label: question.title,
    });
    try {
      const provider = resolveProvider();
      if (!provider) throw new Error('no LLM API key configured — add one in Settings');

      const readme = readFileOr(path.join(question.dirPath, 'README.md'));

      // Prompt assembly: the structured run results stand in for raw vitest
      // output. This is the only dispute prompt builder — the CLI copy that
      // used to shadow it was deleted with the rest of the retired commands.
      let solutionContent = '';
      for (const name of config.solutionFiles) {
        const content = readFileOr(path.join(question.dirPath, name));
        if (content) solutionContent += `\n--- ${name} ---\n${content}\n`;
      }

      let testContent = '';
      let testAbs = '';
      for (const name of config.testFiles) {
        const abs = path.join(question.dirPath, name);
        const content = readFileOr(abs);
        if (content) {
          testContent += content;
          testAbs = abs;
        }
      }
      if (!testContent.trim()) throw new Error('no test file found for this question');

      const systemPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'test-dispute.md'), 'utf8');
      const userContent = `${buildQuestionSection(readme)}

## Solution Code
${solutionContent}

## Test File
${testContent}

## Test Failure Output
\`\`\`
${buildFailureOutput(run)}
\`\`\``;

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];
      if (argument) {
        messages.push({
          role: 'user',
          content: `## Candidate's Argument\n\n${argument}`,
        });
      }

      // A fixed AbortSignal.timeout(180_000) used to bound this call, but
      // that caps a genuinely healthy call the same as a stalled one — a
      // buffering local proxy or a long adaptive-thinking pause can
      // legitimately run past 180s with no output. Same liveness-based
      // watchdog as the review engine (reviews.ts, NEE-361): reset on raw
      // response bytes (onStreamActivity), not a hard call-duration cap.
      const abort = new AbortController();
      let lastActivityAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivityAt > STREAM_IDLE_TIMEOUT_MS) {
          abort.abort(new Error('dispute analysis stalled — no output for 3 minutes'));
        }
      }, 15_000);
      // DisputeResultSchema is entirely wire-safe (fixedTestCode already
      // reaches the browser via the apply flow) and the prompt is the user's
      // own failing tests and output — both recorded as-is. The recorder
      // still masks unconditionally (its `## Solution Code` section is
      // withheld structurally).
      const step = aiRun.step({
        slug: 'dispute',
        label: 'Analyzing failing tests',
        kind: 'llm',
        prompt: messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n\n'),
      });
      let result: DisputeResult;
      try {
        result = await chatObjectStream(provider, messages, DisputeResultSchema, {
          abortSignal: abort.signal,
          purpose: 'dispute',
          onPartial: (partial) => step.partial(partial),
          onStreamActivity: () => {
            lastActivityAt = Date.now();
          },
        });
      } catch (err) {
        step.fail(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        clearInterval(watchdog);
      }
      step.done(result.verdict);
      // A paid call that resolved after dispose() — see
      // JobRegistry.isDisposed() for the write-through rationale.
      if (inFlight.isDisposed()) return;

      const dispute = db.createDispute({
        questionId: question.id,
        attemptId: run.attemptId,
        testRunId: run.id,
        argument,
        verdict: result.verdict,
        summary: result.summary,
        detailsMd: renderDetailsMd(result),
        fixedTestCode: result.fixedTestCode ?? null,
        testRelPath: toWorkspaceRelPath(workspaceRoot, testAbs),
        hint: result.hint ?? null,
      });
      aiRun.done();
      bus.emit('dispute-done', { disputeJobId, questionId: question.id, dispute });
    } catch (err) {
      if (!inFlight.isDisposed()) {
        // Masked + secret-scrubbed BEFORE the wire emit (same rationale as
        // generation.ts's generic catch): a provider error can echo prompt
        // content verbatim, and this message bypasses the recorder on its
        // way to the browser. Lossless on plain heading-free messages.
        const message = aiRun.scrub(
          maskPromptText(
            toEngineErrorMessage(
              err,
              'the model did not return a parseable dispute analysis — try again',
            ),
          ),
        );
        aiRun.fail(message);
        bus.emit('dispute-error', { disputeJobId, questionId: question.id, message });
      }
    } finally {
      inFlight.release(question.id, disputeJobId);
    }
  }

  return {
    start(question, run, argument) {
      inFlight.assertNotDisposed();
      inFlight.assertNotRunning(
        question.id,
        'a dispute analysis is already running for this question',
      );
      const config = lookupCategoryConfig(question.category);
      if (!config) throw new Error(`unknown category "${question.category}"`);

      const disputeJobId = uuidv7();
      inFlight.claim(question.id, disputeJobId);
      bus.emit('dispute-started', {
        disputeJobId,
        questionId: question.id,
        testRunId: run.id,
      });
      void runJob(disputeJobId, question, run, argument, config);
      return { disputeJobId };
    },

    isRunning(questionId) {
      return inFlight.isRunning(questionId);
    },

    isAnyRunning() {
      return inFlight.isAnyRunning();
    },

    dispose() {
      inFlight.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Thrown when a dispute cannot be applied; `status` is the HTTP status to use. */
export class DisputeApplyError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409) {
    super(message);
    this.name = 'DisputeApplyError';
    this.status = status;
  }
}

/**
 * Applies a dispute's corrected test file: snapshots the current test file
 * (trigger 'dispute-apply'), writes the fix through writeWorkspaceFile (which
 * registers watcher echo-suppression), and marks the dispute applied. The
 * client follows up with a normal test run.
 */
export function applyDispute(opts: {
  db: AceDb;
  workspaceRoot: string;
  dispute: DisputeRow;
}): DisputeRow {
  const { db, workspaceRoot, dispute } = opts;

  if (dispute.verdict !== 'test_incorrect' && dispute.verdict !== 'ambiguous') {
    throw new DisputeApplyError(
      `a "${dispute.verdict}" verdict cannot be applied — only test_incorrect or ambiguous disputes change the test file`,
      400,
    );
  }
  if (!dispute.fixedTestCode) {
    throw new DisputeApplyError('this dispute has no corrected test code to apply', 400);
  }
  if (dispute.appliedAt) {
    throw new DisputeApplyError('this dispute has already been applied', 409);
  }

  const current = readWorkspaceFile(workspaceRoot, dispute.testRelPath);
  if (current) {
    const hash = saveBlob(workspaceRoot, current.content);
    db.addSnapshot({
      questionId: dispute.questionId,
      attemptId: db.getActiveAttempt(dispute.questionId)?.id ?? null,
      relPath: dispute.testRelPath,
      hash,
      trigger: 'dispute-apply',
    });
  }

  writeWorkspaceFile(workspaceRoot, dispute.testRelPath, dispute.fixedTestCode);
  return db.markDisputeApplied(dispute.id);
}
