import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, createOrResumeAttempt, getQuestionDetail, getQuestions, startFreshAttempt } from '../api';
import { AiPanel } from '../components/AiPanel';
import { DisputeModal } from '../components/DisputeModal';
import { EditorPane } from '../components/EditorPane';
import { FreshAttemptDialog } from '../components/FreshAttemptDialog';
import { Modal } from '../components/Modal';
import { ProblemPane } from '../components/ProblemPane';
import { Splitter } from '../components/Splitter';
import { TestConsole } from '../components/TestConsole';
import { TopBar } from '../components/TopBar';
import { useActiveTimer } from '../hooks/useActiveTimer';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { useFileBuffers } from '../hooks/useFileBuffers';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { usePaneLayout } from '../hooks/usePaneLayout';
import { useReviewPanel } from '../hooks/useReviewPanel';
import { useTestRuns } from '../hooks/useTestRuns';
import {
  fallbackOrderParams,
  hasLibraryOrderContext,
  libraryOrderQueryString,
  nextInOrder,
  nextUnsolvedInOrder,
  orderedQuestions,
  parseLibraryOrderParams,
  prevInOrder,
} from '../lib/libraryOrder';
import { CONSOLE_DEFAULT_HEIGHT, PANE_DEFAULT_WIDTH } from '../lib/paneLayout';
import { useSseConnected, useSseEvent } from '../sse';
import type { AttemptRow, QuestionDetail, QuestionWithStats, TestRunTrigger } from '../types';
import { NotFound } from './NotFound';

/**
 * Library-order navigation context (NEE-310): the full questions list plus
 * the query string to carry onward, resolved once by the outer `Room` and
 * threaded down to `RoomInner` so prev/next/"Next question" can recompute
 * the Library's exact ordering without a round trip back to it.
 */
interface RoomNav {
  ordered: QuestionWithStats[];
  /** Query string (no leading '?') to append to every onward room link, so the context survives a whole chain of questions. */
  linkQuery: string;
}

function roomHref(q: QuestionWithStats, linkQuery: string): string {
  return `/q/${q.category}/${q.slug}${linkQuery ? `?${linkQuery}` : ''}`;
}

// Layout-only default check (NEE-290): "is the window at least this wide,
// right now". Never wired to a resize listener — it seeds a useState
// initializer once on mount, so it can only ever set a *default*, not
// fight a later explicit toggle. matchMedia is present in every real
// browser and in the happy-dom test environment.
function matchesMinWidth(px: number): boolean {
  return window.matchMedia(`(min-width: ${px}px)`).matches;
}

/** True when the keystroke's focus is somewhere typing belongs (inputs, textareas — Monaco's hidden textarea included — or contenteditable). */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  );
}

