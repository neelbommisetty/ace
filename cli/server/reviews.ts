import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES,
  getPromptGroup,
  isDesignCategory,
  type CategoryConfig,
  type CategorySlug,
} from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatStream, type LLMMessage, type LLMProvider } from '../lib/llm.js';
import { getStubContent } from '../lib/scaffold.js';
import { saveBlob } from './blobs.js';
import { sha1, toWorkspaceRelPath } from './files.js';
import { uuidv7 } from './ids.js';
import { resolveProvider } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, QuestionRow } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');
const CHUNK_FLUSH_MS = 50;
const STREAM_IDLE_TIMEOUT_MS = 120_000;

// Mirrors the (unexported) model constants in cli/lib/llm.ts so persisted
// reviews record which model produced them.
const PROVIDER_MODELS: Record<LLMProvider, string> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-sonnet-4-5-20250929',
};

// ---------------------------------------------------------------------------
// Pure parsers over a finished review body (unit-tested in review-parse.test.ts).
// ---------------------------------------------------------------------------

const SCORE_RE = /overall[^0-9]{0,20}(\d(?:\.\d)?)\s*\/\s*5/i;

/** Extracts the "Overall N/5" score from a review body. */
export function parseReviewScore(body: string): number | null {
  const match = SCORE_RE.exec(body);
  return match ? Number.parseFloat(match[1]) : null;
}

// Longest-first alternation so "Strong Hire" never half-matches as "Hire".
// Case-sensitive on purpose: the rubrics emit title-case verdicts, and prose
// like "we would hire them" must not register as a verdict.
const VERDICT_RE = /Strong Hire|Lean Hire|No Hire|Hire/;

/** Finds the first hire-scale verdict mentioned in a review body. */
export function parseReviewVerdict(body: string): string | null {
  const match = VERDICT_RE.exec(body);
  return match ? match[0] : null;
}

