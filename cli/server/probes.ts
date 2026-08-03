import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  isProseAnswer,
  lookupCategoryConfig,
  type CategoryConfig,
  type QuestionType,
} from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatObjectStream, getModelId, type LLMMessage } from '../lib/llm.js';
import { readFileOr } from '../lib/read-file-or.js';
import { buildQuestionSection } from '../lib/prompt-builder.js';
import { maskPromptText } from '../lib/spoilers.js';
import { hasMeaningfulNotes } from './reviews.js';
import { NULL_AI_LOG, type AiLog } from './ai-log.js';
import { saveBlob } from './blobs.js';
import { toWorkspaceRelPath, writeWorkspaceFile } from './files.js';
import { uuidv7 } from './ids.js';
import { createJobRegistry, toEngineErrorMessage } from './job-engine.js';
import { hasProvider as hasProviderFromSettings } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, Probe, ProbeSetRow, QuestionRow } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

// Mirrors the contract in cli/prompts/features/probe.md.
const ProbeSchema = z.object({
  question: z.string(),
  source: z.enum(['bank', 'derived']),
});

// Bounding is structural (NEE-345): 2..4 probes, one paid call, no chunk
// event to grow into. The prompt separately requires >=1 'derived' probe —
// not re-enforced here via .refine(), matching the rest of this codebase's
// schemas (structured validation stays at "is this shape parseable", not
// "does the content satisfy the prompt's own rules").
const ProbeResultSchema = z.object({
  probes: z.array(ProbeSchema).min(2).max(4),
});

type ProbeResult = z.infer<typeof ProbeResultSchema>;

// Parses NEE-343's `.probes.md` numbered-list format (getProbeBankMd in
// cli/lib/scaffold.ts is the canonical renderer) — everything after the
// heading, one probe per numbered line. Absent file -> readFileOr('') ->
// zero matches -> every probe the engine returns is 'derived'.
const PROBE_BANK_ITEM_RE = /^\d+\.\s+(.+)$/gm;

/** Exported for test coverage — parses a `.probes.md` body into plain probe strings. */
export function parseProbeBank(md: string): string[] {
  const items: string[] = [];
  for (const match of md.matchAll(PROBE_BANK_ITEM_RE)) {
    items.push(match[1].trim());
  }
  return items;
}

const PROBE_HEADING_RE = /^### Probe (\d+)/gm;

/**
 * Purely additive, idempotent append (NEE-345): the first round adds a new
 * `## Follow-ups` H2 with `### Probe 1`, `### Probe 2`, …; every later round
 * appends more `### Probe N` entries under that SAME H2 (numbering
 * continuing from the highest existing N), never touching or re-emitting
 * anything already there. Nothing ever parses this section back out — the
 * review reads the whole file, and REST callers must not either.
 */
export function appendProbesToStory(current: string, probes: Probe[]): string {
  const trimmed = current.replace(/\s+$/, '');
  let maxN = 0;
  for (const m of current.matchAll(PROBE_HEADING_RE)) {
    const n = Number.parseInt(m[1], 10);
    if (n > maxN) maxN = n;
  }
  const sections = probes.map((p, i) => `### Probe ${maxN + i + 1} — ${p.question}\n`).join('\n');
  const hasFollowUps = /^## Follow-ups\s*$/m.test(current);
  return hasFollowUps
    ? `${trimmed}\n\n${sections.trimEnd()}\n`
    : `${trimmed}\n\n## Follow-ups\n\n${sections.trimEnd()}\n`;
}

/** Returns an actionable error when there is no story yet to drill into, else null. */
export function getProbeGuardError(question: QuestionRow): string | null {
  const config = lookupCategoryConfig(question.category);
  if (!config) return `unknown category "${question.category}"`;
  if (!isProseAnswer(config)) {
    return 'follow-up probes are only available for prose (behavioral/design) answers';
  }
  const primary = config.solutionFiles[0];
  const story = readFileOr(path.join(question.dirPath, primary));
  if (!hasMeaningfulNotes(story)) {
    return `${primary} has no story yet — write your story before requesting follow-up probes`;
  }
  return null;
}

/**
 * The bound (NEE-345): one probe set per attempt. `attemptId: null` is its
 * own bucket (no active attempt — a readonly/legacy edge case the room never
 * actually surfaces the button for).
 *
 * Only counts APPLIED probe sets (NEE-357): `createProbeSet` deliberately
 * persists the paid LLM output before the story.md write lands (see the
 * comment above that call in `runJob`) so a failed write never loses the
 * probes themselves — but that means a row with `appliedAt: null` records a
 * round that never actually reached the story file. Counting it here would
 * 409 every later attempt at this question forever with no way to recover.
 * An unapplied row is invisible to the bound; the next successful run is
 * simply a fresh probe set with the orphan left behind for forensics.
 */
