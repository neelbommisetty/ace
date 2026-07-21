import { useState } from 'react';
import { ApiError, resetWorkspace } from '../api';
import { armSuppressNextReset, disarmSuppressNextReset } from '../lib/resetSuppress';
import type { WorkspaceResetMode, WorkspaceResetResult } from '../types';

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
    sessionStorage.removeItem('ace-last-room');
    location.replace('/');
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        // Blocked while busy (mid-request) AND while done: the done state's
        // only exit is the "Go to Library" button, which runs cleanup
        // (clears `ace-last-room`, navigates away) that a stray backdrop
        // click must not be able to skip.
        if (e.target === e.currentTarget && !busy && !done) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <h2>{done ? DONE_HEADING[mode] : TITLE[mode]}</h2>
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
      </div>
    </div>
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
