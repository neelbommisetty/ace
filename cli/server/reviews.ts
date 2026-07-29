import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  hasTests,
  isProseAnswer,
  lookupCategoryConfig,
  type CategoryConfig,
  type QuestionType,
} from '../lib/categories.js';
import { isPositiveVerdict } from '../../shared/verdicts.js';
import { chatObject, chatStream, getModelId, type LLMMessage } from '../lib/llm.js';
import { readFileOr } from '../lib/read-file-or.js';
import { buildQuestionSection, buildSystemPrompt } from '../lib/prompt-builder.js';
import { getStubContent } from '../lib/scaffold.js';
import { WITHHELD_MARKER } from '../lib/spoilers.js';
import { NULL_AI_LOG, type AiLog } from './ai-log.js';
import { saveBlob } from './blobs.js';
import { sha1, toWorkspaceRelPath } from './files.js';
import { uuidv7 } from './ids.js';
import { createJobRegistry } from './job-engine.js';
import { resolveProvider } from './settings.js';
import type { Bus } from './sse.js';
import type {
  AceDb,
  AttemptEndReason,
  AttemptRow,
  QuestionRow,
  ReviewRow,
} from './types.js';

const CHUNK_FLUSH_MS = 50;
// 180s: the charter-driven review prompt is beefier than its predecessor.
const STREAM_IDLE_TIMEOUT_MS = 180_000;
const EXTRACT_TIMEOUT_MS = 60_000;

// Post-stream structured extraction of the persisted score fields. The regex
// parsers below remain the fallback contract — extraction failing (or
// returning nulls) must never fail or degrade a paid review.
const ReviewExtractionSchema = z.object({
  score: z.number().nullable(),
  verdict: z.enum(['Strong Hire', 'Hire', 'Lean Hire', 'No Hire']).nullable(),
  dimensions: z.record(z.string(), z.number()).nullable(),
});

const EXTRACTION_PROMPT = `You extract structured scores from a completed interview review.

Given the review text, return:
- "score": the overall score out of 5 (at most one decimal), or null if the review states none
- "verdict": the hire recommendation, exactly one of "Strong Hire" | "Hire" | "Lean Hire" | "No Hire", or null if none is stated
- "dimensions": a map from each scored dimension's name (as written) to its 1-5 integer score, or null if there are none

Extract only what the review actually states — never invent or infer values.`;

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

// The pre-overhaul rubrics (and today's review skeleton) request score lists like
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

/**
 * At least one non-blank line that is neither a heading nor part of an HTML
 * comment — i.e. the user wrote something beyond the notes.md/story.md
 * template. HTML-comment tracking is block-aware: a `<!-- … -->` that wraps
 * onto multiple lines (every hint comment in story.md.hbs does) counts as a
 * comment in full, not just its opening line — so this can only ever
 * classify MORE content as non-meaningful, never less.
 */
