import fs from 'node:fs';
import path from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import {
  getCategoryConfig,
  getPromptGroup,
  getSuggestedTime,
  slugify,
  type CategorySlug,
} from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatObject, type LLMMessage, type LLMProvider } from '../lib/llm.js';
import { scaffoldQuestionAt } from '../lib/scaffold.js';
import { resolveProvider as resolveProviderFromSettings } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, Difficulty, GenerationJobRow } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

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

// Copied from cli/commands/generate.ts's GeneratedQuestionSchema — same
// contract, different consumer (the server engine vs. the CLI command), kept
// in sync manually like IdeaListSchema/DisputeResultSchema are with their CLI
// counterparts elsewhere in this codebase.
export const GeneratedQuestionSchema = z.object({
  title: z.string(),
  slug: z.string().nullish(),
  description: z.string().nullish(),
  signature: z.string().nullish(),
  testCode: z.string().nullish(),
  solutionCode: z.string().nullish(),
});

export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

/** Injectable seam so unit tests never need a real API key. */
export interface GenerationLlm {
  chatObject: typeof chatObject;
}

export interface GenerationEngine {
  /** Kicks off a generation job; concurrency-cap enforcement is the route's job. */
  start(params: {
    category: CategorySlug;
    difficulty: Difficulty;
    topic: string;
    brainstormSessionId?: string | null;
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
   * settings.ts's resolveProvider() (real API-key config) before ever
   * reaching the injected `llm` fake, making the `llm` seam alone
   * insufficient to drive the pipeline without an API key. Defaults to the
   * real settings-backed resolver.
   */
  resolveProvider?: () => LLMProvider | null;
}): GenerationEngine {
  const { db, bus, workspaceRoot } = opts;
  const llm = opts.llm ?? { chatObject };
  const resolveProvider = opts.resolveProvider ?? resolveProviderFromSettings;
  const inFlight = new Set<string>();
  let disposed = false;

  // `resumeFromResult: true` is the retry-scaffold-only path: `job.result` is
  // already a persisted, paid-for LLM output, so the llm call is skipped
  // entirely and we jump straight to slug resolution + scaffolding.
  async function runJob(
    job: GenerationJobRow,
    runOpts: { resumeFromResult?: boolean } = {},
  ): Promise<void> {
    const jobId = job.id;
    const category = job.category as CategorySlug;
    const difficulty = job.difficulty;
    try {
      let parsed: GeneratedQuestion;
      let title: string;

      if (runOpts.resumeFromResult && job.result) {
        parsed = job.result as unknown as GeneratedQuestion;
        title = job.title || parsed.title || job.topic;
      } else {
        const provider = resolveProvider();
        if (!provider) throw new Error('no LLM API key configured — add one in Settings');

        const config = getCategoryConfig(category);
        const systemPrompt = fs.readFileSync(
          path.join(PROMPTS_DIR, 'generate', `${getPromptGroup(category)}.md`),
          'utf8',
        );
        const userMessage = `Generate a ${difficulty} difficulty ${config.name} interview question about: ${job.topic}

Category slug: ${category}
Question type: ${config.type}`;

        const messages: LLMMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ];

        // Bound the single-shot call (generateObject has no stream to
        // watchdog) so a stalled provider can't hold the in-flight slot (and
        // any downstream concurrency cap) until server restart.
        const abort = AbortSignal.timeout(180_000);
        parsed = await llm.chatObject(provider, messages, GeneratedQuestionSchema, {
          abortSignal: abort,
          maxOutputTokens: 8192,
          purpose: 'generate',
        });
        // Mirrors the disputes/reviews/brainstorm engines' convention: a paid
        // call that resolves after dispose() must not write through a db the
        // session teardown may already be closing (or have closed).
        if (disposed) return;

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
      let slug: string;
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
              description: parsed.description || '',
              signature: parsed.signature ?? undefined,
              testCode: parsed.testCode ?? undefined,
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
        suggestedMinutes: getSuggestedTime(category, difficulty),
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
      const question = { ...upserted, source: 'generated' as const };

      db.patchGenerationJob(jobId, { status: 'done', questionId: question.id });
      bus.emit('generation-done', { jobId, question });
    } catch (err) {
      if (!disposed) {
        const message = NoObjectGeneratedError.isInstance(err)
          ? 'the model did not return a parseable question — try again'
          : err instanceof Error
            ? err.message
            : String(err);
        const rawText = NoObjectGeneratedError.isInstance(err) ? (err.text ?? null) : null;
        try {
          db.patchGenerationJob(jobId, { status: 'error', errorMessage: message, rawText });
        } catch {
          // job row may already be in a terminal state — nothing more to do
        }
        bus.emit('generation-error', { jobId, message });
      }
    } finally {
      inFlight.delete(jobId);
    }
  }

  return {
    start(params) {
      if (disposed) throw new Error('generation engine is disposed');

      const job = db.createGenerationJob({
        category: params.category,
        difficulty: params.difficulty,
        topic: params.topic,
        brainstormSessionId: params.brainstormSessionId ?? null,
      });
      inFlight.add(job.id);
      bus.emit('generation-started', { job });
      void runJob(job);
      return { jobId: job.id };
    },

    retry(job) {
      if (disposed) throw new Error('generation engine is disposed');
      if (job.status !== 'error') {
        throw new Error(
          `generation job ${job.id} is not in an error state (status: ${job.status}) and cannot be retried`,
        );
      }

      // Clears the stale error message on the way back to 'running'; every
      // other field (result, title, slug, ...) is omitted from the patch and
      // so is preserved as-is — that preserved `result`/`slug` is exactly
      // what makes the scaffold-only resume path possible below.
      const resumed = db.patchGenerationJob(job.id, { status: 'running', errorMessage: null });
      inFlight.add(resumed.id);
      bus.emit('generation-started', { job: resumed });
      void runJob(resumed, { resumeFromResult: resumed.result != null });
      return { jobId: resumed.id };
    },

    runningCount() {
      return inFlight.size;
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
