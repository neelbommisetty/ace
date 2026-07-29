import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  CONSOLE_DEFAULT_HEIGHT,
  CONSOLE_MIN_HEIGHT,
  PANE_DEFAULT_WIDTH,
  PANE_MAX_WIDTH,
  clampConsoleHeight,
  clampPaneWidth,
  maxConsoleHeight,
  minPaneWidth,
} from '../lib/paneLayout';
import { useLocalStorageNumber } from './useLocalStorageState';

export interface PaneLayout {
  /** null = no stored override; render with the CSS default (~30%/~27%/~30%). */
  problemWidth: number | null;
  aiWidth: number | null;
  /** NEE-349: the live preview pane, sized independently of the AI panel. */
  previewWidth: number | null;
  consoleHeight: number | null;
  /** Current bounds for the splitters' aria-valuemin/max, re-derived on resize. */
  problemMin: number;
  aiMin: number;
  previewMin: number;
  paneMax: number;
  consoleMin: number;
  consoleMax: number;
  /**
   * Attach these to the rendered pane-slot elements. Before any drag has
   * ever written a stored value, resize* measures the pane's *actual*
   * on-screen size (CSS-driven) via these refs instead of falling back to a
   * fixed default that can diverge arbitrarily from what's rendered.
   */
  problemRef: RefObject<HTMLDivElement | null>;
  aiRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLDivElement | null>;
  consoleRef: RefObject<HTMLDivElement | null>;
  /** Applies a raw pixel delta (positive = right/down) to the stored width/height, clamped to current bounds. */
  resizeProblem: (deltaPx: number) => void;
  resizeAi: (deltaPx: number) => void;
  resizePreview: (deltaPx: number) => void;
  resizeConsole: (deltaPx: number) => void;
  resetProblem: () => void;
  resetAi: () => void;
  resetPreview: () => void;
  resetConsole: () => void;
}

/**
 * Owns the room's three draggable-splitter dimensions (NEE-305): problem
 * pane width, AI panel width, console height. Each persists to localStorage
 * (see the registry in useLocalStorageState.ts) as `number | null`, where
 * null means "un-dragged — use the CSS default", so double-click-to-reset
 * is just `setValue(null)`.
 *
 * Re-clamps every stored dimension on mount AND on window resize against
 * the *current* window size (mirroring the NEE-290 breakpoints in
 * styles.css) — a width saved on a wide window is re-clamped down the
 * moment the window shrinks below what that width now allows, and back up
 * if it's sitting below the current floor, so a saved layout can never
 * reintroduce the pre-NEE-290 clipping bug.
 */
export function usePaneLayout(): PaneLayout {
  const [problemWidth, setProblemWidth] = useLocalStorageNumber('ace-problem-width');
  const [aiWidth, setAiWidth] = useLocalStorageNumber('ace-ai-width');
  const [previewWidth, setPreviewWidth] = useLocalStorageNumber('ace-preview-width');
  const [consoleHeight, setConsoleHeight] = useLocalStorageNumber('ace-console-height');
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const problemRef = useRef<HTMLDivElement | null>(null);
  const aiRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const reclamp = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      setViewport({ width, height });
      setProblemWidth((w) => (w == null ? w : clampPaneWidth('problem', w, width)));
      setAiWidth((w) => (w == null ? w : clampPaneWidth('ai', w, width)));
      setPreviewWidth((w) => (w == null ? w : clampPaneWidth('preview', w, width)));
      setConsoleHeight((h) => (h == null ? h : clampConsoleHeight(h, height)));
    };
    reclamp(); // mount: re-clamp against whatever was already stored
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [setProblemWidth, setAiWidth, setPreviewWidth, setConsoleHeight]);

  const resizeProblem = (deltaPx: number) =>
    setProblemWidth((w) =>
      clampPaneWidth(
        'problem',
        (w ?? problemRef.current?.getBoundingClientRect().width ?? PANE_DEFAULT_WIDTH.problem) + deltaPx,
        window.innerWidth,
      ),
    );
  const resizeAi = (deltaPx: number) =>
    setAiWidth((w) =>
      clampPaneWidth(
        'ai',
        (w ?? aiRef.current?.getBoundingClientRect().width ?? PANE_DEFAULT_WIDTH.ai) + deltaPx,
        window.innerWidth,
      ),
    );
  // NEE-349/NEE-305: same measured-size fallback as resizeProblem/resizeAi —
  // never a hardcoded first-drag width, always the pane's actual on-screen
  // size the first time it's dragged.
  const resizePreview = (deltaPx: number) =>
    setPreviewWidth((w) =>
      clampPaneWidth(
        'preview',
        (w ?? previewRef.current?.getBoundingClientRect().width ?? PANE_DEFAULT_WIDTH.preview) + deltaPx,
        window.innerWidth,
      ),
    );
  const resizeConsole = (deltaPx: number) =>
    setConsoleHeight((h) =>
      clampConsoleHeight(
        (h ?? consoleRef.current?.getBoundingClientRect().height ?? CONSOLE_DEFAULT_HEIGHT) + deltaPx,
        window.innerHeight,
      ),
    );

  return {
    problemWidth,
    aiWidth,
    previewWidth,
    consoleHeight,
    problemMin: minPaneWidth('problem', viewport.width),
    aiMin: minPaneWidth('ai', viewport.width),
    previewMin: minPaneWidth('preview', viewport.width),
    paneMax: PANE_MAX_WIDTH,
    consoleMin: CONSOLE_MIN_HEIGHT,
    consoleMax: maxConsoleHeight(viewport.height),
    problemRef,
    aiRef,
    previewRef,
    consoleRef,
    resizeProblem,
    resizeAi,
    resizePreview,
    resizeConsole,
    resetProblem: () => setProblemWidth(null),
    resetAi: () => setAiWidth(null),
    resetPreview: () => setPreviewWidth(null),
    resetConsole: () => setConsoleHeight(null),
  };
}
