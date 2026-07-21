import fs from 'node:fs';
import path from 'node:path';
import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { CATEGORY_SLUGS } from '../lib/categories.js';
import { getImportMetaDirname } from '../lib/import-meta.js';
import { chatObject, type LLMMessage } from '../lib/llm.js';
import { resolveProvider } from './settings.js';
import type { Bus } from './sse.js';
import type { AceDb, BrainstormTurn } from './types.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

// Mirrors the shape documented in STRUCTURED_OUTPUT_ADDENDUM below, and is
// duplicated (intentionally, for a keyless test that must not import server
// code) in cli/lib/llm.test.ts.
export const IdeaListSchema = z.object({
  reply: z.string(),
  ideas: z
    .array(
      z.object({
        title: z.string(),
        category: z.enum(CATEGORY_SLUGS),
        difficulty: z.enum(['easy', 'medium', 'hard']),
        pitch: z.string(),
        // Ready-to-feed description for POST /api/generation/jobs.
        topic: z.string(),
      }),
    )
    .max(5),
});

// Appended to cli/prompts/question-brainstorm.md's freeform persona prompt so
// the model returns the structured shape chatObject/IdeaListSchema expects,
// while keeping the persona prompt itself schema-agnostic and readable.
const STRUCTURED_OUTPUT_ADDENDUM = `
## Output Format

Respond with a JSON object shaped like this:

{
  "reply": string,   // your conversational reply to the user (markdown ok)
  "ideas": [          // 0-5 concrete question ideas surfaced by this reply
    {
      "title": string,
      "category": ${CATEGORY_SLUGS.join(' | ')},
      "difficulty": "easy" | "medium" | "hard",
      "pitch": string,  // 1-2 sentences selling the idea
      "topic": string   // a ready-to-feed description for question generation
    }
  ]
}

Only include ideas when you are actually proposing concrete question
directions — a purely conversational reply (e.g. a clarifying question) should
return an empty "ideas" array.
`;

/** Injectable seam so unit tests never need a real API key. */
export interface BrainstormLlm {
  chatObject: typeof chatObject;
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
}): BrainstormEngine {
  const { db, bus } = opts;
  const llm = opts.llm ?? { chatObject };
  const inFlight = new Set<string>();
  let disposed = false;

  const systemPrompt =
    fs.readFileSync(path.join(PROMPTS_DIR, 'question-brainstorm.md'), 'utf8') +
    '\n' +
    STRUCTURED_OUTPUT_ADDENDUM;

  async function runTurn(sessionId: string): Promise<void> {
    try {
      const provider = resolveProvider();
      if (!provider) throw new Error('no LLM API key configured — add one in Settings');

      const session = db.getBrainstormSession(sessionId);
      if (!session) throw new Error(`brainstorm session ${sessionId} not found`);

      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...session.messages.map((m): LLMMessage => ({ role: m.role, content: m.content })),
      ];

      const abort = AbortSignal.timeout(120_000);
      const result = await llm.chatObject(provider, messages, IdeaListSchema, {
        abortSignal: abort,
      });

      const updated = db.appendBrainstormTurn(
        sessionId,
        { role: 'assistant', content: result.reply, ideas: result.ideas },
        'idle',
      );
      const turn = updated.messages[updated.messages.length - 1];
      if (!disposed) bus.emit('brainstorm-done', { sessionId, turn });
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        // Raw paid output preserved AND user-visible, even though it didn't
        // parse as a valid idea list.
        const updated = db.appendBrainstormTurn(
          sessionId,
          { role: 'assistant', content: err.text ?? '', ideas: [] },
          'idle',
        );
        const turn = updated.messages[updated.messages.length - 1];
        if (!disposed) bus.emit('brainstorm-done', { sessionId, turn });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      db.setBrainstormStatus(sessionId, 'error', message);
      if (!disposed) bus.emit('brainstorm-error', { sessionId, message });
    } finally {
      inFlight.delete(sessionId);
    }
  }

  return {
    startTurn(sessionId, message) {
      if (disposed) throw new Error('brainstorm engine is disposed');
      if (sessionId && inFlight.has(sessionId)) {
        // Routes check isThinking first; this is a programming-error backstop.
        throw new Error('a brainstorm turn is already running for this session');
      }

      // Persist the user's message (and flip to 'thinking') BEFORE anything
      // else — paid context must survive a crash even if the LLM call never
      // completes.
      const id = sessionId
        ? db.appendBrainstormTurn(sessionId, { role: 'user', content: message }, 'thinking').id
        : db.createBrainstormSession(message).id;

      inFlight.add(id);
      bus.emit('brainstorm-started', { sessionId: id });
      void runTurn(id);
      return { sessionId: id };
    },

    isThinking(sessionId) {
      return inFlight.has(sessionId);
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
