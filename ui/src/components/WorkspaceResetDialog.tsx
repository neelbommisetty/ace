import { useId, useRef, useState } from 'react';
import { ApiError, getResetPreview, resetWorkspace } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { armSuppressNextReset, disarmSuppressNextReset } from '../lib/resetSuppress';
import { Modal } from './Modal';
import type { AtRiskProseFile, WorkspaceResetMode, WorkspaceResetResult } from '../types';

const CONSEQUENCES: Record<WorkspaceResetMode, string[]> = {
  progress: [
    'All attempts, test runs, reviews, and disputes are archived — nothing is deleted.',
    'Solution and test files on disk are left exactly as they are now.',
    'The Library returns to a fresh, unattempted state for every question.',
  ],
  full: [
    'All attempts, test runs, reviews, and disputes are archived — nothing is deleted.',
    'Solution files are reset to their original scaffold on disk.',
    'Applied dispute fixes to test files are kept as the new baseline.',
    'The Library returns to a fresh, unattempted state for every question.',
  ],
};

const TITLE: Record<WorkspaceResetMode, string> = {
  progress: 'Clear progress?',
  full: 'Reset workspace?',
};

const DONE_HEADING: Record<WorkspaceResetMode, string> = {
  progress: 'Progress cleared',
  full: 'Workspace reset',
};

type DialogState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string } | { kind: 'done'; result: WorkspaceResetResult };

/**
 * "2 stories and 1 design answer" — concrete counts by prose kind (NEE-363),
 * so the confirmation names what's actually at risk instead of the old vague
 * "solution files are reset to scaffold" line. `behavioral` solution files
 * are "stories"; every other prose category (design-fe/be/full) is a
 * "design answer" — the same nouns the Library and AiPanel already use.
 */
function summarizeAtRisk(entries: AtRiskProseFile[]): string {
  const stories = entries.filter((e) => e.category === 'behavioral').length;
  const designs = entries.length - stories;
  const parts: string[] = [];
  if (stories > 0) parts.push(`${stories} ${stories === 1 ? 'story' : 'stories'}`);
  if (designs > 0) parts.push(`${designs} design ${designs === 1 ? 'answer' : 'answers'}`);
  return parts.join(' and ');
}

/**
 * Settings danger-zone modal: typed-confirmation gate for the destructive
 * workspace reset endpoint. Follows FreshAttemptDialog's overlay/header/
 * body/footer conventions.
 */
export function WorkspaceResetDialog({
  mode,
  folderName,
  onClose,
}: {
  mode: WorkspaceResetMode;
  folderName: string;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [state, setState] = useState<DialogState>({ kind: 'idle' });
  // null while loading (or in 'progress' mode, which never touches solution
  // files on disk and so never needs this). A fetch failure degrades to `[]`
  // — best-effort: the generic CONSEQUENCES wording still applies below, and
  // the typed-confirmation gate is the real safety net either way.
  const [atRiskProse, setAtRiskProse] = useState<AtRiskProseFile[] | null>(null);
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useCancellableEffect(
    (cancelled) => {
      if (mode !== 'full') return;
      getResetPreview()
        .then((preview) => {
          if (!cancelled()) setAtRiskProse(preview.atRiskProse);
        })
        .catch(() => {
          if (!cancelled()) setAtRiskProse([]);
        });
    },
    [mode],
  );

  const busy = state.kind === 'busy';
  const done = state.kind === 'done';
  const canConfirm = !busy && !done && input === folderName;

  const confirm = () => {
    if (!canConfirm) return;
    setState({ kind: 'busy' });
    // Generated and armed before the request goes out: the server may
    // broadcast the SSE `workspace-reset` event before (or racing) our own
    // response arrives, and this tab should show the "done" state rather
    // than being reloaded out from under itself by App's SSE handler. The
    // id lets App's handler tell OUR broadcast apart from one a different
    // tab's reset produces (e.g. if this request is about to fail with 409
    // because another tab's reset is already in flight) — see
    // lib/resetSuppress.ts.
    const requestId = crypto.randomUUID();
    armSuppressNextReset(requestId);
    resetWorkspace(mode, input, requestId)
      .then((result) => {
        setState({ kind: 'done', result });
      })
      .catch((e: unknown) => {
        // No reset actually happened — don't leave a stray suppression
        // armed for some unrelated future reset broadcast.
        disarmSuppressNextReset(requestId);
        setInput('');
        setState({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'Failed to reset the workspace',
        });
      });
  };

  const goToLibrary = () => {
    location.replace('/');
  };

  return (
    // Blocked while busy (mid-request) AND while done: the done state's only
    // exit is the "Go to Library" button, which navigates away — a stray
    // backdrop click / Escape must not be able to skip that.
    <Modal
      labelledBy={headingId}
      onClose={onClose}
      canClose={!busy && !done}
      initialFocusRef={inputRef}
    >
      <div className="modal-header">
        <h2 id={headingId}>{done ? DONE_HEADING[mode] : TITLE[mode]}</h2>
        {!done && (
          <button className="icon-btn" onClick={onClose} title="Close" disabled={busy}>
            ✕
          </button>
        )}
      </div>
      <div className="modal-body">
        {done ? (
          <DoneBody mode={mode} result={state.result} />
        ) : (
          <>
            <ul className="reset-consequences">
              {CONSEQUENCES[mode].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {atRiskProse != null && atRiskProse.length > 0 && (
              <div className="reset-at-risk">
                <p className="dialog-note">
                  <strong>{summarizeAtRisk(atRiskProse)}</strong> will be reset to their original
                  scaffold — the hand-written text below is what's actually lost from disk (it
                  stays viewable, read-only, under the question's Activity tab, but there is no
                  one-click undo):
                </p>
                <ul className="reset-at-risk-list">
                  {atRiskProse.map((f) => (
                    <li key={`${f.category}/${f.slug}`}>{f.title}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="dialog-note">
              Type the workspace folder name <strong>{folderName}</strong> to confirm.
            </p>
            <input
              className="key-input mono"
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={folderName}
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
              }}
              ref={inputRef}
            />
            {state.kind === 'error' && <div className="error-note">{state.message}</div>}
          </>
        )}
      </div>
      <div className="modal-footer">
        {done ? (
          <button className="btn btn-accent" onClick={goToLibrary}>
            Go to Library
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={confirm} disabled={!canConfirm}>
              {busy ? 'Archiving…' : mode === 'full' ? 'Reset workspace' : 'Clear progress'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function DoneBody({ mode, result }: { mode: WorkspaceResetMode; result: WorkspaceResetResult }) {
  return (
    <div className="import-result">
      <p>Your previous workspace was archived to:</p>
      <p className="mono cell-dim">{result.archivedTo}</p>
      {mode === 'full' && (
        <p>
          {result.restored.questions}{' '}
          {result.restored.questions === 1 ? 'question was' : 'questions were'} reset to their
          original scaffold.
        </p>
      )}
    </div>
  );
}
