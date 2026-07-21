import fs from 'node:fs';
import path from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { CATEGORIES, type CategoryConfig } from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatObject, type LLMMessage } from '../lib/llm.js';
import { saveBlob } from './blobs.js';
import { readWorkspaceFile, toWorkspaceRelPath, writeWorkspaceFile } from './files.js';
import { uuidv7 } from './ids.js';
import { resolveProvider } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, DisputeRow, QuestionRow, TestRunRow } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

// Mirrors the contract in cli/prompts/test-dispute.md (and the schema in
// cli/commands/dispute.ts).
const TestVerdictSchema = z.enum(['test_incorrect', 'solution_incorrect', 'ambiguous']);

const DisputeResultSchema = z.object({
  verdict: TestVerdictSchema,
  summary: z.string(),
  details: z.string(),
  failingTests: z.array(
    z.object({
      testName: z.string(),
      verdict: TestVerdictSchema,
      explanation: z.string(),
      fixedAssertion: z.string().nullish(),
    }),
  ),
  fixedTestCode: z.string().nullish(),
  hint: z.string().nullish(),
});

type DisputeResult = z.infer<typeof DisputeResultSchema>;

/** Returns an actionable error when the run is not disputable, else null. */
export function getDisputeGuardError(question: QuestionRow, run: TestRunRow): string | null {
  if (run.questionId !== question.id) return 'test run does not belong to this question';
  const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[question.category];
  if (!config) return `unknown category "${question.category}"`;
  if (config.testFiles.length === 0) {
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
}): DisputeEngine {
  const { db, bus, workspaceRoot } = opts;
  const inFlight = new Map<string, string>(); // questionId → disputeJobId
  let disposed = false;

  async function runJob(
    disputeJobId: string,
    question: QuestionRow,
    run: TestRunRow,
    argument: string | null,
    config: CategoryConfig,
  ): Promise<void> {
    try {
      const provider = resolveProvider();
      if (!provider) throw new Error('no LLM API key configured — add one in Settings');

      const readme = readOr(path.join(question.dirPath, 'README.md'));

      // Prompt assembly mirrors cli/commands/dispute.ts, with the structured
      // run results standing in for raw vitest output.
      let solutionContent = '';
      for (const name of config.solutionFiles) {
        const content = readOr(path.join(question.dirPath, name));
        if (content) solutionContent += `\n--- ${name} ---\n${content}\n`;
      }

      let testContent = '';
      let testAbs = '';
      for (const name of config.testFiles) {
        const abs = path.join(question.dirPath, name);
        const content = readOr(abs);
        if (content) {
          testContent += content;
          testAbs = abs;
        }
      }
      if (!testContent.trim()) throw new Error('no test file found for this question');

      const systemPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'test-dispute.md'), 'utf8');
      const userContent = `## Problem Statement
${readme}

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

      // Bound the single-shot call so a stalled connection can't hold the
      // per-question in-flight slot (and its 409) until server restart.
      const abort = AbortSignal.timeout(180_000);
      const result = await chatObject(provider, messages, DisputeResultSchema, {
        abortSignal: abort,
      });
      if (disposed) return;

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
      bus.emit('dispute-done', { disputeJobId, questionId: question.id, dispute });
    } catch (err) {
      if (!disposed) {
        const message = NoObjectGeneratedError.isInstance(err)
          ? 'the model did not return a parseable dispute analysis — try again'
          : err instanceof Error
            ? err.message
            : String(err);
        bus.emit('dispute-error', { disputeJobId, questionId: question.id, message });
      }
    } finally {
      if (inFlight.get(question.id) === disputeJobId) inFlight.delete(question.id);
    }
  }

  function readOr(absPath: string): string {
    try {
      return fs.readFileSync(absPath, 'utf8');
    } catch {
      return '';
    }
  }

  return {
    start(question, run, argument) {
      if (disposed) throw new Error('dispute engine is disposed');
      if (inFlight.has(question.id)) {
        // Routes check isRunning first; this is a programming-error backstop.
        throw new Error('a dispute analysis is already running for this question');
      }
      const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[
        question.category
      ];
      if (!config) throw new Error(`unknown category "${question.category}"`);

      const disputeJobId = uuidv7();
      inFlight.set(question.id, disputeJobId);
      bus.emit('dispute-started', {
        disputeJobId,
        questionId: question.id,
        testRunId: run.id,
      });
      void runJob(disputeJobId, question, run, argument, config);
      return { disputeJobId };
    },

    isRunning(questionId) {
      return inFlight.has(questionId);
    },

    isAnyRunning() {
      return inFlight.size > 0;
    },

    dispose() {
      disposed = true;
      inFlight.clear();
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