export function hasProbeSetForAttempt(
  db: AceDb,
  questionId: string,
  attemptId: string | null,
): boolean {
  return db
    .listProbeSets(questionId)
    .some((p) => p.attemptId === attemptId && p.appliedAt != null);
}

/** Per-type framing for the probe prompt (NEE-362). */
interface ProbeFrame {
  /** Fills probe.md's `{{type-frame}}` slot — what a sharp derived follow-up
   *  should target for this question type. */
  typeFrame: string;
  /** Section heading over the candidate's prose in the user message —
   *  mirrors reviews.ts's REVIEW_KIND headings ('Candidate's Design Notes'
   *  vs 'Candidate's Story'), which this used to unconditionally diverge
   *  from by always sending 'Candidate's Story' regardless of category. */
  sectionHeading: string;
}

/**
 * Probe-prompt framing, per question type — a Record (mirrors REVIEW_KIND in
 * reviews.ts) so widening QuestionType with a new prose-answer type forces a
 * decision here at compile time instead of silently inheriting behavioral's
 * frame, which is exactly the bug this ticket fixes for 'design'. Follow-up
 * probes are prose-only — getProbeGuardError 400s non-prose categories
 * before the engine's `start()` is ever reached — so 'coding' has no real
 * frame; runJob throws defensively if it's ever selected anyway.
 */
