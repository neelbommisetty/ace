import { useState } from 'react';
import { ApiError, startGenerationJob } from '../api';
import { categoryShortName } from '../lib/categories';
import type { BrainstormTurn } from '../types';

export type Idea = NonNullable<BrainstormTurn['ideas']>[number];

/**
 * One brainstormed idea from an assistant turn. "Generate this" starts a
 * generation job directly from the idea's fields (self-contained, same
 * pattern as GenerationJobStrip's own Retry button) — the caller's
 * GenerationJobStrip picks the new job up over SSE, no local wiring needed.
 */
export function IdeaCard({ idea, sessionId }: { idea: Idea; sessionId: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGenerate() {
    setSubmitting(true);
    setError(null);
    try {
      await startGenerationJob({
        category: idea.category,
        difficulty: idea.difficulty,
        topic: idea.topic,
        brainstormSessionId: sessionId,
      });
      setStarted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start generation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="idea-card">
      <div className="idea-card-title">{idea.title}</div>
      <div className="idea-card-meta">
        {categoryShortName(idea.category)} · {idea.difficulty}
      </div>
      <p className="idea-card-pitch">{idea.pitch}</p>
      {error != null && <div className="error-note">{error}</div>}
      <button
        type="button"
        className="btn btn-small"
        onClick={onGenerate}
        disabled={submitting || started}
      >
        {started ? 'Started ✓' : submitting ? 'Starting…' : 'Generate this'}
      </button>
    </div>
  );
}
