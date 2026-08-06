import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { GENERATABLE_CATEGORY_SLUGS } from '../lib/categories.js';
import { chatObjectStream, type LLMMessage } from '../lib/llm.js';
import { buildBrainstormPrompt } from '../lib/prompt-builder.js';
import { NULL_AI_LOG, type AiLog } from './ai-log.js';
import { createJobRegistry } from './job-engine.js';
import { hasProvider } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, BrainstormTurn } from './types.js';

// Mirrors the shape documented in STRUCTURED_OUTPUT_ADDENDUM below, and is
// duplicated (intentionally, for a keyless test that must not import server
// code) in cli/lib/llm.test.ts.
export const IdeaListSchema = z.object({
  reply: z.string(),
  ideas: z
    .array(
      z.object({
        title: z.string(),
        category: z.enum(GENERATABLE_CATEGORY_SLUGS),
        difficulty: z.enum(['easy', 'medium', 'hard']),
        pitch: z.string(),
        // Ready-to-feed description for POST /api/generation/jobs.
        topic: z.string(),
      }),
    )
    .max(5),
});

// Appended to the builder-assembled brainstorm prompt so the model returns
// the structured shape chatObject/IdeaListSchema expects, while keeping the
// persona prompt itself schema-agnostic and readable.
//
// Deliberately NOT a restated JSON envelope (braces/quoted fields/fenced
// example) on top of chatObjectStream's Output.object(IdeaListSchema): that
// gives the model two competing readings of the same `reply` output slot,
// and it resolves the conflict by over-escaping its reply one level too far
// (literal `\n`/`\"` in the persisted text). This is the exact double-
// instruction pattern NEE-411 (af23ff7, 1a6e94a) removed from
// cli/prompts/*.md — that copy just hadn't been ported off this TS const
// yet. Keep this as a plain field-bullet list; no braces, no quoted field
// names, no fenced example, no `|` union syntax, no category slug join (the
// prompt-builder digest already lists categories).
const STRUCTURED_OUTPUT_ADDENDUM = `
## Output

- \`reply\` — your conversational reply to the user, in markdown.
- \`ideas\` — the question ideas this reply actually proposes, up to 5.
  Each has:
  - \`title\` — a short, specific name for the question.
  - \`category\` — the generation category it belongs to, from the list above.
  - \`difficulty\` — per that category's difficulty calibration.
  - \`pitch\` — 1–2 sentences selling the idea.
  - \`topic\` — the self-contained generation brief described above.

A purely conversational reply returns \`ideas\` empty.
`;

/**
 * Renders a persisted turn back into the plain-text form fed to the LLM.
 * Assistant turns split their paid output across two fields — freeform
 * `content` (the `reply`) and the structured `ideas` array — but LLMMessage
 * only carries a single content string, and the model itself put those ideas
 * there in the first place (STRUCTURED_OUTPUT_ADDENDUM). Without folding
 * `ideas` back in, a follow-up turn like "make the second one harder" would
 * reach the model with no record of what idea #2 was.
 */
function serializeTurn(m: BrainstormTurn): string {
  if (m.role !== 'assistant' || !m.ideas || m.ideas.length === 0) return m.content;
  const ideasBlock = m.ideas
    .map(
      (idea, i) =>
        `${i + 1}. [${idea.category}/${idea.difficulty}] ${idea.title} — ${idea.pitch} (topic: ${idea.topic})`,
    )
    .join('\n');
  return `${m.content}\n\nIdeas proposed:\n${ideasBlock}`;
}

/** Injectable seam so unit tests never need a real API key. */
export interface BrainstormLlm {
  chatObjectStream: typeof chatObjectStream;
}

export interface BrainstormEngine {
  /** Kicks off a turn; the route must check isThinking first (409) on a given sessionId. */
  startTurn(sessionId: string | null, message: string): { sessionId: string };
  isThinking(sessionId: string): boolean;
  /** True while any brainstorm turn is in flight, across all sessions. */
  isAnyRunning(): boolean;
  dispose(): void;
}

