import fs from 'node:fs';
import path from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import {
  getCategoryConfig,
  getSuggestedTime,
  slugify,
  type CategoryConfig,
  type CategorySlug,
} from '../lib/categories.js';
import {
  generateVerifiedQuestion,
  GenerationVerifyError,
  GeneratedQuestionSchema,
  MAX_VERIFY_ATTEMPTS,
  type GeneratedQuestion,
} from '../lib/gen-pipeline.js';
import type { VerifyFn } from '../lib/gen-verify.js';
import { chatObjectStream } from '../lib/llm.js';
import { formatReferenceSolutionMd, scaffoldQuestionAt } from '../lib/scaffold.js';
import { maskPromptText, splitSpoilers } from '../lib/spoilers.js';
import { extractCompetencyFromReadme, normalizeCompetency } from '../../shared/competencies.js';
import { NULL_AI_LOG, type AiLog } from './ai-log.js';
import { nowIso } from './ids.js';
import { createJobRegistry, toEngineErrorMessage } from './job-engine.js';
import { hasProvider as hasProviderFromSettings } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, Difficulty, GenerationJobRow, QuestionRow } from './types.js';

// Canonical schema/type now live in cli/lib/gen-pipeline.ts (shared with the
// CLI); re-exported so existing importers keep working.
export { GeneratedQuestionSchema, type GeneratedQuestion };

// Path-traversal guard for LLM-supplied slugs (e.g. a malicious/malformed
// '../evil' or 'Foo Bar' must never reach fs.mkdirSync as-is).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Resolves a safe, unique slug for a generated question: the LLM-supplied
 * slug is used only if it passes SLUG_RE, else we fall back to
 * slugify(title||topic) — falling back further to a fixed default when
 * BOTH title and topic slugify to '' (e.g. neither contains any ASCII
 * alphanumerics), since an empty base can never produce an SLUG_RE-safe
 * candidate (every candidate, including the -2..-9 suffixed ones, starts
 * with '-' or is '') and would otherwise make the job permanently
 * unretryable with a misleading "too many collisions" error. Suffixes
 * -2..-9 on a collision — checked against both the filesystem AND the db's
 * question rows, since a slug can be reserved on a job row (patched before
 * any file/db write) without yet existing in either place — re-checking
 * SLUG_RE on every candidate first. Throws if all 9 candidates are taken.
 */
function resolveSlug(
  db: AceDb,
  workspaceRoot: string,
  category: CategorySlug,
  parsedSlug: string | null | undefined,
  title: string,
  topic: string,
): string {
  const trimmed = parsedSlug?.trim();
  const base = trimmed && SLUG_RE.test(trimmed) ? trimmed : slugify(title || topic) || 'question';
  for (let n = 1; n <= 9; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!SLUG_RE.test(candidate)) continue;
    const dir = path.join(workspaceRoot, 'questions', category, candidate);
    if (!fs.existsSync(dir) && !db.getQuestion(category, candidate)) return candidate;
  }
  throw new Error(`could not find an available slug for "${base}" — too many collisions`);
}

/**
 * Coding questions ship the calibrate stage's confirmed per-question
 * estimate (clamped to its own 10-60 hard-cap band, matching the prompt
 * contract — see gen-pipeline.ts's CalibrationSchema); design/behavioral
 * keep the static suggestedTimes table unconditionally, ignoring `estimate`
 * even if one is somehow present. `estimate` is `number | null` per
 * GeneratedQuestionSchema, but a resumed job predating this field can carry
 * `undefined` too (no runtime validation re-parses persisted job rows), so
 * the guard is a `typeof` check rather than a bare `Number.isFinite` call.
 */
function resolveSuggestedMinutes(
  config: CategoryConfig,
  difficulty: Difficulty,
  estimate: number | null | undefined,
): number {
  return config.type === 'coding' && typeof estimate === 'number' && Number.isFinite(estimate)
    ? Math.min(60, Math.max(10, Math.round(estimate)))
    : getSuggestedTime(config.slug, difficulty);
}