export function hasMeaningfulNotes(notes: string): boolean {
  let inComment = false;
  for (const raw of notes.split('\n')) {
    // Strip the commented spans out of the line; whatever is left is the
    // user's own content. Scanning by index rather than by line prefix is
    // what lets a sentence typed right after a hint's `-->` still count —
    // a line-prefix test would silently discard it.
    let rest = raw;
    let visible = '';
    while (rest.length > 0) {
      if (inComment) {
        const close = rest.indexOf('-->');
        if (close === -1) break;
        inComment = false;
        rest = rest.slice(close + 3);
      } else {
        const open = rest.indexOf('<!--');
        if (open === -1) {
          visible += rest;
          break;
        }
        visible += rest.slice(0, open);
        inComment = true;
        rest = rest.slice(open + 4);
      }
    }
    const line = visible.trim();
    if (line.length > 0 && !line.startsWith('#')) return true;
  }
  return false;
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

/**
 * The noun used in review-guard messages ("write your X before requesting a
 * review"), per question type — a Record so widening QuestionType forces a
 * decision here, the same discipline as REVIEW_KIND below. `coding`'s value
 * keeps the pre-NEE-342 wording ("write your solution") byte-identical.
 */
const GUARD_NOUN: Record<QuestionType, string> = {
  coding: 'solution',
  design: 'design',
  behavioral: 'story',
};

/**
 * Exact-baseline check: true when `content`'s sha1 matches the pristine
 * scaffold snapshot (captured on first room open, re-recorded after a
 * fresh-attempt reset) for `relFile`. Shared by both branches below.
 *
 * Scope, precisely: this catches a BYTE-IDENTICAL scaffold, nothing more. It
 * is exact-hash equality, not a similarity measure — one stray character
 * defeats it, at which point only the heuristics above are left. So it is a
 * backstop against the template's own boilerplate fooling those heuristics,
 * NOT a general "did the user actually do the work" check.
 *
 * Never compares against 'reset' snapshots — those hold the user's own
 * pre-reset content, which they may legitimately restore.
 */
function isUnchangedSinceScaffold(
  question: QuestionRow,
  db: AceDb,
  relFile: string,
  content: string,
): boolean {
  const relPath = ['questions', question.category, question.slug, relFile].join('/');
  const baseline = db.getLatestSnapshot(question.id, relPath, 'scaffold');
  return baseline !== null && baseline.hash === sha1(content);
}

/** Returns an actionable error when the question is not reviewable yet, else null. */
export function getReviewGuardError(question: QuestionRow, db?: AceDb): string | null {
  const config = lookupCategoryConfig(question.category);
  if (!config) return `unknown category "${question.category}"`;

  const primary = config.solutionFiles[0];
  const noun = GUARD_NOUN[config.type];

  if (isProseAnswer(config)) {
    const notes = readFileOr(path.join(question.dirPath, primary));
    if (!hasMeaningfulNotes(notes)) {
      return `${primary} has no ${noun} notes yet — write your ${noun} before requesting a review`;
    }
    // Backstop for the case where the template's own boilerplate defeats
    // hasMeaningfulNotes: an untouched scaffold is caught by hash even when
    // the heuristic reads it as written. Exact equality only — see
    // isUnchangedSinceScaffold.
    if (db && isUnchangedSinceScaffold(question, db, primary, notes)) {
      return `${primary} is unchanged since it was scaffolded — write your ${noun} before requesting a review`;
    }
    return null;
  }

  let content: string | null;
  try {
    content = fs.readFileSync(path.join(question.dirPath, primary), 'utf8');
  } catch {
    content = null;
  }
  if (content === null) {
    return `${primary} is missing — write your ${noun} before requesting a review`;
  }
  const stub = getStubContent(config.slug, primary);
  if (isEffectivelyStub(content, stub)) {
    return `${primary} is still the untouched stub — write your ${noun} before requesting a review`;
  }
  if (db && isUnchangedSinceScaffold(question, db, primary, content)) {
    return `${primary} is unchanged since it was scaffolded — write your ${noun} before requesting a review`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt assembly — the single source of truth for the review prompt.
// ---------------------------------------------------------------------------

export type ReviewKind = 'code' | 'design' | 'behavioral';

/**
 * Review-prompt branch, per question type — a Record so widening
 * QuestionType forces a decision here instead of a silent boolean
 * fallthrough (kindOf used to be a design/coding ternary, which would have
 * silently taken the 'code' branch for a behavioral question). `coding`/
 * `design` map onto the existing 'code'/'design' wire values verbatim.
 */
const REVIEW_KIND: Record<QuestionType, ReviewKind> = {
  coding: 'code',
  design: 'design',
  behavioral: 'behavioral',
};

/**
 * Exported for test coverage only (review-messages.test.ts): the per-kind
 * user-message shape is exactly what "byte-for-byte unaffected" (NEE-344
 * acceptance #3) has to be asserted against, and the internal engine never
 * calls this from outside the module.
 */
export function buildReviewMessages(
  question: QuestionRow,
  config: CategoryConfig,
  kind: ReviewKind,
): { messages: LLMMessage[]; maskedPrompt: string } {
  const systemPrompt = buildSystemPrompt('review', config.slug);
  const readme = readFileOr(path.join(question.dirPath, 'README.md'));

  let userContent: string;
  switch (kind) {
    case 'design': {
      const notes = readFileOr(path.join(question.dirPath, config.solutionFiles[0]));
      const designSubType =
        question.category === 'design-fe'
          ? 'frontend'
          : question.category === 'design-be'
            ? 'backend'
            : 'full-stack';

      userContent = `## Design Sub-Type: ${designSubType}

${buildQuestionSection(readme)}

## Candidate's Design Notes
${notes}`;
      break;
    }
    case 'behavioral': {
      const story = readFileOr(path.join(question.dirPath, config.solutionFiles[0]));
      userContent = `${buildQuestionSection(readme)}

## Candidate's Story
${story}`;
      break;
    }
    case 'code': {
      let solutionContent = '';
      for (const name of config.solutionFiles) {
        const content = readFileOr(path.join(question.dirPath, name));
        if (content) solutionContent += `\n--- ${name} ---\n${content}\n`;
      }
      let testContent = '';
      for (const name of config.testFiles) {
        const content = readFileOr(path.join(question.dirPath, name));
        if (content) testContent += `\n--- ${name} ---\n${content}\n`;
      }

      userContent = `${buildQuestionSection(readme)}

## Candidate's Solution Code
${solutionContent}

## Test Cases
${testContent}`;
      break;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled review kind: ${String(exhaustive)}`);
    }
  }

  // Generated questions carry a hidden interviewer packet (grading key:
  // capability tested, Staff-level bar, rubric) — inject it so the reviewer
  // grades against it. Pre-overhaul/manual questions simply have none. The
  // masked twin for the activity log is CONSTRUCTED from the same parts
  // (gen-pipeline's BuiltPrompt convention) — packets embed their own `## `
  // headings, which would split maskPromptText's section scan if parsed.
  const packet = readFileOr(path.join(question.dirPath, '.interviewer.md')).trim();
  const maskedPrompt = packet
    ? `${userContent}\n\n## Interviewer Packet\n\n${WITHHELD_MARKER}`
    : userContent;
  if (packet) {
    userContent += `\n\n## Interviewer Packet\n${packet}`;
  }

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    maskedPrompt,
  };
}

// ---------------------------------------------------------------------------
// Attempt end for prose categories (NEE-356)
// ---------------------------------------------------------------------------

/**
 * Ends the active attempt of a no-test question when its review completes.
 *
 * Coding categories end their attempt client-side (useTestRuns' claim-on-
 * leave, re-verified by `isAttemptSolved`) because a test run is the thing
 * that marks the work done. Prose categories have `testFiles: []`, so that
 * signal can never fire — before this, a design/behavioral attempt stayed
 * open forever, which in turn made readonly reference mode, "Start new
 * attempt" and a second round of follow-up probes unreachable. The review
 * completing IS the end of the attempt here.
 *
 * The end reason carries the verdict, using the SAME positive-verdict rule
 * `isQuestionSolved`/`listQuestions` derive `solved` from: 'solved' when
 * the review cleared the bar, 'submitted' when it did not (the answer was
 * assessed, just not passed) — so a 'No Hire' attempt closes without ever
 * claiming the question is solved.
 *
 * Exported for the engine tests; `null` when nothing was ended.
 */
export function endProseAttemptOnReview(opts: {
  db: AceDb;
  bus: Bus;
  question: QuestionRow;
  config: CategoryConfig;
  /** The attempt the review was started for (routes/reviews.ts), if any. */
  attemptId: string | null;
  review: ReviewRow;
}): AttemptRow | null {
  const { db, bus, question, config, attemptId, review } = opts;
  if (hasTests(config)) return null;
  const active = db.getActiveAttempt(question.id);
  if (active == null) return null;
  // A fresh attempt started while the review was streaming is NOT the one
  // this review assessed — leave it open. (attemptId is null only when the
  // review was requested with no active attempt at all, e.g. from a
  // readonly room; then whatever is active now was started afterwards too,
  // so it is left alone as well.)
  if (active.id !== attemptId) return null;
  const reason: AttemptEndReason = isPositiveVerdict(review.verdict) ? 'solved' : 'submitted';
  const ended = db.patchAttempt(active.id, { end: { reason } });
  bus.emit('attempt-ended', {
    attemptId: ended.id,
    questionId: question.id,
    attempt: ended,
  });
  return ended;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ReviewEngine {
  /** Kicks off a review job; the route must check isRunning first (409). */
  start(question: QuestionRow, attemptId: string | null): { jobId: string };
  isRunning(questionId: string): boolean;
  /** True while any review is streaming, across all questions. */
  isAnyRunning(): boolean;
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
  /**
   * AI activity recorder (NEE-268). Defaults to the zero-behaviour
   * NULL_AI_LOG, so every pre-existing test runs unchanged; the server
   * session passes the shared recorder.
   */
  aiLog?: AiLog;
}): ReviewEngine {
  const { db, bus, workspaceRoot } = opts;
  const aiLog = opts.aiLog ?? NULL_AI_LOG;
  // questionId → ReviewJob (the job object, not just an id, so dispose()
  // below can reach the pending flush timers).
  const inFlight = createJobRegistry<string, ReviewJob>({ name: 'review' });

  async function runJob(
    job: ReviewJob,
    question: QuestionRow,
    attemptId: string | null,
    config: CategoryConfig,
  ): Promise<void> {
    const { jobId } = job;
    let pending = '';
    // Declared here (not inside the outer try below) so the catch path can
    // still salvage it — a stream that streamed real body text before
    // stalling out must not lose that text just because the job errored.
    let fullText = '';
    // One activity-log run per review job (NEE-271). Created before anything
    // can fail, so even a missing API key leaves a (zero-step) errored run
    // behind for Activity to render. Recording is best-effort throughout and
    // never touches the review's own state.
    const run = aiLog.startRun({
      kind: 'review',
      refId: jobId,
      questionId: question.id,
      label: question.title,
    });

    const flushChunks = () => {
      if (job.flushTimer) {
        clearTimeout(job.flushTimer);
        job.flushTimer = null;
      }
      if (pending.length > 0 && !inFlight.isDisposed()) {
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

      const { messages, maskedPrompt } = buildReviewMessages(question, config, kindOf(config));

      // A silently-stalled provider connection would otherwise hold the
      // per-question in-flight slot (and its 409) until server restart.
      // lastChunkAt is reset on raw response bytes (onStreamActivity below,
      // NEE-361), NOT merely on text chunks — a buffering local proxy can
      // hold back every text delta for a whole turn while still forwarding
      // bytes, and a long adaptive-thinking pause on a healthy paid review
      // can likewise go well past this window with zero text output.
      const abort = new AbortController();
      let lastChunkAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastChunkAt > STREAM_IDLE_TIMEOUT_MS) {
          abort.abort(new Error('review stream stalled — no output for 3 minutes'));
        }
      }, 15_000);

      // The prompt is shown — it's the user's own code/design plus the
      // README; on generated questions the interviewer packet rides only the
      // constructed masked twin (the recorder's maskPromptText remains the
      // second line of defence).
      const reviewStep = run.step({
        slug: 'review',
        label: 'Writing the review',
        kind: 'llm',
        prompt: maskedPrompt,
      });

      try {
        const stream = await chatStream(provider, messages, {
          abortSignal: abort.signal,
          purpose: 'review',
          onStreamActivity: () => {
            lastChunkAt = Date.now();
          },
        });
        for await (const chunk of stream) {
          fullText += chunk;
          pending += chunk;
          // The body travels twice on purpose (review-chunk here plus the
          // recorder's ai-step-chunk): SSE to localhost is free and zero
          // special cases is worth more than the bytes.
          reviewStep.append(chunk);
          // Coalesce token chunks: at most one SSE event per flush window.
          if (!job.flushTimer) job.flushTimer = setTimeout(flushChunks, CHUNK_FLUSH_MS);
        }
      } catch (err) {
        reviewStep.fail(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        clearInterval(watchdog);
      }
      reviewStep.done();
      flushChunks();
      // A paid call that resolved after dispose() — see
      // JobRegistry.isDisposed() for the write-through rationale.
      if (inFlight.isDisposed()) return;

      // Structured extraction of {score, verdict, dimensions} from the
      // finished prose. Any failure — timeout, parse error, out-of-range
      // score — falls back to the regex parsers per field; a paid review is
      // never lost or delayed indefinitely over its metadata. The step's
      // prompt is the review body itself — already user-visible text.
      const extractStep = run.step({
        slug: 'review-extract',
        label: 'Extracting scores',
        kind: 'llm',
        prompt: fullText,
      });
      let extracted: z.infer<typeof ReviewExtractionSchema> | null = null;
      try {
        extracted = await chatObject(
          provider,
          [
            { role: 'system', content: EXTRACTION_PROMPT },
            { role: 'user', content: fullText },
          ],
          ReviewExtractionSchema,
          { purpose: 'review-extract', abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
        );
        if (extracted.score !== null && (extracted.score < 0 || extracted.score > 5)) {
          extracted.score = null;
        }
        // Hold dimensions to the same contract the regex parser guarantees
        // structurally (lone 1–5 integers); drop anything else so a
        // hallucinated {Correctness: 47} can never reach the db/UI.
        if (extracted.dimensions !== null) {
          const sane = Object.fromEntries(
            Object.entries(extracted.dimensions).filter(
              ([, v]) => Number.isInteger(v) && v >= 1 && v <= 5,
            ),
          );
          extracted.dimensions = Object.keys(sane).length > 0 ? sane : null;
        }
        // Non-streaming call, so the (sanitized) result lands as one partial.
        extractStep.partial(extracted as Record<string, unknown>);
        const parts: string[] = [];
        if (extracted.score !== null) parts.push(`score ${extracted.score}/5`);
        if (extracted.verdict !== null) parts.push(extracted.verdict);
        extractStep.done(parts.length > 0 ? parts.join(' · ') : 'no scores stated');
      } catch (err) {
        // An errored extraction step never degrades the run — the regex
        // parsers below remain the fallback contract.
        extractStep.fail(err instanceof Error ? err.message : String(err));
        extracted = null;
      }
      if (inFlight.isDisposed()) {
        // The stream is paid for and fully buffered — never silently drop it
        // just because teardown landed during the extraction await. (.ace/tmp
        // is wiped at boot, so salvage lives directly under .ace/.)
        const salvagePath = path.join(workspaceRoot, '.ace', `review-salvage-${jobId}.md`);
        try {
          fs.writeFileSync(salvagePath, fullText, 'utf8');
        } catch {
          // disk itself is failing; the SSE chunks are the last copy
        }
        return;
      }

      let review;
      try {
        review = db.createReview({
          questionId: question.id,
          attemptId,
          bodyMd: fullText,
          verdict: extracted?.verdict ?? parseReviewVerdict(fullText),
          score: extracted?.score ?? parseReviewScore(fullText),
          dimensions: extracted?.dimensions ?? parseReviewDimensions(fullText),
          snapshotHash,
          model: getModelId(provider, 'review'),
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
      run.done();
      bus.emit('review-done', { jobId, questionId: question.id, review });
      // Prose categories only (NEE-356): the review IS the end of the
      // attempt. Best-effort and strictly after 'review-done' — a db hiccup
      // while closing the attempt must never turn a completed, persisted,
      // already-announced review into a 'review-error'.
      try {
        endProseAttemptOnReview({ db, bus, question, config, attemptId, review });
      } catch {
        // the attempt stays open; the review itself is safe
      }
    } catch (err) {
      // Persist nothing on failure — the partial text already traveled via
      // chunks, so flush whatever is buffered before announcing the error.
      flushChunks();
      if (!inFlight.isDisposed()) {
        let message = err instanceof Error ? err.message : String(err);
        // The abort/error can land mid-stream with real (paid-for) review
        // text already accumulated — e.g. the watchdog aborting a stalled
        // connection after the model wrote a partial body. Same salvage
        // convention as the db-write failure path above (.ace/tmp is wiped
        // at boot, so salvage lives directly under .ace/). Skip when the
        // message already names a salvage path — the db-persist catch above
        // rethrows through here after salvaging, and we must not name the
        // same file twice (once "full", once "partial").
        if (fullText.length > 0 && !message.includes('salvaged to')) {
          const salvagePath = path.join(workspaceRoot, '.ace', `review-salvage-${jobId}.md`);
          try {
            fs.writeFileSync(salvagePath, fullText, 'utf8');
            message = `${message}; partial review text salvaged to ${salvagePath}`;
          } catch {
            // disk itself is failing; the SSE chunks are the last copy
          }
        }
        run.fail(message);
        bus.emit('review-error', { jobId, questionId: question.id, message });
      }
    } finally {
      if (job.flushTimer) {
        clearTimeout(job.flushTimer);
        job.flushTimer = null;
      }
      inFlight.release(question.id, job);
    }
  }

  function kindOf(config: CategoryConfig): ReviewKind {
    return REVIEW_KIND[config.type];
  }

  return {
    start(question, attemptId) {
      inFlight.assertNotDisposed();
      inFlight.assertNotRunning(question.id, 'a review is already running for this question');
      const config = lookupCategoryConfig(question.category);
      if (!config) throw new Error(`unknown category "${question.category}"`);

      const job: ReviewJob = { jobId: uuidv7(), flushTimer: null };
      inFlight.claim(question.id, job);
      bus.emit('review-started', {
        jobId: job.jobId,
        questionId: question.id,
        kind: kindOf(config),
      });
      void runJob(job, question, attemptId, config);
      return { jobId: job.jobId };
    },

    isRunning(questionId) {
      return inFlight.isRunning(questionId);
    },

    isAnyRunning() {
      return inFlight.isAnyRunning();
    },

    dispose() {
      // Review-specific teardown the registry can't own: kill the pending
      // chunk-flush timers before the in-flight collection is emptied.
      for (const job of inFlight.jobs()) {
        if (job.flushTimer) {
          clearTimeout(job.flushTimer);
          job.flushTimer = null;
        }
      }
      inFlight.dispose();
    },
  };
}
