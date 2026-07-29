import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, createOrResumeAttempt, getQuestionDetail, startFreshAttempt } from '../api';
import { AiPanel } from '../components/AiPanel';
import { DisputeModal } from '../components/DisputeModal';
import { EditorPane } from '../components/EditorPane';
import { FreshAttemptDialog } from '../components/FreshAttemptDialog';
import { ProblemPane } from '../components/ProblemPane';
import { TestConsole } from '../components/TestConsole';
import { TopBar } from '../components/TopBar';
import { useActiveTimer } from '../hooks/useActiveTimer';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { useFileBuffers } from '../hooks/useFileBuffers';
import { useLocalStorageState } from '../hooks/useLocalStorageState';
import { useReviewPanel } from '../hooks/useReviewPanel';
import { useTestRuns } from '../hooks/useTestRuns';
import { useSseConnected } from '../sse';
import type { AttemptRow, QuestionDetail, TestRunTrigger } from '../types';
import { NotFound } from './NotFound';

// Layout-only default check (NEE-290): "is the window at least this wide,
// right now". Never wired to a resize listener — it seeds a useState
// initializer once on mount, so it can only ever set a *default*, not
// fight a later explicit toggle. matchMedia is present in every real
// browser and in the happy-dom test environment.
function matchesMinWidth(px: number): boolean {
  return window.matchMedia(`(min-width: ${px}px)`).matches;
}

export function Room() {
  const { category = '', slug = '' } = useParams();
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

  if (notFound) {
    return <NotFound message={`No question at ${category}/${slug}.`} />;
  }
  if (error != null) {
    return (
      <div className="notfound">
        <p className="notfound-message error-note">{error}</p>
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
      onReload={() => setReloadKey((k) => k + 1)}
    />
  );
}

function RoomInner({
  detail,
  attempt,
  latestAttempt,
  onReload,
}: {
  detail: QuestionDetail;
  attempt: AttemptRow | null;
  latestAttempt: AttemptRow | null;
  onReload: () => void;
}) {
  const question = detail.question;
  const connected = useSseConnected();

  // Solved question opened as a read-only reference: no active attempt.
  const readonly = attempt == null;

  const [autorun, setAutorun] = useLocalStorageState('ace-autorun', false);

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
  });
  startRunRef.current = runs.startRun;

  const review = useReviewPanel({ question, flushSaves, editorFiles, loadFileInto, startRunRef });

  // ---- fresh attempt ------------------------------------------------------
  // "Start new attempt" (readonly banner) or "↺ New attempt" (active TopBar)
  // mints attempt N+1 off of: the live attempt when editable, or the ended
  // latestAttempt when this is a readonly reference.
  const refAttempt = attempt ?? latestAttempt;
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

  return (
    <div className="room">
      <TopBar
        question={question}
        seconds={timer.seconds}
        timerActive={timer.active}
        running={runs.running != null}
        readonly={readonly}
        onRun={hasTests && !readonly ? () => runs.startRun('manual') : undefined}
        onFreshAttempt={readonly ? undefined : openFresh}
      />
      {readonly && (
        <div className="room-solved-banner">
          <span className="room-solved-banner-text">
            <span className="room-solved-badge">✓ Solved</span> — read-only reference
          </span>
          {latestAttempt != null && (
            <button className="btn btn-small btn-accent" onClick={openFresh}>
              Start new attempt
            </button>
          )}
        </div>
      )}
      {!connected && <div className="sse-strip">reconnecting…</div>}
      <div className="room-body">
        {problemOpen ? (
          <ProblemPane
            readme={detail.readme}
            attemptId={refAttempt?.id ?? ''}
            attemptNumber={refAttempt?.number ?? 0}
            history={runs.history}
            disputes={review.disputes}
            onCollapse={() => setProblemOpen(false)}
          />
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
            onMount={runs.handleEditorMount}
            onConflictReload={buffers.resolveConflictReload}
            onConflictKeep={buffers.resolveConflictKeep}
          />
          {hasTests &&
            (consoleOpen ? (
              <TestConsole
                running={runs.running}
                lastRun={runs.lastRun}
                historyCount={runs.history.length}
                output={runs.output}
                runError={runs.runError}
                autorun={autorun}
                onToggleAutorun={() => setAutorun((v) => !v)}
                onRun={() => runs.startRun('manual')}
                onCollapse={() => setConsoleOpen(false)}
                onDispute={(testName) => {
                  if (runs.lastRun != null) review.openDispute(runs.lastRun.runId, testName);
                }}
              />
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
          <AiPanel
            question={question}
            reviews={review.reviews}
            stream={review.reviewStream}
            notice={review.reviewNotice}
            justDoneId={review.justDoneId}
            onRequest={readonly ? undefined : review.requestReview}
            onCollapse={() => setAiOpen(false)}
          />
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