/**
 * Corpus-dedupe feed for behavioral generation (NEE-343): every existing
 * behavioral question's title and competency, appended to the generate user
 * message so the model picks a distinct competency instead of five prompts
 * in a row collapsing onto "conflict". Deliberately behavioral-scoped — there
 * is no dedupe anywhere else in the app, and this does not generalise to
 * coding/design categories.
 *
 * The db carries no competency column (the README is the source of truth,
 * kept visible on purpose — see shared/competencies.ts), so competencies are
 * read back off each question's scaffolded README on disk. A README that
 * vanished between `listQuestions()` and this read (or predates NEE-343 and
 * has no `**Competency:**` line at all) just contributes "unknown" rather
 * than dropping the title from the feed.
 *
 * `excludeQuestionId` (NEE-386) drops one question from the feed — the
 * source question of a regenerate-with-feedback run, so the model isn't told
 * to avoid the very competency the revision is meant to keep or address.
 * Defaults to undefined, which excludes nothing (today's exact behaviour).
 */
function buildBehavioralCorpusNote(db: AceDb, excludeQuestionId?: string | null): string {
  const existing = db
    .listQuestions()
    .filter((q) => q.category === 'behavioral' && q.id !== excludeQuestionId);
  if (existing.length === 0) return '';

  const lines = existing.map((q) => {
    let readme = '';
    try {
      readme = fs.readFileSync(path.join(q.dirPath, 'README.md'), 'utf8');
    } catch {
      // dir vanished between listQuestions() and this read — fall through
    }
    const competency = extractCompetencyFromReadme(readme);
    return `- "${q.title}" — competency: ${competency ?? 'unknown'}`;
  });

  return `

## Existing Behavioral Questions in This Workspace

Do not repeat the competency any of these already probe — choose a distinct
competency from the closed vocabulary.

${lines.join('\n')}`;
}

/** Injectable seam so unit tests never need a real API key. */
export interface GenerationLlm {
  chatObjectStream: typeof chatObjectStream;
}

/**
 * Strips the hidden interviewer artifacts (SPOILER_KEYS, via splitSpoilers
 * so this list can never drift from the chokepoint's) from a job row's
 * persisted `result` before the row leaves the server. The review-gated
 * debrief endpoint is the ONLY door to that content; without this, the
 * job-list routes and the 'generation-started' SSE event would hand the
 * answer key to the exact user the gate exists for. `rawText` is nulled
 * outright (NEE-265): it carries the vitest failure report or the raw
 * unparsed model output — both answer key. The un-redacted row stays in the
 * db — retry's scaffold-only resume and salvage debugging need it.
 */
export function redactGenerationJob(job: GenerationJobRow): GenerationJobRow {
  return {
    ...job,
    result: job.result == null ? job.result : splitSpoilers(job.result).safe,
    rawText: null,
  };
}

export interface GenerationEngine {
  /** Kicks off a generation job; concurrency-cap enforcement is the route's job. */
  start(params: {
    category: CategorySlug;
    difficulty: Difficulty;
    topic: string;
    brainstormSessionId?: string | null;
    /**
     * Set together (or neither) — the regenerate-with-feedback flow
     * (NEE-386): `sourceQuestionId` is the question this job revises,
     * `feedback` is the user's free-text critique. runJob resolves the prior
     * result server-side from `sourceQuestionId`'s latest done job; redaction
     * never touches the in-db row. `start` throws (before any job row is
     * created) when exactly one of the two is set — a one-field job would
     * generate from scratch yet still auto-archive the source.
     */
    feedback?: string | null;
    sourceQuestionId?: string | null;
  }): { jobId: string };
  /**
   * Resumes a job that landed on 'error'. Throws if `job.status` is anything
   * else (concurrency-cap enforcement, like `start`, is the route's job — not
   * this method's). If the job already has a persisted `result` (an LLM call
   * already succeeded), this is a scaffold-only resume that never calls the
   * llm again; otherwise it re-runs the full pipeline from scratch. Re-emits
   * 'generation-started' with the SAME jobId.
   */
  retry(job: GenerationJobRow): { jobId: string };
  /** Number of jobs currently in flight, across all categories. */
  runningCount(): number;
  isAnyRunning(): boolean;
  dispose(): void;
}