export function createBrainstormEngine(opts: {
  db: AceDb;
  bus: Bus;
  workspaceRoot: string;
  llm?: BrainstormLlm;
  /**
   * AI activity recorder (NEE-268). Defaults to the zero-behaviour
   * NULL_AI_LOG, so every pre-existing test runs unchanged; the server
   * session passes the shared recorder.
   */
  aiLog?: AiLog;
}): BrainstormEngine {
  const { db, bus } = opts;
  const llm = opts.llm ?? { chatObjectStream };
  const aiLog = opts.aiLog ?? NULL_AI_LOG;
  const inFlight = createJobRegistry<string>({ name: 'brainstorm' });

  async function runTurn(sessionId: string, message: string): Promise<void> {
    // One activity-log run per turn (NEE-271), labeled with the user's own
    // message. Created before anything can fail, so even a missing API key
    // leaves a (zero-step) errored run behind for Activity to render.
    // Recording is best-effort throughout and never touches the session.
    const run = aiLog.startRun({
      kind: 'brainstorm',
      refId: sessionId,
      questionId: null,
      label: message,
    });
    try {
      // Rebuilt per turn: prompt files are small and reads are cheap.
      const systemPrompt = buildBrainstormPrompt() + '\n' + STRUCTURED_OUTPUT_ADDENDUM;
      if (!hasProvider()) throw new Error('no LLM API key configured — add one in Settings');

      const session = db.getBrainstormSession(sessionId);
      if (!session) throw new Error(`brainstorm session ${sessionId} not found`);

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...session.messages.map((m): LLMMessage => ({ role: m.role, content: serializeTurn(m) })),
      ];

      const abort = AbortSignal.timeout(120_000);
      // IdeaListSchema is entirely wire-safe, so the partials stream through
      // the recorder unfiltered (WIRE_SAFE_KEYS.brainstorm). The step's
      // prompt is this turn's user message; the rest of the history already
      // lives on the session itself.
      const step = run.step({
        slug: 'brainstorm',
        label: 'Brainstorming ideas',
        kind: 'llm',
        prompt: message,
      });
      let result: z.infer<typeof IdeaListSchema>;
      try {
        result = await llm.chatObjectStream('brainstorm', messages, IdeaListSchema, {
          abortSignal: abort,
          onPartial: (partial) => step.partial(partial),
        });
      } catch (err) {
        step.fail(err instanceof Error ? err.message : String(err));
        throw err;
      }
      step.done(
        `${result.ideas.length} idea${result.ideas.length === 1 ? '' : 's'} proposed`,
      );
      // A paid call that resolved after dispose() — see
      // JobRegistry.isDisposed() for the write-through rationale.
      if (inFlight.isDisposed()) return;

      const updated = db.appendBrainstormTurn(
        sessionId,
        { role: 'assistant', content: result.reply, ideas: result.ideas },
        'idle',
      );
      const turn = updated.messages[updated.messages.length - 1];
      run.done();
      bus.emit('brainstorm-done', { sessionId, turn });
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        if (inFlight.isDisposed()) return;
        // Raw paid output preserved AND user-visible, even though it didn't
        // parse as a valid idea list.
        const updated = db.appendBrainstormTurn(
          sessionId,
          { role: 'assistant', content: err.text ?? '', ideas: [] },
          'idle',
        );
        const turn = updated.messages[updated.messages.length - 1];
        // The step already failed with the parse error; the run itself
        // completed for the user (raw reply preserved), so it lands 'done'.
        run.done();
        bus.emit('brainstorm-done', { sessionId, turn });
        return;
      }
      if (inFlight.isDisposed()) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      db.setBrainstormStatus(sessionId, 'error', errorMessage);
      run.fail(errorMessage);
      bus.emit('brainstorm-error', { sessionId, message: errorMessage });
    } finally {
      inFlight.release(sessionId, sessionId);
    }
  }

  return {
    startTurn(sessionId, message) {
      inFlight.assertNotDisposed();
      if (sessionId) {
        inFlight.assertNotRunning(
          sessionId,
          'a brainstorm turn is already running for this session',
        );
      }

      // Persist the user's message (and flip to 'thinking') BEFORE anything
      // else — paid context must survive a crash even if the LLM call never
      // completes.
      const id = sessionId
        ? db.appendBrainstormTurn(sessionId, { role: 'user', content: message }, 'thinking').id
        : db.createBrainstormSession(message).id;

      inFlight.claim(id, id);
      bus.emit('brainstorm-started', { sessionId: id });
      void runTurn(id, message);
      return { sessionId: id };
    },

    isThinking(sessionId) {
      return inFlight.isRunning(sessionId);
    },

    isAnyRunning() {
      return inFlight.isAnyRunning();
    },

    dispose() {
      inFlight.dispose();
    },
  };
}
