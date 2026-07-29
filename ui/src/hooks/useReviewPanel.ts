import { useCallback, useRef, useState, type RefObject } from 'react';
import {
  ApiError,
  getDisputes,
  getProbeSets,
  getReviews,
  getSettings,
  startProbes,
  startReview,
} from '../api';
import type { ReviewNotice, ReviewStream } from '../components/AiPanel';
import { useSseEvent } from '../sse';
import type {
  DisputeRow,
  ProbeSetRow,
  QuestionFileInfo,
  QuestionRow,
  ReviewRow,
  SettingsInfo,
  TestRunTrigger,
} from '../types';
import { useCancellableEffect } from './useCancellableEffect';
import { useLatestRef } from './useLatestRef';

/**
 * The Room's AI-review + dispute + follow-up-probes slice: review rows, the
 * live review stream, notices, dispute rows, the dispute modal, probe sets,
 * and their SSE handlers.
 */
export function useReviewPanel({
  question,
  attemptId,
  flushSaves,
  editorFiles,
  loadFileInto,
  startRunRef,
}: {
  question: QuestionRow;
  /**
   * The room's notion of "the active attempt" (NEE-345 follow-up) — the live
   * attempt when editable, or the ended reference attempt in a readonly
   * room (Room.tsx's `refAttempt`). Threaded through so probe sets are
   * fetched scoped to the same attempt bucket the server's own bound
   * (hasProbeSetForAttempt) uses, instead of every attempt's probes ever
   * generated for this question.
   */
  attemptId: string | null;
  flushSaves: () => Promise<void>;
  editorFiles: QuestionFileInfo[];
  loadFileInto: (relPath: string, opts?: { onlyIfClean?: boolean }) => Promise<void>;
  startRunRef: RefObject<(trigger: TestRunTrigger) => void>;
}) {
  const questionId = question.id;
  const flushSavesRef = useLatestRef(flushSaves);

  const [reviews, setReviews] = useState<ReviewRow[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [reviewStream, setReviewStream] = useState<ReviewStream | null>(null);
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null);
  const [justDoneId, setJustDoneId] = useState<string | null>(null);
  const [probeSets, setProbeSets] = useState<ProbeSetRow[]>([]);
  const [probeJobId, setProbeJobId] = useState<string | null>(null);
  const [probeNotice, setProbeNotice] = useState<ReviewNotice | null>(null);
  const editorFilesRef = useLatestRef(editorFiles);
  const loadFileIntoRef = useLatestRef(loadFileInto);
  // Provider/keyless + model-map state for the AiPanel gating and disclosure
  // (NEE-303) — same getSettings() NewQuestion already calls, fetched here so
  // Room doesn't need its own copy just to thread it one level down.
  const [settings, setSettings] = useState<SettingsInfo | null>(null);

  useCancellableEffect(
    (cancelled) => {
      getReviews(question.category, question.slug)
        .then((rows) => {
          if (!cancelled()) setReviews(rows);
        })
        .catch(() => {
          if (!cancelled()) setReviews([]);
        });
      getDisputes(question.category, question.slug)
        .then((rows) => {
          if (!cancelled()) setDisputes(rows);
        })
        .catch(() => {});
      getProbeSets(question.category, question.slug, attemptId)
        .then((rows) => {
          if (!cancelled()) setProbeSets(rows);
        })
        .catch(() => {});
    },
    [question.category, question.slug, attemptId],
  );

  useCancellableEffect((cancelled) => {
    getSettings()
      .then((info) => {
        if (!cancelled()) setSettings(info);
      })
      .catch(() => {
        // Leave settings null — AiPanel's keyless check treats null as "not
        // yet known" and keeps the button hidden rather than risking a
        // click-then-503 on a guess.
      });
  }, []);

  const requestReview = useCallback(() => {
    setReviewNotice(null);
    void (async () => {
      try {
        // the review reads files from disk — flush dirty buffers first
        await flushSavesRef.current();
        await startReview(question.category, question.slug);
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) {
          setReviewNotice({ kind: 'no-key', message: e.message });
        } else {
          setReviewNotice({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Failed to start the review',
          });
        }
      }
    })();
  }, [question.category, question.slug, flushSavesRef]);

  const reviewStreamRef = useLatestRef(reviewStream);
  const streamStartedAtRef = useRef('');

  useSseEvent('review-started', (p) => {
    if (p.questionId !== questionId) return;
    streamStartedAtRef.current = new Date().toISOString();
    setReviewStream({ jobId: p.jobId, text: '', error: null });
    setReviewNotice(null);
  });

  // SSE reconnected: a review-done may have been missed while offline —
  // reconcile so the panel can't be stuck on "reviewing…" with the result
  // already persisted server-side.
  useSseEvent('hello', () => {
    if (reviewStreamRef.current == null) return;
    getReviews(question.category, question.slug)
      .then((rows) => {
        setReviews(rows);
        const newest = rows[0];
        if (newest != null && newest.at >= streamStartedAtRef.current) {
          setReviewStream(null);
          setJustDoneId(newest.id);
        }
      })
      .catch(() => {});
  });

  useSseEvent('review-chunk', (p) => {
    setReviewStream((cur) =>
      cur != null && cur.jobId === p.jobId ? { ...cur, text: cur.text + p.chunk } : cur,
    );
  });

  useSseEvent('review-done', (p) => {
    if (p.questionId !== questionId) return;
    setReviewStream(null);
    setJustDoneId(p.review.id);
    setReviews((cur) => [p.review, ...(cur ?? []).filter((r) => r.id !== p.review.id)]);
  });

  useSseEvent('review-error', (p) => {
    if (p.questionId !== questionId) return;
    // keep the partial text under the amber banner; nothing was persisted
    setReviewStream((cur) =>
      cur != null && cur.jobId === p.jobId
        ? { ...cur, error: p.message }
        : { jobId: p.jobId, text: '', error: p.message },
    );
  });

  // ---- disputes -----------------------------------------------------------
  const [disputeModal, setDisputeModal] = useState<{ runId: string; testName: string } | null>(
    null,
  );

  useSseEvent('dispute-done', (p) => {
    if (p.questionId !== questionId) return;
    setDisputes((cur) => [p.dispute, ...cur.filter((d) => d.id !== p.dispute.id)]);
  });

  const openDispute = useCallback((runId: string, testName: string) => {
    setDisputeModal({ runId, testName });
  }, []);
  const closeDispute = useCallback(() => setDisputeModal(null), []);

  const handleDisputeApplied = useCallback(() => {
    setDisputeModal(null);
    getDisputes(question.category, question.slug).then(setDisputes).catch(() => {});
    // A file-changed broadcast for the server's own write does now reach us
    // (NEE-359 removed the process-global echo suppression), but it is
    // watcher-debounced and arrives whenever it arrives — reload the test
    // buffers explicitly so the rerun below is guaranteed to see the fix.
    const reloads = editorFiles
      .filter((f) => f.kind === 'test')
      .map((info) => loadFileInto(info.relPath).catch(() => {}));
    void Promise.all(reloads).then(() => startRunRef.current('manual'));
  }, [question.category, question.slug, editorFiles, loadFileInto, startRunRef]);

  // ---- follow-up probes (NEE-345) ------------------------------------------
  // No composer, no message history, no turn list, no probes-chunk SSE event
  // — one bounded structured call per attempt, mirroring the dispute engine.
  // Answers are typed directly in the Monaco editor (story.md), never here.
  const requestProbes = useCallback(() => {
    setProbeNotice(null);
    void (async () => {
      try {
        // Probes read the story from disk — flush dirty buffers first,
        // exactly as requestReview does.
        await flushSavesRef.current();
        const { probeJobId: jobId } = await startProbes(question.category, question.slug);
        setProbeJobId(jobId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) {
          setProbeNotice({ kind: 'no-key', message: e.message });
        } else {
          setProbeNotice({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Failed to request follow-up probes',
          });
        }
      }
    })();
  }, [question.category, question.slug, flushSavesRef]);

  useSseEvent('probes-started', (p) => {
    if (p.questionId !== questionId) return;
    setProbeJobId(p.probeJobId);
    setProbeNotice(null);
  });

  useSseEvent('probes-done', (p) => {
    if (p.questionId !== questionId) return;
    setProbeJobId(null);
    setProbeSets((cur) => [p.probeSet, ...cur.filter((s) => s.id !== p.probeSet.id)]);
    // The append does now also raise a file-changed broadcast (NEE-359), but
    // only once the watcher's awaitWriteFinish settles — reload the story
    // buffer explicitly so it is on screen the moment the probes are;
    // onlyIfClean routes a raced dirty buffer into the existing conflict
    // banner instead of clobbering it.
    //
    // Resolved by structural identity, not a category-specific FileKind
    // literal: `kind` is 'notes' for prose categories on the wire (see
    // questions.ts's solutionKind), so matching 'solution' here can never
    // fire for the only categories probes ever run on — and matching
    // 'notes' instead would just be the same brittle coupling one value
    // over. Every category's primary answer file is instead its one
    // editable, non-test file (test files are always readonly, and prose
    // categories — the only ones probes reach — have no test files at
    // all): the same "primary file" notion useFileBuffers already uses to
    // pick the default active tab (see firstEditable there).
    const story = editorFilesRef.current.find((f) => !f.readonly);
    if (story) loadFileIntoRef.current(story.relPath, { onlyIfClean: true }).catch(() => {});
  });

  useSseEvent('probes-error', (p) => {
    if (p.questionId !== questionId) return;
    setProbeJobId(null);
    setProbeNotice({ kind: 'error', message: p.message });
  });

  return {
    reviews,
    disputes,
    reviewStream,
    reviewNotice,
    justDoneId,
    settings,
    requestReview,
    disputeModal,
    openDispute,
    closeDispute,
    handleDisputeApplied,
    probeSets,
    probesRunning: probeJobId != null,
    probeNotice,
    requestProbes,
  };
}