const PROBE_FRAME: Record<QuestionType, ProbeFrame | null> = {
  behavioral: {
    typeFrame:
      'a vague claim, an unquantified outcome, a "we" that hides what they ' +
      'personally did, a skipped trade-off, or a suspiciously clean ' +
      'narrative with no friction. Read the story closely enough to name ' +
      'the specific gap.',
    sectionHeading: "Candidate's Story",
  },
  design: {
    typeFrame:
      "an unstated trade-off, a missing failure mode, an unexplored scale " +
      "limit, or capacity math that's hand-waved rather than worked " +
      'through. Read the notes closely enough to name the specific gap.',
    sectionHeading: "Candidate's Design Notes",
  },
  coding: null,
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ProbeEngine {
  /** Kicks off a probe generation round; the route must check isRunning + the bound first (409s). */
  start(question: QuestionRow, attemptId: string | null): { probeJobId: string };
  isRunning(questionId: string): boolean;
  /** True while any probe round is in flight, across all questions. */
  isAnyRunning(): boolean;
  dispose(): void;
}

/** Injectable seam so unit tests never need a real API key or ACE_E2E_MOCK_LLM (mirrors generation.ts). */
export interface ProbeLlm {
  chatObjectStream: typeof chatObjectStream;
}

export function createProbeEngine(opts: {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
  llm?: ProbeLlm;
  /** Injectable seam alongside `llm` — without it, a keyless test env would
   *  hit settings.ts's real hasProvider() before ever reaching the injected
   *  `llm` fake. Defaults to the real settings-backed gate. */
  hasProvider?: () => boolean;
  /**
   * AI activity recorder (NEE-268). Defaults to the zero-behaviour
   * NULL_AI_LOG, so every pre-existing test runs unchanged; the server
   * session passes the shared recorder.
   */
  aiLog?: AiLog;
}): ProbeEngine {
  const { db, bus, workspaceRoot } = opts;
  const llm = opts.llm ?? { chatObjectStream };
  const hasProvider = opts.hasProvider ?? hasProviderFromSettings;
  const aiLog = opts.aiLog ?? NULL_AI_LOG;
  // questionId -> probeJobId
  const inFlight = createJobRegistry<string, string>({ name: 'probe' });

  async function runJob(
    probeJobId: string,
    question: QuestionRow,
    attemptId: string | null,
    config: CategoryConfig,
  ): Promise<void> {
    const aiRun = aiLog.startRun({
      kind: 'probe',
      refId: probeJobId,
      questionId: question.id,
      label: question.title,
    });
    try {
      if (!hasProvider()) throw new Error('no LLM API key configured — add one in Settings');

      // Follow-up probes are prose-only (getProbeGuardError rejects
      // non-prose categories at the route before start() is ever reached),
      // so 'coding' never actually lands here — see PROBE_FRAME's comment.
      const frame = PROBE_FRAME[config.type];
      if (!frame) {
        throw new Error(`follow-up probes are not available for question type "${config.type}"`);
      }

      const readme = readFileOr(path.join(question.dirPath, 'README.md'));
      const primary = config.solutionFiles[0];
      const answerAbs = path.join(question.dirPath, primary);
      const answer = readFileOr(answerAbs);

      // Absent .probes.md (every manual/pre-M7/starter-pack question until
      // NEE-347 ships banks) degrades to zero bank items — every probe the
      // model returns is then necessarily 'derived'.
      const bank = parseProbeBank(readFileOr(path.join(question.dirPath, '.probes.md')));
      const bankSection =
        bank.length > 0
          ? bank.map((q, i) => `${i + 1}. ${q}`).join('\n')
          : '(none — derive every probe from the answer below)';

      const systemPrompt = fs
        .readFileSync(path.join(PROMPTS_DIR, 'features/probe.md'), 'utf8')
        .replace('{{type-frame}}', frame.typeFrame);
      const userContent = `${buildQuestionSection(readme)}

## ${frame.sectionHeading}
${answer}

## Probe Bank
${bankSection}`;

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];

      // Bound the single-shot call so a stalled connection can't hold the
      // per-question in-flight slot (and its 409) until server restart.
      const abort = AbortSignal.timeout(120_000);
      const step = aiRun.step({
        slug: 'probe',
        label: 'Drafting follow-up probes',
        kind: 'llm',
        prompt: messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content)
          .join('\n\n'),
      });
      let result: ProbeResult;
      // The row must record the model that actually WROTE these probes, not a
      // re-resolution afterwards: a Fable refusal retry is per-request and
      // deliberately does not latch, so the slot can still resolve to the
      // model that refused. The pre-call resolution is the fallback for mock
      // mode and the injected test seam, where no route is ever taken.
      let usedModel = getModelId('probe');
      // The recovered object is what the log records, so a run that only
      // succeeded after being un-double-encoded would otherwise read as a
      // clean success — this slot is where that failure was first seen
      // (NEE-411).
      let salvaged = false;
      try {
        result = await llm.chatObjectStream('probe', messages, ProbeResultSchema, {
          abortSignal: abort,
          onPartial: (partial) => step.partial(partial),
          onRoute: (route) => {
            usedModel = route.model;
          },
          onSalvaged: () => {
            salvaged = true;
          },
        });
      } catch (err) {
        step.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
      step.done(
        salvaged
          ? `${result.probes.length} probes (recovered from a mis-encoded response)`
          : `${result.probes.length} probes`,
      );
      // A paid call that resolved after dispose() — see
      // JobRegistry.isDisposed() for the write-through rationale.
      if (inFlight.isDisposed()) return;

      // Persist the paid output BEFORE the file side-effect (mirrors
      // generation.ts's llm_done patch): if the append below throws, the
      // probes themselves are not lost, and appliedAt staying null is the
      // durable signal that the story was never actually updated.
      let probeSet = db.createProbeSet({
        questionId: question.id,
        attemptId,
        probes: result.probes,
        model: usedModel,
      });

      // Re-read the answer file now, right before computing the append
      // (NEE-357): the LLM call above took 10-60s, and the file autosaves
      // every 600ms — `answer` above is a pre-call snapshot that may be
      // badly stale by now. appendProbesToStory is pure specifically so it
      // can be re-run against whatever is on disk this instant instead of
      // clobbering it with what was there when the call started. The
      // snapshot below records this SAME fresh read, not the stale pre-call
      // one, so it's an actual recovery point rather than a copy of
      // already-known-stale content.
      const freshAnswer = readFileOr(answerAbs);
      const hash = saveBlob(workspaceRoot, freshAnswer);
      db.addSnapshot({
        questionId: question.id,
        attemptId,
        relPath: toWorkspaceRelPath(workspaceRoot, answerAbs),
        hash,
        trigger: 'probe-append',
      });
      const updated = appendProbesToStory(freshAnswer, result.probes);
      writeWorkspaceFile(workspaceRoot, toWorkspaceRelPath(workspaceRoot, answerAbs), updated);

      probeSet = db.markProbeSetApplied(probeSet.id);
      aiRun.done();
      bus.emit('probes-done', { probeJobId, questionId: question.id, probeSet });
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
              'the model did not return parseable follow-up probes — try again',
            ),
          ),
        );
        aiRun.fail(message);
        bus.emit('probes-error', { probeJobId, questionId: question.id, message });
      }
    } finally {
      inFlight.release(question.id, probeJobId);
    }
  }

  return {
    start(question, attemptId) {
      inFlight.assertNotDisposed();
      inFlight.assertNotRunning(
        question.id,
        'a probe run is already in progress for this question',
      );
      const config = lookupCategoryConfig(question.category);
      if (!config) throw new Error(`unknown category "${question.category}"`);

      const probeJobId = uuidv7();
      inFlight.claim(question.id, probeJobId);
      bus.emit('probes-started', { probeJobId, questionId: question.id });
      void runJob(probeJobId, question, attemptId, config);
      return { probeJobId };
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