export function Room() {
  const { category = '', slug = '' } = useParams();
  const [searchParams] = useSearchParams();
  const [loaded, setLoaded] = useState<{
    detail: QuestionDetail;
    // null when the question is solved and opened as a readonly reference —
    // there's no active attempt to resume.
    attempt: AttemptRow | null;
    // the ended attempt to base "Start new attempt" off of; only set alongside attempt=null.
    latestAttempt: AttemptRow | null;
  } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bumped after a fresh attempt: refetches detail + attempt, remounts RoomInner
  const [reloadKey, setReloadKey] = useState(0);

  useCancellableEffect(
    (cancelled) => {
      setLoaded(null);
      setNotFound(false);
      setError(null);
      (async () => {
        try {
          const detail = await getQuestionDetail(category, slug);
          const res = await createOrResumeAttempt(category, slug);
          if (cancelled()) return;
          if (res.readonly) {
            setLoaded({ detail, attempt: null, latestAttempt: res.latestAttempt ?? null });
          } else if (res.attempt) {
            setLoaded({ detail, attempt: res.attempt, latestAttempt: null });
          } else {
            throw new Error('Server did not return an attempt to resume');
          }
        } catch (e) {
          if (cancelled()) return;
          if (e instanceof ApiError && e.status === 404) setNotFound(true);
          else if (!(e instanceof ApiError && e.status === 401)) {
            setError(e instanceof Error ? e.message : 'Failed to open the question');
          }
        }
      })();
    },
    [category, slug, reloadKey],
  );

  // Full questions list for prev/next + "Next question" (NEE-310). Best
  // effort: a failure here just leaves nav empty — the room itself still
  // works, it only loses the walk-the-library affordances.
  const [questions, setQuestions] = useState<QuestionWithStats[] | null>(null);
  useCancellableEffect(
    (cancelled) => {
      getQuestions()
        .then((qs) => {
          if (!cancelled()) setQuestions(qs);
        })
        .catch(() => {
          if (!cancelled()) setQuestions(null);
        });
    },
    [category, slug, reloadKey],
  );

  // The Library's ordering, recomputed here from the full list + whatever
  // context params this room was opened with — falling back to a
  // same-category default order for a bare deep link (NEE-310).
  const nav: RoomNav = useMemo(() => {
    const params = hasLibraryOrderContext(searchParams)
      ? parseLibraryOrderParams(searchParams)
      : fallbackOrderParams(category);
    return {
      ordered: questions != null ? orderedQuestions(questions, params) : [],
      linkQuery: libraryOrderQueryString(searchParams),
    };
  }, [questions, searchParams, category]);

  // The server closes a prose attempt itself when its review completes
  // (NEE-356) — design/behavioral questions have no test run, so nothing
  // here can notice that moment. Reload rather than flipping local state:
  // the room's mode then comes from the same server derivation a normal
  // open uses (readonly reference when the verdict solved it, a fresh
  // attempt when it didn't), instead of a second copy of the solved rule
  // living in the SPA.
  useSseEvent('attempt-ended', ({ attemptId }) => {
    if (loaded?.attempt?.id === attemptId) setReloadKey((k) => k + 1);
  });

  if (notFound) {
    return <NotFound message={`No question at ${category}/${slug}.`} />;
  }
  if (error != null) {
    return (
      <div className="notfound">
        <p className="notfound-message error-note">
          {error}{' '}
          <button className="btn btn-small" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </p>
        <p>
          <Link to="/">← Back to the Library</Link>
        </p>
      </div>
    );
  }
  if (loaded == null) {
    return <div className="room-loading">Opening room…</div>;
  }
  return (
    <RoomInner
      key={`${loaded.detail.question.id}:${loaded.attempt?.id ?? 'readonly'}`}
      detail={loaded.detail}
      attempt={loaded.attempt}
      latestAttempt={loaded.latestAttempt}
      nav={nav}
      onReload={() => setReloadKey((k) => k + 1)}
    />
  );
}

