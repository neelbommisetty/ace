import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isProseAnswer, lookupCategoryConfig, type CategoryConfig } from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatObjectStream, getModelId, type LLMMessage, type LLMProvider } from '../lib/llm.js';
import { readFileOr } from '../lib/read-file-or.js';
import { buildQuestionSection } from '../lib/prompt-builder.js';
import { hasMeaningfulNotes } from './reviews.js';
import { NULL_AI_LOG, type AiLog } from './ai-log.js';
import { saveBlob } from './blobs.js';
import { toWorkspaceRelPath, writeWorkspaceFile } from './files.js';
import { uuidv7 } from './ids.js';
import { createJobRegistry, toEngineErrorMessage } from './job-engine.js';
import { resolveProvider as resolveProviderFromSettings } from './settings.js';
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
 */
export function hasProbeSetForAttempt(
  db: AceDb,
  questionId: string,
  attemptId: string | null,
): boolean {
  return db.listProbeSets(questionId).some((p) => p.attemptId === attemptId);
}

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
   *  hit settings.ts's real resolveProvider() before ever reaching the
   *  injected `llm` fake. Defaults to the real settings-backed resolver. */
  resolveProvider?: () => LLMProvider | null;
  /**
   * AI activity recorder (NEE-268). Defaults to the zero-behaviour
   * NULL_AI_LOG, so every pre-existing test runs unchanged; the server
   * session passes the shared recorder.
   */
  aiLog?: AiLog;
}): ProbeEngine {
  const { db, bus, workspaceRoot } = opts;
  const llm = opts.llm ?? { chatObjectStream };
  const resolveProvider = opts.resolveProvider ?? resolveProviderFromSettings;
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
      const provider = resolveProvider();
      if (!provider) throw new Error('no LLM API key configured — add one in Settings');

      const readme = readFileOr(path.join(question.dirPath, 'README.md'));
      const primary = config.solutionFiles[0];
      const storyAbs = path.join(question.dirPath, primary);
      const story = readFileOr(storyAbs);

      // Absent .probes.md (every manual/pre-M7/starter-pack question until
      // NEE-347 ships banks) degrades to zero bank items — every probe the
      // model returns is then necessarily 'derived'.
      const bank = parseProbeBank(readFileOr(path.join(question.dirPath, '.probes.md')));
      const bankSection =
        bank.length > 0
          ? bank.map((q, i) => `${i + 1}. ${q}`).join('\n')
          : '(none — derive every probe from the story below)';

      const systemPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'features/probe.md'), 'utf8');
      const userContent = `${buildQuestionSection(readme)}

## Candidate's Story
${story}

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
      try {
        result = await llm.chatObjectStream(provider, messages, ProbeResultSchema, {
          abortSignal: abort,
          purpose: 'probe',
          onPartial: (partial) => step.partial(partial),
        });
      } catch (err) {
        step.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
      step.done(`${result.probes.length} probes`);
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
        model: getModelId(provider, 'probe'),
      });

      // Snapshot the pre-append story (trigger 'probe-append'), then the
      // additive, idempotent-across-rounds write — see appendProbesToStory.
      const hash = saveBlob(workspaceRoot, story);
      db.addSnapshot({
        questionId: question.id,
        attemptId,
        relPath: toWorkspaceRelPath(workspaceRoot, storyAbs),
        hash,
        trigger: 'probe-append',
      });
      const updated = appendProbesToStory(story, result.probes);
      writeWorkspaceFile(workspaceRoot, toWorkspaceRelPath(workspaceRoot, storyAbs), updated);

      probeSet = db.markProbeSetApplied(probeSet.id);
      aiRun.done();
      bus.emit('probes-done', { probeJobId, questionId: question.id, probeSet });
    } catch (err) {
      if (!inFlight.isDisposed()) {
        const message = toEngineErrorMessage(
          err,
          'the model did not return parseable follow-up probes — try again',
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
