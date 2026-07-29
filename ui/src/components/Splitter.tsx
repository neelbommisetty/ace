import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export type SplitterOrientation = 'vertical' | 'horizontal';

const KEYBOARD_STEP = 16;

/**
 * Draggable, keyboard-accessible pane splitter (NEE-305). Reports resize
 * deltas rather than owning any state itself — the caller (Room.tsx, via
 * usePaneLayout) decides what a positive delta means for the pane it
 * controls (e.g. the AI panel sits on the right, so dragging its left-edge
 * handle rightward *shrinks* it — the caller negates the delta it gets).
 *
 * - `orientation="vertical"` — a left/right boundary; dragged with pointer
 *   X movement, resized with ArrowLeft/ArrowRight.
 * - `orientation="horizontal"` — a top/bottom boundary; dragged with
 *   pointer Y movement, resized with ArrowUp/ArrowDown.
 *
 * role="separator" + aria-orientation per NEE-305's acceptance criteria;
 * Home resets (mirrors the double-click reset).
 */
export function Splitter({
  orientation,
  label,
  valueNow,
  valueMin,
  valueMax,
  onResize,
  onReset,
}: {
  orientation: SplitterOrientation;
  /** aria-label — what this splitter resizes, e.g. "Resize problem pane". */
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  /** Raw pixel delta: positive = pointer moved right (vertical) or down (horizontal). */
  onResize: (deltaPx: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ pointerId: number; last: number } | null>(null);
  const vertical = orientation === 'vertical';

  const posOf = (e: PointerEvent<HTMLDivElement>) => (vertical ? e.clientX : e.clientY);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, last: posOf(e) };
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state == null || e.pointerId !== state.pointerId) return;
    const pos = posOf(e);
    const delta = pos - state.last;
    if (delta !== 0) {
      onResize(delta);
      state.last = pos;
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = vertical ? 'ArrowLeft' : 'ArrowUp';
    const increaseKey = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key === decreaseKey) {
      e.preventDefault();
      onResize(-KEYBOARD_STEP);
    } else if (e.key === increaseKey) {
      e.preventDefault();
      onResize(KEYBOARD_STEP);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
