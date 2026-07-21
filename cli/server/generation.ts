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
import { chatObject, type LLMMessage } from '../lib/llm.js';
import { scaffoldQuestionAt } from '../lib/scaffold.js';
import { resolveProvider } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, Difficulty, GenerationJobRow } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

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
}): GenerationEngine {
  const { db, bus, workspaceRoot } = opts;
  const llm = opts.llm ?? { chatObject };
  const inFlight = new Set<string>();
  let disposed = false;

  async function runJob(job: GenerationJobRow): Promise<void> {
    const jobId = job.id;
    try {
      const provider = resolveProvider();
      if (!provider) throw new Error('no LLM API key configured — add one in Settings');

      const category = job.category as CategorySlug;
      const difficulty = job.difficulty;
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
      const parsed = await llm.chatObject(provider, messages, GeneratedQuestionSchema, {
        abortSignal: abort,
        maxOutputTokens: 8192,
      });
      // Mirrors the disputes/reviews/brainstorm engines' convention: a paid
      // call that resolves after dispose() must not write through a db the
      // session teardown may already be closing (or have closed).
      if (disposed) return;

      const title = parsed.title || job.topic;

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

      // Slug: no collision handling yet (a later step suffixes -2..-9 on a
      // dir collision) — this step covers only the straight-through path.
      const slug = (parsed.slug && parsed.slug.trim()) || slugify(title);
      db.patchGenerationJob(jobId, { slug });

      // LLM solutionCode is always discarded (anti-cheat rule) — the
      // scaffold templates build a stub from the signature instead.
      const { dir } = scaffoldQuestionAt(
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
      );

      const question = db.upsertQuestion({
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
      // never correct on its own.
      db.setQuestionSource(question.id, 'generated');

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
