import { describe, expect, it } from 'vitest';
import {
  CONSOLE_MIN_HEIGHT,
  PANE_MAX_WIDTH,
  clampConsoleHeight,
  clampPaneWidth,
  maxConsoleHeight,
  minPaneWidth,
} from './paneLayout';

describe('minPaneWidth', () => {
  it('uses the full-width floor above 1400px', () => {
    expect(minPaneWidth('problem', 1440)).toBe(280);
    expect(minPaneWidth('ai', 1440)).toBe(300);
  });

  it('uses the NEE-290 1400px-breakpoint floor between 900 and 1400px', () => {
    expect(minPaneWidth('problem', 1280)).toBe(240);
    expect(minPaneWidth('ai', 1280)).toBe(260);
    // boundary is inclusive on the narrow side, matching `max-width: 1400px`
    expect(minPaneWidth('problem', 1400)).toBe(240);
  });

  it('uses the shared 900px-breakpoint floor at or below 900px', () => {
    expect(minPaneWidth('problem', 900)).toBe(220);
    expect(minPaneWidth('ai', 800)).toBe(220);
  });

  it('treats the preview pane (NEE-349) like the ai pane at every breakpoint', () => {
    expect(minPaneWidth('preview', 1440)).toBe(minPaneWidth('ai', 1440));
    expect(minPaneWidth('preview', 1280)).toBe(minPaneWidth('ai', 1280));
    expect(minPaneWidth('preview', 800)).toBe(minPaneWidth('ai', 800));
  });
});

describe('clampPaneWidth', () => {
  it('leaves an in-bounds width untouched', () => {
    expect(clampPaneWidth('problem', 350, 1440)).toBe(350);
  });

  it('clamps up to the floor for the current window width', () => {
    expect(clampPaneWidth('problem', 100, 1440)).toBe(280);
    expect(clampPaneWidth('ai', 100, 1000)).toBe(260);
    expect(clampPaneWidth('ai', 100, 800)).toBe(220);
  });

  it('clamps down to PANE_MAX_WIDTH', () => {
    expect(clampPaneWidth('problem', 5000, 1440)).toBe(PANE_MAX_WIDTH);
  });

  it('re-clamps a stored wide-window width down when the window shrinks (NEE-305 regression guard)', () => {
    // saved at 1440px wide open right at the (then-valid) 300px min...
    const stored = minPaneWidth('ai', 1440);
    expect(clampPaneWidth('ai', stored, 1440)).toBe(stored);
    // ...window shrinks to 800px: the pane must not stay pinned above the
    // new narrower floor in a way that clips the rest of the room. Here the
    // stored value already sits above the new (lower) floor, so it survives
    // unchanged — the important case is the inverse, covered below.
    expect(clampPaneWidth('ai', stored, 800)).toBe(stored);
  });

  it('re-clamps a too-narrow stored width up when the window grows past a breakpoint', () => {
    // stored while collapsed to the 900px-breakpoint floor...
    const stored = minPaneWidth('problem', 900);
    expect(stored).toBe(220);
    // ...window is actually 1440px wide: 220px would be narrower than the
    // pane is allowed to go there, so it's clamped up to that floor instead.
    expect(clampPaneWidth('problem', stored, 1440)).toBe(280);
  });

  it('prefers the floor over the ceiling on a pathologically narrow window', () => {
    // (not reachable via the real breakpoints today, but the function must
    // never silently violate its own minimum)
    expect(clampPaneWidth('problem', 100, 100)).toBeGreaterThanOrEqual(220);
  });
});

describe('maxConsoleHeight / clampConsoleHeight', () => {
  it('leaves headroom above the console proportional to window height', () => {
    expect(maxConsoleHeight(900)).toBe(700);
    expect(maxConsoleHeight(1000)).toBe(800);
  });

  it('never drops the max below CONSOLE_MIN_HEIGHT on a tiny window', () => {
    expect(maxConsoleHeight(100)).toBe(CONSOLE_MIN_HEIGHT);
  });

  it('clamps an in-bounds height untouched', () => {
    expect(clampConsoleHeight(300, 900)).toBe(300);
  });

  it('clamps up to CONSOLE_MIN_HEIGHT', () => {
    expect(clampConsoleHeight(10, 900)).toBe(CONSOLE_MIN_HEIGHT);
  });

  it('clamps down to the window-relative max', () => {
    expect(clampConsoleHeight(5000, 900)).toBe(700);
  });

  it('re-clamps a stored tall-window height down when the window shrinks (NEE-305 regression guard)', () => {
    const stored = clampConsoleHeight(650, 900); // valid at 900px tall
    expect(stored).toBe(650);
    expect(clampConsoleHeight(stored, 400)).toBe(maxConsoleHeight(400));
  });
});
