import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Always reads as the latest value inside stable (mount-once) effects/callbacks. */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Shared shell for DisputeModal / FreshAttemptDialog / WorkspaceResetDialog
 * (NEE-293): `role="dialog"` + `aria-modal`, moves focus to the caller's
 * primary control on mount, restores focus to the invoking element on
 * unmount, traps Tab/Shift+Tab inside the dialog, and closes on Escape —
 * gated by the same `canClose` guard the caller's backdrop-mousedown already
 * uses, so dismiss behaviour is identical between the two.
 */
export function Modal({
  labelledBy,
  onClose,
  canClose,
  initialFocusRef,
  wide,
  children,
}: {
  /** id of the caller's heading element (aria-labelledby target). */
  labelledBy: string;
  onClose: () => void;
  /** Whether Escape / backdrop-mousedown may currently close the dialog. */
  canClose: boolean;
  /** Focused on mount; e.g. the argument textarea, first radio, confirm input. */
  initialFocusRef: RefObject<HTMLElement | null>;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const canCloseRef = useLatest(canClose);
  const onCloseRef = useLatest(onClose);

  // Move focus in on mount, restore it to whatever was focused before the
  // dialog opened when it unmounts (dialogs here are conditionally rendered
  // by their parent, so unmount == close).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    initialFocusRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
    // Intentionally mount-once: re-running on every render would re-steal
    // focus away from whatever the user is interacting with inside the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape-to-close (gated) and a Tab/Shift+Tab focus trap. Attached once and
  // reads canClose/onClose via refs so the guard is always current without
  // detaching/reattaching the listener on every state change.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (canCloseRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const insideDialog = active != null && dialog.contains(active);
      if (e.shiftKey) {
        if (!insideDialog || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!insideDialog || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canCloseRef, onCloseRef]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && canClose) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={dialogRef}
      >
        {children}
      </div>
    </div>
  );
}
