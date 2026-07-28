import { useCallback, useRef, useState, type RefObject } from 'react';
import { ApiError, getDisputes, getReviews, startReview } from '../api';
import type { ReviewNotice, ReviewStream } from '../components/AiPanel';
import { useSseEvent } from '../sse';
import type {
  DisputeRow,
  QuestionFileInfo,
  QuestionRow,
  ReviewRow,
  TestRunTrigger,
} from '../types';
import { useCancellableEffect } from './useCancellableEffect';
import { useLatestRef } from './useLatestRef';

/**
 * The Room's AI-review + dispute slice: review rows, the live review stream,
 * notices, dispute rows, the dispute modal, and their SSE handlers.
 */
export function useReviewPanel({
  question,
  flushSaves,
  editorFiles,
  loadFileInto,
  startRunRef,
}: {
  question: QuestionRow;
  flushSaves: () => Promise<void>;
  editorFiles: QuestionFileInfo[];
  loadFileInto: (relPath: string) => Promise<void>;
  startRunRef: RefObject<(trigger: TestRunTrigger) => void>;
}) {
  const questionId = question.id;
  const flushSavesRef = useLatestRef(flushSaves);

  const [reviews, setReviews] = useState<ReviewRow[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [reviewStream, setReviewStream] = useState<ReviewStream | null>(null);
  const [reviewNotice, setReviewNotice] = useState<ReviewNotice | null>(null);
  const [justDoneId, setJustDoneId] = useState<string | null>(null);

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
    },
    [question.category, question.slug],
  );

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
    // The server's own write is echo-suppressed — no file-changed event will
    // arrive. Reload the test buffers explicitly, then rerun.
    const reloads = editorFiles
      .filter((f) => f.kind === 'test')
      .map((info) => loadFileInto(info.relPath).catch(() => {}));
    void Promise.all(reloads).then(() => startRunRef.current('manual'));
  }, [question.category, question.slug, editorFiles, loadFileInto, startRunRef]);

  return {
    reviews,
    disputes,
    reviewStream,
    reviewNotice,
    justDoneId,
    requestReview,
    disputeModal,
    openDispute,
    closeDispute,
    handleDisputeApplied,
  };
}