// The shipped rubrics (cli/prompts/review/*.md) request score lists like
// "- Correctness: 4" or "- Deep Dive / Trade-offs: 3" — bare 1–5, no "/5".
// Match any full line of that shape (optional bullet/numbering/bold, name
// starting uppercase, lone 1–5 value with optional "/5" at end of line).
const DIMENSION_LINE_RE =
  /^\s*(?:[-*]\s*)?(?:\d+\.\s*)?\*{0,2}([A-Z][A-Za-z /&'-]{2,40}?)\*{0,2}\s*:\s*\*{0,2}([1-5])(?:\s*\/\s*5)?\*{0,2}\s*$/;

/**
 * Collects rubric dimension scores from the review body ("- Correctness: 4",
 * "Requirements Gathering: 4/5" …), keyed by the name as written; first
 * mention of a name wins. Returns null when no score line is present.
 */
export function parseReviewDimensions(body: string): Record<string, number> | null {
  const dimensions: Record<string, number> = {};
  for (const line of body.split('\n')) {
    const match = DIMENSION_LINE_RE.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    // "Overall: 4/5" is the score line, not a dimension.
    if (/^overall\b/i.test(name)) continue;
    if (dimensions[name] === undefined) {
      dimensions[name] = Number.parseInt(match[2], 10);
    }
  }
  return Object.keys(dimensions).length > 0 ? dimensions : null;
}

// ---------------------------------------------------------------------------
// Reviewability guard (the route turns a non-null result into a 400).
// ---------------------------------------------------------------------------

function hasMeaningfulNotes(notes: string): boolean {
  // Mirrors hasMeaningfulDesignNotes in cli/commands/feedback.ts: at least one
  // non-blank line that is neither a heading nor an HTML comment.
  return notes
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('<!--'));
}

function readFileOr(absPath: string, fallback: string): string {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Pure stub heuristic (unit-tested). getStubContent renders with EMPTY
 * placeholders while scaffolded files carry the real signature/title, so plain
 * equality misses every generated question — hence the extra checks: a file
 * whose only code lines are the few declaration/brace lines around a
 * "// TODO: implement" marker is still the scaffold. Real solutions with a
 * leftover TODO comment have real statement lines and sail past the cap.
 */
export function isEffectivelyStub(content: string, renderedEmptyStub: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (trimmed === renderedEmptyStub.trim()) return true;
  const codeLines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'),
    );
  if (codeLines.length === 0) return true;
  if (content.includes('// TODO: implement') && codeLines.length <= 6) return true;
  return false;
}

/** Returns an actionable error when the question is not reviewable yet, else null. */
export function getReviewGuardError(question: QuestionRow, db?: AceDb): string | null {
  const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[question.category];
  if (!config) return `unknown category "${question.category}"`;

  if (isDesignCategory(question.category as CategorySlug)) {
    const notes = readFileOr(path.join(question.dirPath, 'notes.md'), '');
    if (!hasMeaningfulNotes(notes)) {
      return 'notes.md has no design notes yet — write your design before requesting a review';
    }
    return null;
  }

  const primary = config.solutionFiles[0];
  let content: string | null;
  try {
    content = fs.readFileSync(path.join(question.dirPath, primary), 'utf8');
  } catch {
    content = null;
  }
  if (content === null) {
    return `${primary} is missing — write your solution before requesting a review`;
  }
  const stub = getStubContent(question.category as CategorySlug, primary);
  if (isEffectivelyStub(content, stub)) {
    return `${primary} is still the untouched stub — write your solution before requesting a review`;
  }
  // Exact-baseline check: unchanged since the pristine scaffold snapshot
  // (captured on first room open, re-recorded after a fresh-attempt reset).
  // Never compare against 'reset' snapshots — those hold the user's own
  // pre-reset code, which they may legitimately restore.
  if (db) {
    const relPath = ['questions', question.category, question.slug, primary].join('/');
    const baseline = db.getLatestSnapshot(question.id, relPath, 'scaffold');
    if (baseline && baseline.hash === sha1(content)) {
      return `${primary} is unchanged since it was scaffolded — write your solution before requesting a review`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt assembly (mirrors cli/commands/feedback.ts).
// ---------------------------------------------------------------------------

function buildReviewMessages(
  question: QuestionRow,
  config: CategoryConfig,
  kind: 'code' | 'design',
): LLMMessage[] {
  const group = getPromptGroup(question.category as CategorySlug);
  const systemPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'review', `${group}.md`), 'utf8');
  const readme = readFileOr(path.join(question.dirPath, 'README.md'), '');

  let userContent: string;
  if (kind === 'design') {
    const notes = readFileOr(path.join(question.dirPath, 'notes.md'), '');
    const designSubType =
      question.category === 'design-fe'
        ? 'frontend'
        : question.category === 'design-be'
          ? 'backend'
          : 'full-stack';

    userContent = `## Design Sub-Type: ${designSubType}

## Problem Statement
${readme}

## Candidate's Design Notes
${notes}`;
  } else {
    let solutionContent = '';
    for (const name of config.solutionFiles) {
      const content = readFileOr(path.join(question.dirPath, name), '');
      if (content) solutionContent += `\n--- ${name} ---\n${content}\n`;
    }
    let testContent = '';
    for (const name of config.testFiles) {
      const content = readFileOr(path.join(question.dirPath, name), '');
      if (content) testContent += `\n--- ${name} ---\n${content}\n`;
    }

    userContent = `## Problem Statement
${readme}

## Candidate's Solution Code
${solutionContent}

## Test Cases
${testContent}`;
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ReviewEngine {
  /** Kicks off a review job; the route must check isRunning first (409). */
  start(question: QuestionRow, attemptId: string | null): { jobId: string };
  isRunning(questionId: string): boolean;
  dispose(): void;
}

interface ReviewJob {
  jobId: string;
  flushTimer: NodeJS.Timeout | null;
}

export function createReviewEngine(opts: {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
}): ReviewEngine {
  const { db, bus, workspaceRoot } = opts;
  const inFlight = new Map<string, ReviewJob>();
  let disposed = false;

  async function runJob(
    job: ReviewJob,
    question: QuestionRow,
    attemptId: string | null,
    config: CategoryConfig,
  ): Promise<void> {
    const { jobId } = job;
    let pending = '';

    const flushChunks = () => {
      if (job.flushTimer) {
        clearTimeout(job.flushTimer);
        job.flushTimer = null;
      }
      if (pending.length > 0 && !disposed) {
        bus.emit('review-chunk', { jobId, chunk: pending });
        pending = '';
      }
    };

    try {
      const provider = resolveProvider();
      if (!provider) throw new Error('no LLM API key configured — add one in Settings');

      // Snapshot the primary solution file exactly as it goes to the reviewer.
      const primaryAbs = path.join(question.dirPath, config.solutionFiles[0]);
      const primaryContent = fs.readFileSync(primaryAbs, 'utf8');
      const snapshotHash = saveBlob(workspaceRoot, primaryContent);
      db.addSnapshot({
        questionId: question.id,
        attemptId,
        relPath: toWorkspaceRelPath(workspaceRoot, primaryAbs),
        hash: snapshotHash,
        trigger: 'review',
      });

      const messages = buildReviewMessages(question, config, kindOf(question));

      // A silently-stalled provider connection would otherwise hold the
      // per-question in-flight slot (and its 409) until server restart.
      const abort = new AbortController();
      let lastChunkAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastChunkAt > STREAM_IDLE_TIMEOUT_MS) {
          abort.abort(new Error('review stream stalled — no output for 2 minutes'));
        }
      }, 15_000);

      let fullText = '';
      try {
        const stream = await chatStream(provider, messages, { abortSignal: abort.signal });
        for await (const chunk of stream) {
          lastChunkAt = Date.now();
          fullText += chunk;
          pending += chunk;
          // Coalesce token chunks: at most one SSE event per flush window.
          if (!job.flushTimer) job.flushTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS);
        }
      } finally {
        clearInterval(watchdog);
      }
      flushChunks();
      if (disposed) return;

      let review;
      try {
        review = db.createReview({
          questionId: question.id,
          attemptId,
          bodyMd: fullText,
          verdict: parseReviewVerdict(fullText),
          score: parseReviewScore(fullText),
          dimensions: parseReviewDimensions(fullText),
          snapshotHash,
          model: PROVIDER_MODELS[provider],
          source: 'user',
        });
      } catch (persistErr) {
        // The stream is paid for — never lose a completed body to a db hiccup.
        // (.ace/tmp is wiped at boot, so salvage lives directly under .ace/.)
        const salvagePath = path.join(workspaceRoot, '.ace', `review-salvage-${jobId}.md`);
        try {
          fs.writeFileSync(salvagePath, fullText, 'utf8');
        } catch {
          // disk itself is failing; the SSE chunks are the last copy
        }
        const reason = persistErr instanceof Error ? persistErr.message : String(persistErr);
        throw new Error(
          `review completed but could not be saved (${reason}); full text salvaged to ${salvagePath}`,
        );
      }
      bus.emit('review-done', { jobId, questionId: question.id, review });
    } catch (err) {
      // Persist nothing on failure — the partial text already traveled via
      // chunks, so flush whatever is buffered before announcing the error.
      flushChunks();
      if (!disposed) {
        bus.emit('review-error', {
          jobId,
          questionId: question.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (job.flushTimer) {
        clearTimeout(job.flushTimer);
        job.flushTimer = null;
      }
      if (inFlight.get(question.id) === job) inFlight.delete(question.id);
    }
  }

  function kindOf(question: QuestionRow): 'code' | 'design' {
    return isDesignCategory(question.category as CategorySlug) ? 'design' : 'code';
  }

  return {
    start(question, attemptId) {
      if (disposed) throw new Error('review engine is disposed');
      if (inFlight.has(question.id)) {
        // Routes check isRunning first; this is a programming-error backstop.
        throw new Error('a review is already running for this question');
      }
      const config = (CATEGORIES as Record<string, CategoryConfig | undefined>)[
        question.category
      ];
      if (!config) throw new Error(`unknown category "${question.category}"`);

      const job: ReviewJob = { jobId: uuidv7(), flushTimer: null };
      inFlight.set(question.id, job);
      bus.emit('review-started', {
        jobId: job.jobId,
        questionId: question.id,
        kind: kindOf(question),
      });
      void runJob(job, question, attemptId, config);
      return { jobId: job.jobId };
    },

    isRunning(questionId) {
      return inFlight.has(questionId);
    },

    dispose() {
      disposed = true;
      for (const job of inFlight.values()) {
        if (job.flushTimer) {
          clearTimeout(job.flushTimer);
          job.flushTimer = null;
        }
      }
      inFlight.clear();
    },
  };
}