function RoomInner({
  detail,
  attempt,
  latestAttempt,
  nav,
  onReload,
}: {
  detail: QuestionDetail;
  attempt: AttemptRow | null;
  latestAttempt: AttemptRow | null;
  nav: RoomNav;
  onReload: () => void;
}) {
  const question = detail.question;
  const connected = useSseConnected();

  // Solved question opened as a read-only reference: no active attempt.
  const readonly = attempt == null;
  // "the active attempt" from the room's point of view: the live attempt
  // when editable, or the ended reference attempt in a readonly room. Used
  // both to mint "Start new attempt"/"New attempt" below and (NEE-345
  // follow-up) to scope which attempt's probe sets useReviewPanel fetches.
  const refAttempt = attempt ?? latestAttempt;

  // Prev/next + "Next question" (NEE-310) — walk the Library's ordering
  // (recomputed by the outer Room from the full list + this room's context
  // params) so moving between questions needs no Library round trip.
  const prevQuestion = useMemo(() => prevInOrder(nav.ordered, question.id), [nav.ordered, question.id]);
  const nextQuestion = useMemo(() => nextInOrder(nav.ordered, question.id), [nav.ordered, question.id]);
  const nextUnsolvedQuestion = useMemo(
    () => nextUnsolvedInOrder(nav.ordered, question.id),
    [nav.ordered, question.id],
  );

  const [autorun, setAutorun] = useLocalStorageState('ace-autorun', false);
  // NEE-331: format dirty editable buffers before Run — opt-in, next to autorun.
  const [formatBeforeRun, setFormatBeforeRun] = useLocalStorageState(
    'ace-format-before-run',
    false,
  );

  // startRun is minted by useTestRuns below, which itself needs flushSaves
  // from useFileBuffers — break the render-order cycle with a ref.
  const startRunRef = useRef<(trigger: TestRunTrigger) => void>(() => {});

  const buffers = useFileBuffers({ detail, readonly, attempt, autorun, startRunRef });
  const { editorFiles, hasTests, flushSaves, loadFileInto } = buffers;

  const runs = useTestRuns({
    questionId: question.id,
    attempt,
    hasTests,
    initialLastRun: detail.lastRun,
    flushSaves,
    files: buffers.files,
    formatBeforeRun,
  });
  startRunRef.current = runs.startRun;

  const review = useReviewPanel({
    question,
    attemptId: refAttempt?.id ?? null,
    flushSaves,
    editorFiles,
    loadFileInto,
    startRunRef,
  });

  // ---- fresh attempt ------------------------------------------------------
  // "Start new attempt" (readonly banner) or "↺ New attempt" (active TopBar)
  // mints attempt N+1 off of: the live attempt when editable, or the ended
  // latestAttempt when this is a readonly reference.
  const [freshOpen, setFreshOpen] = useState(false);
  const [freshBusy, setFreshBusy] = useState(false);
  const [freshError, setFreshError] = useState<string | null>(null);
  // shared by the TopBar action and the readonly banner button
  const openFresh = () => {
    setFreshError(null);
    setFreshOpen(true);
  };

  const confirmFresh = useCallback(
    (resetToStub: boolean) => {
      if (refAttempt == null) return;
      setFreshBusy(true);
      setFreshError(null);
      void (async () => {
        try {
          // the snapshot must capture what's on screen, not stale disk state
          // (no-op in readonly mode — nothing can be dirty)
          await flushSaves();
          await startFreshAttempt(refAttempt.id, resetToStub);
          onReload();
        } catch (e) {
          setFreshBusy(false);
          setFreshError(e instanceof Error ? e.message : 'Failed to start a new attempt');
        }
      })();
    },
    [refAttempt, onReload, flushSaves],
  );

  // ---- timer + layout -----------------------------------------------------
  const timer = useActiveTimer(attempt?.id ?? null, attempt?.activeSeconds ?? 0);
  // Below ~900px / ~1150px there isn't room for every pane at once (NEE-290):
  // default the problem pane / AI panel collapsed so the console and its Run
  // button stay reachable. Read once on mount (never re-evaluated against a
  // live resize) so it only ever supplies a *default* — an explicit toggle,
  // or a stored 'ace-ai-open' preference, always wins.
  const [problemOpen, setProblemOpen] = useState(() => matchesMinWidth(900));
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [aiOpen, setAiOpen] = useLocalStorageState('ace-ai-open', () => matchesMinWidth(1150));
  // Draggable splitter widths/height (NEE-305) — persisted + re-clamped
  // against the current window size on mount and resize.
  const layout = usePaneLayout();

  // ---- keyboard shortcuts overlay + pane-toggle bindings (NEE-309) --------
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsCloseBtnRef = useRef<HTMLButtonElement>(null);
  // Captures the live Monaco editor instance so "focus editor" has something
  // to call .focus() on — Cmd/Ctrl+Enter and Cmd/Ctrl+S already live inside
  // useTestRuns' own onMount (handleEditorMount); this just piggybacks on the
  // same mount callback to also stash the instance here.
  const editorInstanceRef = useRef<Parameters<OnMount>[0] | null>(null);
  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editorInstanceRef.current = editor;
      runs.handleEditorMount(editor, monacoInstance);
    },
    [runs],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // '?' opens the shortcuts overlay — never while typing, and not while
      // some other modal (fresh attempt / dispute) already owns focus.
      if (e.key === '?' && !isEditableTarget(e.target)) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (isEditableTarget(e.target)) return;
      // Match on e.code (physical key), not e.key: on macOS, holding
      // Option/Alt while typing a letter composes an alt-glyph character
      // (e.g. Option+P -> 'π', Option+C -> 'ç', Option+E is a dead/compose
      // key) — e.key reports that composed character across Chrome, Safari,
      // and Firefox, so matching on e.key left these bindings non-functional
      // on the Mac dev/run platform. e.code reports the physical key
      // regardless of layout or modifier composition.
      switch (e.code) {
        case 'KeyP':
          e.preventDefault();
          setProblemOpen((v) => !v);
          break;
        case 'KeyI':
          e.preventDefault();
          setAiOpen((v) => !v);
          break;
        case 'KeyC':
          e.preventDefault();
          setConsoleOpen((v) => !v);
          break;
        case 'KeyE':
          e.preventDefault();
          editorInstanceRef.current?.focus();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setAiOpen]);

  return (
    <div className="room">
      <TopBar
        question={question}
        seconds={timer.seconds}
        timerActive={timer.active}
        running={runs.running != null}
        readonly={readonly}
        onRun={hasTests && !readonly ? () => runs.startRun('manual') : undefined}
        onStop={runs.stopRun}
        onFreshAttempt={readonly ? undefined : openFresh}
        prevTo={prevQuestion != null ? roomHref(prevQuestion, nav.linkQuery) : undefined}
        nextTo={nextQuestion != null ? roomHref(nextQuestion, nav.linkQuery) : undefined}
      />
      {readonly && (
        <div className="room-solved-banner">
          <span className="room-solved-banner-text">
            <span className="room-solved-badge">✓ Solved</span> — read-only reference
          </span>
          <span className="room-solved-banner-actions">
            {nextUnsolvedQuestion != null && (
              <Link
                className="btn btn-small btn-accent"
                to={roomHref(nextUnsolvedQuestion, nav.linkQuery)}
              >
                Next question →
              </Link>
            )}
            {latestAttempt != null && (
              <button className="btn btn-small" onClick={openFresh}>
                Start new attempt
              </button>
            )}
          </span>
        </div>
      )}
      {!connected && <div className="sse-strip">reconnecting…</div>}
      <div className="room-body">
        {problemOpen ? (
          <>
            <div
              ref={layout.problemRef}
              className="pane-slot-problem"
              style={layout.problemWidth != null ? { width: `${layout.problemWidth}px` } : undefined}
            >
              <ProblemPane
                readme={detail.readme}
                attemptId={refAttempt?.id ?? ''}
                attemptNumber={refAttempt?.number ?? 0}
                history={runs.history}
                disputes={review.disputes}
                onCollapse={() => setProblemOpen(false)}
              />
            </div>
            <Splitter
              orientation="vertical"
              label="Resize problem pane"
              valueNow={layout.problemWidth ?? PANE_DEFAULT_WIDTH.problem}
              valueMin={layout.problemMin}
              valueMax={layout.paneMax}
              onResize={layout.resizeProblem}
              onReset={layout.resetProblem}
            />
          </>
        ) : (
          <button
            className="pane-expander"
            onClick={() => setProblemOpen(true)}
            title="Show problem pane"
          >
            ▸
          </button>
        )}
        <div className="center-col">
          <EditorPane
            order={editorFiles}
            files={buffers.files}
            active={buffers.activeTab}
            onSelect={buffers.setActiveTab}
            onChange={buffers.handleChange}
            onMount={handleEditorMount}
            onConflictReload={buffers.resolveConflictReload}
            onConflictKeep={buffers.resolveConflictKeep}
          />
          {hasTests && consoleOpen && (
            <Splitter
              orientation="horizontal"
              label="Resize console height"
              valueNow={layout.consoleHeight ?? CONSOLE_DEFAULT_HEIGHT}
              valueMin={layout.consoleMin}
              valueMax={layout.consoleMax}
              onResize={(deltaPx) => layout.resizeConsole(-deltaPx)}
              onReset={layout.resetConsole}
            />
          )}
          {hasTests &&
            (consoleOpen ? (
              <div
                ref={layout.consoleRef}
                className="console-slot"
                style={layout.consoleHeight != null ? { height: `${layout.consoleHeight}px` } : undefined}
              >
                <TestConsole
                  running={runs.running}
                  lastRun={runs.lastRun}
                  historyCount={runs.history.length}
                  output={runs.output}
                  runError={runs.runError}
                  autorun={autorun}
                  onToggleAutorun={() => setAutorun((v) => !v)}
                  formatBeforeRun={formatBeforeRun}
                  onToggleFormatBeforeRun={() => setFormatBeforeRun((v) => !v)}
                  onRun={() => runs.startRun('manual')}
                  onStop={runs.stopRun}
                  onCollapse={() => setConsoleOpen(false)}
                  onDispute={(testName) => {
                    if (runs.lastRun != null) review.openDispute(runs.lastRun.runId, testName);
                  }}
                />
              </div>
            ) : (
              <button
                className="console-expander"
                onClick={() => setConsoleOpen(true)}
                title="Show test console"
              >
                Tests ▴
                {runs.lastRun?.status === 'compile-error' && (
                  <span className="mono run-fail"> compile error</span>
                )}
                {runs.lastRun?.status === 'done' &&
                  runs.lastRun.summary &&
                  (runs.lastRun.summary.total === 0 ? (
                    <span className="mono cell-dim"> no tests</span>
                  ) : (
                    <span
                      className={`mono ${runs.lastRun.summary.failed > 0 ? 'run-fail' : 'run-pass'}`}
                    >
                      {' '}
                      {runs.lastRun.summary.passed}/{runs.lastRun.summary.total}
                    </span>
                  ))}
              </button>
            ))}
        </div>
        {aiOpen ? (
          <>
            <Splitter
              orientation="vertical"
              label="Resize AI panel"
              valueNow={layout.aiWidth ?? PANE_DEFAULT_WIDTH.ai}
              valueMin={layout.aiMin}
              valueMax={layout.paneMax}
              onResize={(deltaPx) => layout.resizeAi(-deltaPx)}
              onReset={layout.resetAi}
            />
            <div
              ref={layout.aiRef}
              className="pane-slot-ai"
              style={layout.aiWidth != null ? { width: `${layout.aiWidth}px` } : undefined}
            >
              <AiPanel
                question={question}
                reviews={review.reviews}
                stream={review.reviewStream}
                notice={review.reviewNotice}
                justDoneId={review.justDoneId}
                settings={review.settings}
                onRequest={readonly ? undefined : review.requestReview}
                probeSets={review.probeSets}
                probesRunning={review.probesRunning}
                probeNotice={review.probeNotice}
                onRequestProbes={readonly ? undefined : review.requestProbes}
                onCollapse={() => setAiOpen(false)}
              />
            </div>
          </>
        ) : (
          <button
            className="pane-expander pane-expander-right"
            onClick={() => setAiOpen(true)}
            title="Show AI review panel"
          >
            ◂
          </button>
        )}
      </div>
      {review.disputeModal != null && (
        <DisputeModal
          runId={review.disputeModal.runId}
          questionId={question.id}
          testName={review.disputeModal.testName}
          onClose={review.closeDispute}
          onApplied={review.handleDisputeApplied}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsOverlay
          closeBtnRef={shortcutsCloseBtnRef}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
      {freshOpen && refAttempt != null && (
        <FreshAttemptDialog
          nextNumber={refAttempt.number + 1}
          busy={freshBusy}
          error={freshError}
          onConfirm={confirmFresh}
          onCancel={() => {
            if (!freshBusy) setFreshOpen(false);
          }}
        />
      )}
    </div>
  );
}

const SHORTCUT_ROWS: Array<{ keys: string; desc: string }> = [
  { keys: '⌘/Ctrl + Enter', desc: 'Run tests' },
  { keys: '⌘/Ctrl + S', desc: 'Format + save' },
  { keys: 'Alt + P', desc: 'Toggle problem pane' },
  { keys: 'Alt + I', desc: 'Toggle AI panel' },
  { keys: 'Alt + C', desc: 'Toggle console' },
  { keys: 'Alt + E', desc: 'Focus editor' },
  { keys: '?', desc: 'Show this list' },
];

/** '?' overlay listing the room's keyboard shortcuts (NEE-309). Reuses the shared Modal shell (NEE-293). */
function ShortcutsOverlay({
  onClose,
  closeBtnRef,
}: {
  onClose: () => void;
  closeBtnRef: RefObject<HTMLButtonElement | null>;
}) {
  const headingId = useId();
  return (
    <Modal labelledBy={headingId} onClose={onClose} canClose initialFocusRef={closeBtnRef}>
      <div className="modal-header">
        <h2 id={headingId}>Keyboard shortcuts</h2>
        <button className="icon-btn" onClick={onClose} title="Close" ref={closeBtnRef}>
          ✕
        </button>
      </div>
      <div className="modal-body">
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUT_ROWS.map((row) => (
              <tr key={row.desc}>
                <td className="mono shortcuts-keys">{row.keys}</td>
                <td>{row.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
