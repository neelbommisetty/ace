import { useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { applyDispute, getFile, startDispute } from '../api';
import { EDITOR_APPEARANCE, EDITOR_THEME } from '../editor-options';
import { DISPUTE_VERDICT_LABELS } from '../lib/review';
import { useSseEvent } from '../sse';
import type { DisputeRow } from '../types';

type Phase = 'input' | 'running' | 'done' | 'error';

/**
 * "Dispute a failing test" flow: argument → analyze (LLM, via SSE job) →
 * verdict + details, and when the model produced a corrected test file, a
 * read-only diff with Apply / Reject.
 */
export function DisputeModal({
  runId,
  questionId,
  testName,
  onClose,
  onApplied,
}: {
  runId: string;
  questionId: string;
  testName: string;
  onClose: () => void;
  /** dispute was applied server-side; caller closes + triggers a manual run */
  onApplied: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('input');
  const [argument, setArgument] = useState('');
  const [dispute, setDispute] = useState<DisputeRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalCode, setOriginalCode] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Match completion events by QUESTION, not jobId: the server allows one
  // dispute per question at a time, and with a fast engine (mock mode
  // especially) the SSE event can beat the 202 response that carries the
  // jobId — gating on jobId would drop it and hang the modal.
  useSseEvent('dispute-done', (p) => {
    if (p.questionId !== questionId || phase !== 'running') return;
    setDispute(p.dispute);
    setPhase('done');
    if (p.dispute.fixedTestCode != null) {
      getFile(p.dispute.testRelPath)
        .then(({ content }) => setOriginalCode(content))
        .catch(() => setOriginalCode(''));
    }
  });

  useSseEvent('dispute-error', (p) => {
    if (p.questionId !== questionId || phase !== 'running') return;
    setError(p.message);
    setPhase('error');
  });

  const analyze = async () => {
    setPhase('running');
    setError(null);
    try {
      await startDispute(runId, argument.trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the dispute');
      setPhase('error');
    }
  };

  const apply = async () => {
    if (dispute == null) return;
    setApplying(true);
    setApplyError(null);
    try {
      await applyDispute(dispute.id);
      onApplied();
    } catch (e) {
      setApplying(false);
      setApplyError(e instanceof Error ? e.message : 'Failed to apply the fix');
    }
  };

  const canApply =
    dispute != null &&
    (dispute.verdict === 'test_incorrect' || dispute.verdict === 'ambiguous') &&
    dispute.fixedTestCode != null &&
    dispute.appliedAt == null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'running' && !applying) onClose();
      }}
    >
      <div className={`modal ${dispute?.fixedTestCode != null ? 'modal-wide' : ''}`}>
        <div className="modal-header">
          <h2>Dispute failing test</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="dispute-test-line">
            <span className="case-glyph run-fail">✕</span>
            <span className="mono">{testName}</span>
          </div>

          {phase === 'input' && (
            <>
              <p className="dialog-note">
                An LLM re-reads the problem, your solution and the failing tests, then rules on
                whether the test itself is wrong. Costs one LLM call; the verdict is kept in your
                history.
              </p>
              <label className="field-label" htmlFor="dispute-argument">
                Your case (optional)
              </label>
              <textarea
                id="dispute-argument"
                className="dispute-argument"
                rows={4}
                placeholder="Why do you think the test is wrong?"
                value={argument}
                onChange={(e) => setArgument(e.target.value)}
              />
            </>
          )}

          {phase === 'running' && (
            <div className="results-running">
              <span className="pulse-dot" /> analyzing the failure…
            </div>
          )}

          {phase === 'error' && error != null && <div className="error-note">{error}</div>}

          {phase === 'done' && dispute != null && (
            <DisputeResult dispute={dispute} originalCode={originalCode} />
          )}
          {applyError != null && <div className="error-note">{applyError}</div>}
        </div>
        <div className="modal-footer">
          {phase === 'input' && (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-accent" onClick={analyze}>
                Analyze
              </button>
            </>
          )}
          {phase === 'running' && (
            <button className="btn" onClick={onClose}>
              Close (keeps analyzing)
            </button>
          )}
          {phase === 'error' && (
            <>
              <button className="btn" onClick={onClose}>
                Close
              </button>
              <button className="btn btn-accent" onClick={() => setPhase('input')}>
                Try again
              </button>
            </>
          )}
          {phase === 'done' &&
            (canApply ? (
              <>
                <button className="btn" onClick={onClose} disabled={applying}>
                  Reject
                </button>
                <button className="btn btn-accent" onClick={apply} disabled={applying}>
                  {applying ? 'Applying…' : 'Apply fixed test'}
                </button>
              </>
            ) : (
              <button className="btn" onClick={onClose}>
                Close
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

export function DisputeResult({
  dispute,
  originalCode,
}: {
  dispute: DisputeRow;
  originalCode: string | null;
}) {
  return (
    <>
      <div className={`dispute-verdict-banner dv-${dispute.verdict}`}>
        <strong>{DISPUTE_VERDICT_LABELS[dispute.verdict]}</strong> — {dispute.summary}
      </div>
      {dispute.detailsMd && (
        <div className="markdown dispute-details">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{dispute.detailsMd}</ReactMarkdown>
        </div>
      )}
      {dispute.hint != null && (
        <div className="dispute-hint">
          <strong>Hint:</strong> {dispute.hint}
        </div>
      )}
      {dispute.fixedTestCode != null && (
        <>
          <div className="field-label">
            Proposed test fix <span className="cell-dim mono">({dispute.testRelPath})</span>
            {dispute.appliedAt != null && <span className="chip chip-applied">applied</span>}
          </div>
          <div className="diff-host">
            {originalCode == null ? (
              <div className="pane-empty">Loading current test file…</div>
            ) : (
              <DiffEditor
                original={originalCode}
                modified={dispute.fixedTestCode}
                language={languageFor(dispute.testRelPath)}
                theme={EDITOR_THEME}
                height="100%"
                options={{
                  ...EDITOR_APPEARANCE,
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
                loading={<div className="pane-empty">Starting diff…</div>}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

export function languageFor(relPath: string): string {
  if (/\.(ts|tsx|mts|cts)$/.test(relPath)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(relPath)) return 'javascript';
  if (/\.md$/.test(relPath)) return 'markdown';
  return 'plaintext';
}
