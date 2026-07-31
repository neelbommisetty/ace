import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { regenerateQuestion } from '../api';
import { Modal } from './Modal';
import type { QuestionRow } from '../types';

type Phase = 'input' | 'starting' | 'started';

const FEEDBACK_MAX = 4000;

/**
 * "Regenerate with feedback" flow (NEE-386): free-text feedback → a new
 * generation job is started server-side, carrying the source question's
 * prior result + this feedback into the stage-1 prompt. Generation takes
 * minutes, so unlike DisputeModal this never waits in-place for a result —
 * a 202 flips straight to a confirmation state, and the existing
 * GenerationJobStrip + global Toast announce completion exactly like any
 * other generation job (no SSE subscription here).
 */
export function RegenerateModal({
  question,
  onClose,
}: {
  question: QuestionRow;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('input');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  const trimmedFeedback = feedback.trim();
  const canSubmit =
    phase !== 'starting' && trimmedFeedback.length > 0 && trimmedFeedback.length <= FEEDBACK_MAX;

  const submit = async () => {
    if (!canSubmit) return;
    setPhase('starting');
    setError(null);
    try {
      await regenerateQuestion(question.category, question.slug, trimmedFeedback);
      setPhase('started');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start regeneration');
      setPhase('input');
    }
  };

  return (
    // The job itself runs server-side once started, so closing the modal at
    // any phase (including mid-request) never loses anything — canClose is
    // always true, unlike DisputeModal's in-flight guard.
    <Modal labelledBy={headingId} onClose={onClose} canClose initialFocusRef={feedbackRef}>
      <div className="modal-header">
        <h2 id={headingId}>Regenerate with feedback</h2>
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="modal-body">
        {phase === 'started' ? (
          <p className="dialog-note">
            Generating a replacement with your feedback — this question will be archived when
            it's ready.
          </p>
        ) : (
          <>
            <p className="dialog-note">
              Describe what's wrong — a replacement question is generated with the original topic
              plus your feedback; this question is archived when the replacement is ready. Costs
              LLM calls.
            </p>
            <label className="field-label" htmlFor="regenerate-feedback">
              Feedback
            </label>
            <textarea
              id="regenerate-feedback"
              className="dispute-argument"
              rows={4}
              placeholder="Too easy — needs an O(n) constraint. Drop the redux part."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              ref={feedbackRef}
            />
          </>
        )}
        {error != null && <div className="error-note">{error}</div>}
      </div>
      <div className="modal-footer">
        {phase === 'started' ? (
          <>
            <Link className="btn" to="/library">
              Go to Library
            </Link>
            <button className="btn btn-accent" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-accent" onClick={submit} disabled={!canSubmit}>
              {phase === 'starting' ? 'Regenerating…' : 'Regenerate'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
