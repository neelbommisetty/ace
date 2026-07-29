/**
 * Pure clamp logic for the room's draggable pane splitters (NEE-305).
 *
 * Bounds mirror the responsive CSS in styles.css exactly (search "NEE-290"
 * there for the full reasoning) so a JS-computed width can never disagree
 * with what the browser would clip to anyway. CSS min-width/max-width on
 * `.pane-slot-problem`/`.pane-slot-ai` is still the first line of defense —
 * it wins visually even if a stale/buggy state value ever drifted from
 * this — this module is the second layer, responsible for re-clamping a
 * *stored* width on mount and on resize so a saved wide layout can never
 * reintroduce the pre-NEE-290 clipping bug, and for keeping drag/keyboard
 * resize within bounds while the user is actively dragging.
 */

export type SidePane = 'problem' | 'ai';

/** Matches `.problem-pane`/`.ai-panel`'s shared `max-width: 520px` (styles.css). */
export const PANE_MAX_WIDTH = 520;

/** "Un-dragged" width used once a handle's key/reset action needs a base
 * value to work from, before any localStorage value has ever been stored —
 * roughly the 30%/27% CSS defaults at a common ~1080px center layout. */
export const PANE_DEFAULT_WIDTH: Record<SidePane, number> = {
  problem: 320,
  ai: 300,
};

/** Matches `.console`'s `min-height: 170px` (styles.css) — the one bound
 * that's constant at every window width. */
export const CONSOLE_MIN_HEIGHT = 170;

/** Reasonable "un-dragged" console height (roughly the 30% CSS default at a
 * common ~740px room-body height). */
export const CONSOLE_DEFAULT_HEIGHT = 220;

/** Space reserved above the console (top bar, file tabs, and a workable
 * amount of code) so dragging the console/editor splitter can never
 * collapse the editor to nothing. */
const CONSOLE_RESERVED_ABOVE = 200;

/**
 * Minimum width for a side pane at a given window width — mirrors the
 * `.problem-pane`/`.ai-panel` media queries in styles.css:
 * - >900px and <=1400px: 240px (problem) / 260px (ai)
 * - <=900px: 220px (both)
 * - >1400px: 280px (problem) / 300px (ai)
 */
export function minPaneWidth(pane: SidePane, windowWidth: number): number {
  if (windowWidth <= 900) return 220;
  if (windowWidth <= 1400) return pane === 'problem' ? 240 : 260;
  return pane === 'problem' ? 280 : 300;
}

/** Clamps a candidate pane width into [minPaneWidth(...), PANE_MAX_WIDTH].
 * On a pathologically narrow window where the floor exceeds the ceiling,
 * the floor wins — better to overflow (.room-body scrolls, NEE-290) than
 * silently ignore the min bound. */
export function clampPaneWidth(pane: SidePane, width: number, windowWidth: number): number {
  const min = minPaneWidth(pane, windowWidth);
  if (min > PANE_MAX_WIDTH) return min;
  return Math.min(Math.max(width, min), PANE_MAX_WIDTH);
}

/** Maximum console height at a given window height — leaves room for the
 * rest of the chrome above it. */
export function maxConsoleHeight(windowHeight: number): number {
  return Math.max(CONSOLE_MIN_HEIGHT, windowHeight - CONSOLE_RESERVED_ABOVE);
}

/** Clamps a candidate console height into [CONSOLE_MIN_HEIGHT, maxConsoleHeight(...)]. */
export function clampConsoleHeight(height: number, windowHeight: number): number {
  const max = maxConsoleHeight(windowHeight);
  return Math.min(Math.max(height, CONSOLE_MIN_HEIGHT), max);
}
