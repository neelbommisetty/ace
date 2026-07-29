import { useId, useRef, useState } from 'react';
import { isProseAnswer, lookupCategoryConfig } from '@shared/categories';
import { Modal } from './Modal';

/**
 * Which noun to use for "current X" copy, and whether the Keep/Reset default
 * should differ (NEE-363). `behavioral`'s story.md is a "story"; every other
 * prose category (design-fe/be/full's notes.md) is "notes"; everything else
 * is plain "code". Coding's default stays exactly what it was before this
 * ticket — opt-in reset, Keep checked first.
 */
function answerNoun(category: string): 'story' | 'notes' | 'code' {
  if (category === 'behavioral') return 'story';
  const config = lookupCategoryConfig(category);
  if (config != null && isProseAnswer(config)) return 'notes';
  return 'code';
}

/** Topbar '↺ New attempt' confirmation: keep current code vs reset to stub. */
export function FreshAttemptDialog({
  nextNumber,
  category,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  nextNumber: number;
  /** Question category slug — resolves the copy's noun (code/story/notes) and
   * the Keep/Reset default (NEE-363). */
  category: string;
  busy: boolean;
  error: string | null;
  onConfirm: (resetToStub: boolean) => void;
  onCancel: () => void;
}) {
  const noun = answerNoun(category);
  // Prose (story/notes): default KEEP — retelling the same story or reusing
  // the same design notes across attempts is exactly the per-attempt value
  // the loop wants, and wiping hand-written text is rare enough to be
  // opt-in. Coding's default is unchanged: also Keep, exactly as before
  // this ticket (NEE-363).
  const [reset, setReset] = useState(false);
  const headingId = useId();
  const firstRadioRef = useRef<HTMLInputElement>(null);

  const resetLabel = noun === 'code' ? 'Reset files to stub' : `Reset ${noun} to stub`;
  const resetHint =
    noun === 'code'
      ? 'start over from the original scaffold'
      : `clear the ${noun} and start over from the original scaffold`;
  const keepHint =
    noun === 'code' ? 'continue from the files as they are now' : `continue from the ${noun} as it is now`;
  const isPlural = noun === 'notes';

  return (
    <Modal labelledBy={headingId} onClose={onCancel} canClose={!busy} initialFocusRef={firstRadioRef}>
      <div className="modal-header">
        <h2 id={headingId}>Start attempt #{nextNumber}?</h2>
        <button className="icon-btn" onClick={onCancel} title="Close">
          ✕
        </button>
      </div>
      <div className="modal-body">
        <p className="dialog-note">
          Your current {noun} {isPlural ? 'are' : 'is'} snapshotted; previous attempts and reviews
          are kept.
        </p>
        <label className="radio-option">
          <input
            type="radio"
            name="fresh-mode"
            checked={!reset}
            onChange={() => setReset(false)}
            ref={firstRadioRef}
          />
          <span>
            <strong>Keep current {noun}</strong>
            <span className="radio-hint">{keepHint}</span>
          </span>
        </label>
        <label className="radio-option">
          <input type="radio" name="fresh-mode" checked={reset} onChange={() => setReset(true)} />
          <span>
            <strong>{resetLabel}</strong>
            <span className="radio-hint">{resetHint}</span>
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
    </Modal>
  );
}