export function createGenerationEngine(opts: {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
  llm?: GenerationLlm;
  /**
   * Injectable seam alongside `llm`: without it, a keyless test env would hit
   * settings.ts's hasProvider() (real API-key config) before ever reaching
   * the injected `llm` fake, making the `llm` seam alone insufficient to
   * drive the pipeline without an API key. Defaults to the real
   * settings-backed gate.
   */
  hasProvider?: () => boolean;
  /**
   * Injectable seam alongside `llm`/`hasProvider`: the sandbox verifier
   * needs a workspace vitest binary, which test envs don't have. Defaults to
   * the real sandbox verifier inside generateVerifiedQuestion.
   */
  verify?: VerifyFn;
  /**
   * AI activity recorder (NEE-268). Defaults to the zero-behaviour
   * NULL_AI_LOG, so CLI-style embedding and every pre-existing test run
   * unchanged; the server session passes the shared recorder.
   */
  aiLog?: AiLog;
}): GenerationEngine {
  const { db, bus, workspaceRoot } = opts;
  const llm = opts.llm ?? { chatObjectStream };
  const hasProvider = opts.hasProvider ?? hasProviderFromSettings;
  const aiLog = opts.aiLog ?? NULL_AI_LOG;
  const inFlight = createJobRegistry<string>({ name: 'generation' });

  // `resumeFromResult: true` is the retry-scaffold-only path: `job.result` is
  // already a persisted, paid-for LLM output, so the llm call is skipped
  // entirely and we jump straight to slug resolution + scaffolding.
  async function runJob(
    job: GenerationJobRow,
    runOpts: { resumeFromResult?: boolean } = {},
  ): Promise<void> {
    const jobId = job.id;
    const category = job.category as CategorySlug;
    const config = getCategoryConfig(category);
    const difficulty = job.difficulty;
    // One activity-log run per runJob invocation — a retry mints a NEW run
    // with the same refId (the run id is never the jobId). Created before
    // anything can fail, so even a missing API key leaves a (zero-step)
    // errored run behind for Activity to render. Recording is best-effort
    // throughout and never touches the job's own state.
    const run = aiLog.startRun({
      kind: 'generation',
      refId: jobId,
      questionId: null,
      label: job.topic,
    });
    // True once generateVerifiedQuestion returned green (or we resumed from
    // an already-persisted result). Until then, any per-stage `result` in the
    // db is UNVERIFIED — an error must clear it so retry re-runs the full
    // pipeline instead of scaffold-resuming unverified tests.
    let pipelineDone = false;
    try {
      let parsed: GeneratedQuestion;
      let title: string;

      if (runOpts.resumeFromResult && job.result) {
        // A persisted result only survives error paths that come AFTER a
        // fully verified pipeline (scaffold failure, llm_done-write failure),
        // so resuming from it never ships unverified tests.
        parsed = job.result as unknown as GeneratedQuestion;
        title = job.title || parsed.title || job.topic;
        pipelineDone = true;
      } else {
        if (!hasProvider()) throw new Error('no LLM API key configured — add one in Settings');

        // Regenerate-with-feedback (NEE-386): both fields are write-once on
        // the job row, so this is re-derivable on every runJob call
        // (including a retry) purely from `job` — no separate state to keep
        // in sync. The prior result is resolved HERE, server-side, never via
        // redactGenerationJob (which strips spoilers) — the pipeline needs
        // the real referenceSolution/interviewerPacket to build the revision
        // prompt and to register them as scrub secrets.
        let regenerate: { priorQuestion: GeneratedQuestion; feedback: string } | undefined;
        if (job.sourceQuestionId != null && job.feedback != null) {
          const sourceJob = db.getLatestDoneGenerationJobForQuestion(job.sourceQuestionId);
          if (sourceJob?.result == null) {
            throw new Error('the original generation result is no longer available for this question');
          }
          regenerate = {
            priorQuestion: sourceJob.result as unknown as GeneratedQuestion,
            feedback: job.feedback,
          };
        }

        // Exclude the source question from its own dedupe feed (NEE-386) —
        // otherwise a behavioral regenerate would be told to avoid the exact
        // competency the revision is meant to keep or address.
        const corpusNote =
          category === 'behavioral' ? buildBehavioralCorpusNote(db, job.sourceQuestionId) : '';
        // Coding-only: `estimatedMinutes` is a field the output contract
        // only asks coding categories to report, so a numeric time target
        // only means something there. Design gets its own time-budget line
        // one stage later, in buildCalibrationUserMessage's design branch.
        // Behavioral never sizes against a clock.
        const timeBudget =
          config.type === 'coding'
            ? `\n\nTime budget: a ${difficulty} ${config.name} question targets ${getSuggestedTime(category, difficulty)} minutes. Choose scope that fits it.`
            : '';
        const userMessage = `Generate a ${difficulty} difficulty ${config.name} interview question about: ${job.topic}

Category slug: ${category}
Question type: ${config.type}${corpusNote}${timeBudget}`;

        // Full verified pipeline: four staged authoring calls (problem →
        // reference solution → tests → interviewer packet, each on its own
        // model slot) → edge-audit → calibrate → sandbox verify with repair
        // loop (design/behavioral: no solution/test stages, no sandbox). Each
        // stage's paid output is persisted immediately via onStageResult; the
        // pipeline's per-call no-output-progress timeout (plus its absolute
        // ceiling) bounds a stalled provider without cutting a slow-but-
        // streaming call (NEE-264). `regenerate`, when set, replaces the
        // authoring sequence with a single whole-object revision call built
        // by buildRegenerateUserMessage.
        const outcome = await generateVerifiedQuestion(
          { category, difficulty, userMessage, workspaceRoot, regenerate },
          {
            llm,
            verify: opts.verify,
            onProgress: (phase, attempt) => {
              if (!inFlight.isDisposed()) bus.emit('generation-progress', { jobId, phase, attempt });
            },
            onStageResult: (stage) => {
              if (inFlight.isDisposed()) return;
              try {
                db.patchGenerationJob(jobId, {
                  result: stage as unknown as Record<string, unknown>,
                });
              } catch {
                // Non-final stage persistence is best-effort; the final
                // llm_done patch below has the salvage path.
              }
            },
            // The AiRunHandle structurally satisfies the pipeline's steps
            // sink — the pipeline records its own llm/static-check/verify
            // steps; only `scaffold` (below) lives out here.
            steps: run,
          },
        );
        parsed = outcome.question;
        pipelineDone = true;
        // A paid call that resolved after dispose() — see
        // JobRegistry.isDisposed() for the write-through rationale.
        if (inFlight.isDisposed()) return;

        title = parsed.title || job.topic;

        // Persist first: the LLM call is paid for, so the parsed result must
        // land in the db BEFORE any file I/O is attempted. If the write
        // itself throws, salvage the JSON to disk rather than lose it.
        try {
          db.patchGenerationJob(jobId, { status: 'llm_done', result: parsed, title });
        } catch (persistErr) {
          const salvagePath = path.join(workspaceRoot, '.ace', `generation-salvage-${jobId}.json`);
          try {
            fs.writeFileSync(salvagePath, JSON.stringify(parsed, null, 2), 'utf8');
          } catch {
            // disk itself is failing; nothing more we can do
          }
          const reason = persistErr instanceof Error ? persistErr.message : String(persistErr);
          throw new Error(
            `generation completed but could not be saved (${reason}); result salvaged to ${salvagePath}`,
          );
        }
      }

      // Resolved once and reused for BOTH the scaffolded README and the db
      // row below, so the two can never desync (a stale-inflated DB value
      // with a truthful README, or vice versa).
      const suggestedMinutes = resolveSuggestedMinutes(config, difficulty, parsed.estimatedMinutes);

      // Everything from slug resolution through the question upsert is the
      // 'scaffold' activity step — it lives outside the pipeline, so runJob
      // records it itself. A scaffold-only retry resume shows exactly this
      // one step, so the retry isn't invisible in Activity.
      const scaffoldStep = run.step({
        slug: 'scaffold',
        label: 'Writing question files',
        kind: 'scaffold',
      });
      let question: QuestionRow;
      let slug: string;
      try {
        // Slug: if this job already has one recorded (a prior attempt — full
        // run or retry — got at least as far as persisting it), reuse it as-is
        // rather than re-resolving/re-suffixing — UNLESS a *generated* question
        // already exists in the db under that (category, slug). An
        // 'error'-state job's own `questionId` is always null (the only place
        // that's ever set is the 'done' patch below, and 'done' jobs can't be
        // retried), so an existing row with source 'generated' there can only
        // be a DIFFERENT job's completed output that raced in after this job
        // reserved the slug but before it scaffolded — reusing it would
        // silently overwrite that job's question via upsertQuestion's ON
        // CONFLICT. (A 'manual' row at this slug, by contrast, is exactly the
        // boot-reconcile race this job's own leftover scaffold artifacts can
        // produce — see the provenance re-assertion below — and must still be
        // reused/corrected, not treated as a collision.) In the collision
        // case, drop the stale reservation and resolve fresh instead.
        // Otherwise resolve fresh: the LLM-supplied slug is validated/
        // sanitized and, on a collision, suffixed -2..-9. Recorded on the job
        // row BEFORE any file I/O so a retry after a scaffold failure reuses
        // the same slug rather than re-suffixing or spending a second LLM call.
        let dir: string;
        const staleSlugTaken = job.slug
          ? db.getQuestion(category, job.slug)?.source === 'generated'
          : false;
        if (job.slug && !staleSlugTaken) {
          slug = job.slug;
          dir = path.join(workspaceRoot, 'questions', category, slug);
        } else {
          slug = resolveSlug(db, workspaceRoot, category, parsed.slug, title, job.topic);
          dir = path.join(workspaceRoot, 'questions', category, slug);
          db.patchGenerationJob(jobId, { slug });
        }

        // If the dir already exists (a partial prior attempt got as far as
        // writing files before failing later in the pipeline), reuse it as-is —
        // idempotent, no re-suffix, no re-scaffold. But a dir that exists with
        // zero files is not a completed scaffold — it's the leftover of a
        // prior write failure right after the dir was created (e.g. disk full
        // on the very first file) — wipe it so the scaffold step below runs
        // fresh instead of the job landing 'done' with a permanently empty,
        // unrecoverable question dir (patchGenerationJob rejects any patch
        // once status is 'done').
        let dirAlreadyExists = fs.existsSync(dir);
        if (dirAlreadyExists && fs.readdirSync(dir).length === 0) {
          fs.rmSync(dir, { recursive: true, force: true });
          dirAlreadyExists = false;
        }

        // LLM solutionCode is always discarded (anti-cheat rule) — the
        // scaffold templates build a stub from the signature instead. Wrapped
        // separately so a post-LLM-success I/O failure (disk full, permission
        // denied, a last-instant dir collision) never loses the already-persisted
        // result_json — the outer catch below patches status 'error' without
        // touching the `result` field, so it stays intact for a scaffold-only retry.
        if (!dirAlreadyExists) {
          try {
            ({ dir } = scaffoldQuestionAt(
              workspaceRoot,
              {
                title,
                slug,
                category,
                difficulty,
                suggestedMinutes,
                description: parsed.description || '',
                signature: parsed.signature ?? undefined,
                testCode: parsed.testCode ?? undefined,
                supportCode: parsed.supportCode ?? undefined,
                interviewerPacket: parsed.interviewerPacket ?? undefined,
                referenceSolutionMd: parsed.referenceSolution
                  ? formatReferenceSolutionMd(parsed.referenceSolution)
                  : undefined,
                // Normalized defensively (NEE-343): the model can drift on
                // casing/spacing, and an unrecognized value degrades to no
                // README line rather than failing the whole job — this is
                // interview framing, not something worth burning a retry
                // over.
                competency: parsed.competency ? normalizeCompetency(parsed.competency) : undefined,
                followUps: parsed.followUps ?? undefined,
              },
              { writeScorecard: false },
            ));
          } catch (scaffoldErr) {
            const reason = scaffoldErr instanceof Error ? scaffoldErr.message : String(scaffoldErr);
            throw new Error(
              `question files could not be written (${reason}) — result is saved, retry to resume`,
            );
          }
        }

        const upserted = db.upsertQuestion({
          category,
          slug,
          title,
          difficulty,
          suggestedMinutes,
          dirPath: dir,
          source: 'generated',
        });
        // Re-assert provenance: covers the crash window where boot-time
        // reconcile already inserted this scorecard-less dir as source
        // 'manual', which upsertQuestion's insert-only source semantics can
        // never correct on its own. `upserted.source` itself may still read
        // stale ('manual') here — the ON CONFLICT branch never touches
        // `source` — so the corrected value is applied locally too, rather
        // than emitting/persisting-on-the-job a snapshot that's already wrong.
        db.setQuestionSource(upserted.id, 'generated');
        question = { ...upserted, source: 'generated' as const };
      } catch (err) {
        scaffoldStep.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
      scaffoldStep.done(`questions/${category}/${slug}`);

      db.patchGenerationJob(jobId, { status: 'done', questionId: question.id });

      // Auto-archive the source question of a regenerate-with-feedback run
      // (NEE-386) — best-effort, on the shared done path so a scaffold-only
      // retry resume still archives. Never patches the done source job
      // itself; `archiveQuestion` only flips `archivedAt`. Guarded against
      // the (accepted, v1) concurrent-regenerate case where this job's own
      // question IS the source (can't happen today — a fresh scaffold always
      // gets a new id — but the check costs nothing and rules out ever
      // self-archiving the just-created question).
      if (job.sourceQuestionId != null && job.sourceQuestionId !== question.id) {
        try {
          if (db.archiveQuestion(job.sourceQuestionId)) bus.emit('questions-changed', {});
        } catch {
          // best-effort — the replacement is already live; a failure here
          // must never poison the already-'done' job.
        }
      }

      run.done();
      bus.emit('generation-done', { jobId, question });
    } catch (err) {
      if (!inFlight.isDisposed()) {
        if (err instanceof GenerationVerifyError) {
          // Clear the persisted per-stage result so retry's resumeFromResult
          // check re-runs the FULL pipeline — never scaffold a question whose
          // tests were left unverified. (Scaffold failures below keep their
          // result intact for the scaffold-only resume.)
          const message = err.message;
          try {
            db.patchGenerationJob(jobId, {
              status: 'error',
              errorMessage: message,
              result: null,
              rawText: err.failureReport,
            });
          } catch {
            // job row may already be in a terminal state — nothing more to do
          }
          // Fixed phrase, never err.message: it embeds the failure report's
          // first line, which must not become ai_runs/ai_steps text.
          run.fail(`verification exhausted after ${MAX_VERIFY_ATTEMPTS} attempts`);
          bus.emit('generation-error', { jobId, message });
          return;
        }
        // Masked + secret-scrubbed BEFORE it leaves the engine: this message
        // reaches the browser via the job row's errorMessage (which
        // redactGenerationJob passes through) and the 'generation-error'
        // event — neither goes through the recorder — and a provider error
        // can echo prompt content verbatim. Since NEE-386 the stage-1
        // regenerate prompt embeds the PRIOR question's answer key, which
        // registerSpoilers hands to this run's scrubber before the call.
        // maskPromptText is lossless on plain heading-free messages, so
        // ordinary errors pass through byte-identical.
        const message = run.scrub(
          maskPromptText(
            toEngineErrorMessage(err, 'the model did not return a parseable question — try again'),
          ),
        );
        const rawText = NoObjectGeneratedError.isInstance(err) ? (err.text ?? null) : null;
        try {
          // A failure BEFORE the pipeline finished leaves only unverified
          // per-stage output in `result` — clear it so retry re-runs the full
          // pipeline. Post-pipeline failures (scaffolding, the llm_done
          // write) keep it for the scaffold-only resume.
          db.patchGenerationJob(jobId, {
            status: 'error',
            errorMessage: message,
            rawText,
            ...(pipelineDone ? {} : { result: null }),
          });
        } catch {
          // job row may already be in a terminal state — nothing more to do
        }
        // The recorder masks + secret-scrubs the message; `rawText` (the
        // unparsed answer key on NoObjectGeneratedError) is never given to it.
        run.fail(message);
        bus.emit('generation-error', { jobId, message });
      }
    } finally {
      inFlight.release(jobId, jobId);
    }
  }

  return {
    start(params) {
      inFlight.assertNotDisposed();

      // "Set together (or neither)" is load-bearing, not just documentation:
      // runJob's regenerate branch requires BOTH fields, while the
      // auto-archive guard on the done path keys off sourceQuestionId alone
      // — a one-field job would run a plain from-scratch generation and then
      // still archive the source question. No live caller can produce that
      // shape (the route validates both), so fail fast before a row exists
      // rather than let a future caller hit it silently.
      if ((params.feedback == null) !== (params.sourceQuestionId == null)) {
        throw new Error(
          'feedback and sourceQuestionId must be set together (or neither) — got exactly one',
        );
      }

      const job = db.createGenerationJob({
        category: params.category,
        difficulty: params.difficulty,
        topic: params.topic,
        brainstormSessionId: params.brainstormSessionId ?? null,
        feedback: params.feedback ?? null,
        sourceQuestionId: params.sourceQuestionId ?? null,
      });
      inFlight.claim(job.id, job.id);
      bus.emit('generation-started', { job: redactGenerationJob(job) });
      void runJob(job);
      return { jobId: job.id };
    },

    retry(job) {
      inFlight.assertNotDisposed();
      if (job.status !== 'error') {
        throw new Error(
          `generation job ${job.id} is not in an error state (status: ${job.status}) and cannot be retried`,
        );
      }

      // Clears the stale error message on the way back to 'running' and
      // re-stamps runStartedAt so the UI's elapsed clock restarts from this
      // retry, not the original creation (NEE-277); every other field
      // (result, title, slug, ...) is omitted from the patch and so is
      // preserved as-is — that preserved `result`/`slug` is exactly what
      // makes the scaffold-only resume path possible below.
      const resumed = db.patchGenerationJob(job.id, {
        status: 'running',
        errorMessage: null,
        runStartedAt: nowIso(),
      });
      inFlight.claim(resumed.id, resumed.id);
      bus.emit('generation-started', { job: redactGenerationJob(resumed) });
      void runJob(resumed, { resumeFromResult: resumed.result != null });
      return { jobId: resumed.id };
    },

    runningCount() {
      return inFlight.runningCount();
    },

    isAnyRunning() {
      return inFlight.isAnyRunning();
    },

    dispose() {
      inFlight.dispose();
    },
  };
}
