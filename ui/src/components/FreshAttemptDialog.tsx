import { useState } from 'react';

/** Topbar '↺ New attempt' confirmation: keep current code vs reset to stub. */
export function FreshAttemptDialog({
  nextNumber,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  nextNumber: number;
  busy: boolean;
  error: string | null;
  onConfirm: (resetToStub: boolean) => void;
  onCancel: () => void;
}) {
  const [reset, setReset] = useState(false);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <h2>Start attempt #{nextNumber}?</h2>
          <button className="icon-btn" onClick={onCancel} title="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="dialog-note">
            Your current code is snapshotted; previous attempts and reviews are kept.
          </p>
          <label className="radio-option">
            <input
              type="radio"
              name="fresh-mode"
              checked={!reset}
              onChange={() => setReset(false)}
            />
            <span>
              <strong>Keep current code</strong>
              <span className="radio-hint">continue from the files as they are now</span>
            </span>
          </label>
          <label className="radio-option">
            <input type="radio" name="fresh-mode" checked={reset} onChange={() => setReset(true)} />
            <span>
              <strong>Reset files to stub</strong>
              <span className="radio-hint">start over from the original scaffold</span>
            </span>
          </label>
          {error != null && <div className="error-note">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={() => onConfirm(reset)} disabled={busy}>
            {busy ? 'Starting…' : `Start attempt #${nextNumber}`}
          </button>
        </div>
      </div>
    </div>
  );
}
