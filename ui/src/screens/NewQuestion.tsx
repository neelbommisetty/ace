import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  getBrainstormSession,
  getBrainstormSessions,
  getSettings,
  sendBrainstormTurn,
  startGenerationJob,
} from '../api';
import { GenerationJobStrip } from '../components/GenerationJobStrip';
import { IdeaCard } from '../components/IdeaCard';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { GENERATABLE_CATEGORY_SLUGS, categoryHint, categoryShortName } from '../lib/categories';
import { isKeyless, modelLabel, resolvedModelFor } from '../lib/models';
import { useSseEvent } from '../sse';
import type { BrainstormSessionRow, Difficulty, GenerationJobRow, SettingsInfo } from '../types';

type Tab = 'describe' | 'brainstorm';

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const TOPIC_MAX = 4000;

/** sessionStorage key for reopening the in-progress brainstorm session across a reload/tab-switch. */
const BRAINSTORM_SESSION_KEY = 'ace-brainstorm-session';

/**
 * sessionStorage value written by "Start over" — distinct from "no key at
 * all" so the reopen effect knows to leave the composer empty instead of
 * falling back to the most recent session (session ids are uuidv7 and can
 * never collide with this literal).
 */
const BRAINSTORM_CLEARED_SENTINEL = 'cleared';

/**
 * /new — start a generation job. Two tabs: describe a question directly, or
 * brainstorm ideas with the LLM first (brainstorm mode lands in a later
 * step). GenerationJobStrip is mounted here too so an optimistic local card
 * converges into the real, SSE-backed strip as soon as the job row exists
 * server-side.
 */
export function NewQuestion() {
  const [tab, setTab] = useState<Tab>('describe');
  const [settings, setSettings] = useState<SettingsInfo | null>(null);

  useCancellableEffect((cancelled) => {
    getSettings()
      .then((info) => {
        if (!cancelled()) setSettings(info);
      })
      .catch(() => {
        // Leave settings null — the form stays disabled rather than risking
        // a submit with an unknown provider state.
      });
  }, []);

  const settingsLoaded = settings != null;
  const keyless = isKeyless(settings);
  const formDisabled = !settingsLoaded || keyless;

  return (
    <div className="new-question">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="topbar-title">New question</h1>
        </div>
      </header>
      <div className="library-scroll">
        <div className="new-question-wrap">
          <div className="tab-row" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'describe'}
              className={`pill ${tab === 'describe' ? 'active' : ''}`}
              onClick={() => setTab('describe')}
            >
              Describe
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'brainstorm'}
              className={`pill ${tab === 'brainstorm' ? 'active' : ''}`}
              onClick={() => setTab('brainstorm')}
            >
              Brainstorm
            </button>
          </div>

          {keyless && (
            <div className="mock-banner">
              No LLM provider is configured — add an API key in{' '}
              <Link to="/settings">Settings</Link> before generating a question.
            </div>
          )}

          {tab === 'describe' ? (
            <DescribeForm disabled={formDisabled} settings={settings} />
          ) : (
            <BrainstormPane disabled={formDisabled} settings={settings} />
          )}

          <GenerationJobStrip />
        </div>
      </div>
    </div>
  );
}

function DescribeForm({
  disabled,
  settings,
}: {
  disabled: boolean;
  settings: SettingsInfo | null;
}) {
  const [category, setCategory] = useState<string>(GENERATABLE_CATEGORY_SLUGS[0]);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [topic, setTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingJob, setPendingJob] = useState<GenerationJobRow | null>(null);
  // The first stage of the pipeline stands in for the whole generation run —
  // the later stages route their own slots and are not previewable here.
  const generateModel = resolvedModelFor(settings, 'draft-problem');

  const trimmedTopic = topic.trim();
  const canSubmit = !disabled && !submitting && trimmedTopic.length > 0 && trimmedTopic.length <= TOPIC_MAX;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    const startedAt = new Date().toISOString();
    setPendingJob({
      id: `local-${Date.now()}`,
      status: 'running',
      category,
      difficulty,
      topic: trimmedTopic,
      brainstormSessionId: null,
      feedback: null,
      sourceQuestionId: null,
      title: null,
      slug: null,
      result: null,
      rawText: null,
      errorMessage: null,
      questionId: null,
      createdAt: startedAt,
      // Same instant as createdAt — the shared wire type requires the field,
      // and the elapsed clock's `runStartedAt ?? createdAt` fallback used the
      // identical anchor for this local placeholder before it existed.
      runStartedAt: startedAt,
      finishedAt: null,
    });

    try {
      await startGenerationJob({ category, difficulty, topic: trimmedTopic });
      // The server already emitted `generation-started` before responding,
      // so the real, SSE-backed strip below has (or is about to have) this
      // job — drop the local placeholder rather than show it twice.
      setTopic('');
      setPendingJob(null);
    } catch (err) {
      setPendingJob(null);
      setError(err instanceof ApiError ? err.message : 'Failed to start generation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="new-question-form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="nq-category">
          Category
        </label>
        <select
          id="nq-category"
          className="status-select"
          value={category}
          disabled={disabled}
          onChange={(e) => setCategory(e.target.value)}
        >
          {GENERATABLE_CATEGORY_SLUGS.map((slug) => (
            <option key={slug} value={slug}>
              {categoryShortName(slug)} — {categoryHint(slug)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="nq-difficulty">
          Difficulty
        </label>
        <select
          id="nq-difficulty"
          className="status-select"
          value={difficulty}
          disabled={disabled}
          onChange={(e) => setDifficulty(e.target.value as Difficulty)}
        >
          {DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="nq-topic">
          Topic
        </label>
        <textarea
          id="nq-topic"
          className="dispute-argument"
          rows={5}
          maxLength={TOPIC_MAX}
          placeholder="Describe the question you want — e.g. 'a debounced search input with cancel-in-flight'"
          value={topic}
          disabled={disabled}
          onChange={(e) => setTopic(e.target.value)}
        />
      </div>

      <p className="dialog-note">
        Runs a verified problem → solution → tests → packet → edge-audit → verify → repair pipeline
        — costs several LLM calls and can take a couple of minutes
        {generateModel != null ? ` · ${modelLabel(generateModel)}` : ''}.
      </p>

      {error != null && <div className="error-note">{error}</div>}

      <div className="settings-row">
        <button className="btn btn-accent" type="submit" disabled={!canSubmit}>
          {submitting ? 'Starting…' : 'Generate'}
        </button>
      </div>

      {pendingJob != null && (
        <div className="job-card job-card-running" data-testid="pending-job-card">
          <span className="pulse-dot" aria-hidden="true" />
          <div className="job-card-info">
            <div className="job-card-title">{pendingJob.topic}</div>
            <div className="job-card-meta">
              {categoryShortName(pendingJob.category)} · starting…
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

/**
 * Brainstorm tab: chat with the LLM to land on idea(s), then hand any of
 * them straight to a generation job via IdeaCard. Reopens the last active
 * session (sessionStorage id, falling back to the most recent session from
 * the server) so a reload or tab-switch doesn't lose an in-progress chat.
 */
function BrainstormPane({
  disabled,
  settings,
}: {
  disabled: boolean;
  settings: SettingsInfo | null;
}) {
  const [session, setSession] = useState<BrainstormSessionRow | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brainstormModel = resolvedModelFor(settings, 'brainstorm');

  // The engine emits 'brainstorm-started' synchronously (before the LLM call
  // even begins) and 'brainstorm-done'/'brainstorm-error' only after it —
  // both over the same SSE stream, so they always arrive in that order.
  // 'started' therefore is the reliable signal to flip the composer into
  // "thinking", NOT the POST response: in mock mode the mock LLM resolves in
  // a microtask, so the server can emit — and the client can receive —
  // 'brainstorm-done' before the POST's own response body finishes parsing.
  // `pendingSendRef` records the turn we just fired off so whichever of
  // {the 'brainstorm-started' event, the POST resolving} lands first applies
  // it, and the other becomes a no-op instead of clobbering later state.
  const pendingSendRef = useRef<{ sessionId: string | null; message: string } | null>(null);

  // Ids for which a 'brainstorm-done'/'brainstorm-error' arrived while no
  // local `session` matched (i.e. the reopen fetch below for that exact id
  // was still in flight) — the fetch may have raced a completing turn and
  // returned a stale snapshot. Consulted by reopen() to refetch once more
  // rather than silently showing a stale 'thinking' state forever.
  const racedIdsRef = useRef<Set<string>>(new Set());

  function applyPendingSend(sessionId: string, msg: string) {
    setSession((prev) => {
      if (prev != null && prev.id === sessionId) {
        return {
          ...prev,
          status: 'thinking',
          errorMessage: null,
          messages: [...prev.messages, { role: 'user', content: msg }],
        };
      }
      const now = new Date().toISOString();
      return {
        id: sessionId,
        status: 'thinking',
        title: msg.slice(0, 80),
        messages: [{ role: 'user', content: msg }],
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  // A ref, not state: this guard must not itself be an effect dependency —
  // flipping state inside the effect would re-run the effect and fire this
  // same run's cleanup (setting `cancelled`) before the in-flight fetch below
  // even resolves, silently dropping the reopened session.
  useCancellableEffect((cancelled) => {
    /** Fetches `id`, refetching once more if a done/error event for it raced this call. */
    async function fetchSettled(id: string) {
      racedIdsRef.current.delete(id);
      let res = await getBrainstormSession(id);
      if (racedIdsRef.current.has(id)) {
        racedIdsRef.current.delete(id);
        res = await getBrainstormSession(id);
      }
      return res.session;
    }

    async function reopen() {
      const storedId = sessionStorage.getItem(BRAINSTORM_SESSION_KEY);
      if (storedId === BRAINSTORM_CLEARED_SENTINEL) return; // explicit "Start over" — stay empty
      if (storedId) {
        try {
          const session = await fetchSettled(storedId);
          if (!cancelled()) setSession(session);
          return;
        } catch {
          // Stale/unknown id (e.g. 404) — clear it and fall back to the
          // latest session below.
          sessionStorage.removeItem(BRAINSTORM_SESSION_KEY);
        }
      }
      try {
        const { sessions } = await getBrainstormSessions(1);
        const latest = sessions[0];
        if (latest == null || cancelled()) return;
        const full = await fetchSettled(latest.id);
        if (!cancelled()) {
          setSession(full);
          sessionStorage.setItem(BRAINSTORM_SESSION_KEY, full.id);
        }
      } catch {
        // Nothing to reopen — leave the empty composer.
      }
    }

    void reopen();
    // Runs once per mount (BrainstormPane itself unmounts on tab-switch away,
    // so this already covers "on mount/tab-switch, attempt session reopen").
  }, []);

  useSseEvent('brainstorm-started', ({ sessionId }) => {
    const pending = pendingSendRef.current;
    if (pending == null) return;
    if (pending.sessionId != null && pending.sessionId !== sessionId) return;
    pendingSendRef.current = null;
    applyPendingSend(sessionId, pending.message);
    sessionStorage.setItem(BRAINSTORM_SESSION_KEY, sessionId);
  });

  useSseEvent('brainstorm-done', ({ sessionId, turn }) => {
    setSession((prev) => {
      if (prev == null || prev.id !== sessionId) {
        racedIdsRef.current.add(sessionId);
        return prev;
      }
      return { ...prev, status: 'idle', errorMessage: null, messages: [...prev.messages, turn] };
    });
  });

  useSseEvent('brainstorm-error', ({ sessionId, message: msg }) => {
    setSession((prev) => {
      if (prev == null || prev.id !== sessionId) {
        racedIdsRef.current.add(sessionId);
        return prev;
      }
      return { ...prev, status: 'error', errorMessage: msg };
    });
  });

  // Disabled the instant a turn is sent (optimistic status flip below), all
  // the way through the corresponding SSE 'brainstorm-done'/'brainstorm-error'.
  const thinking = session?.status === 'thinking';
  const trimmed = message.trim();
  const canSend =
    !disabled && !sending && !thinking && trimmed.length > 0 && trimmed.length <= TOPIC_MAX;

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;

    setSending(true);
    setError(null);
    const sentMessage = trimmed;
    pendingSendRef.current = { sessionId: session?.id ?? null, message: sentMessage };
    try {
      const { sessionId } = await sendBrainstormTurn(session?.id ?? null, sentMessage);
      setMessage('');
      // If 'brainstorm-started' already arrived (see useSseEvent above) it
      // already applied this exact send and cleared the ref — don't reapply.
      if (pendingSendRef.current != null) {
        pendingSendRef.current = null;
        applyPendingSend(sessionId, sentMessage);
      }
      sessionStorage.setItem(BRAINSTORM_SESSION_KEY, sessionId);
    } catch (err) {
      pendingSendRef.current = null;
      setError(err instanceof ApiError ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  function onStartOver() {
    // Written, not removed: an absent key means "fall back to the latest
    // session" (see reopen()) — writing the sentinel is what makes "Start
    // over" stick across a tab-switch/remount instead of resurrecting the
    // very session just discarded.
    sessionStorage.setItem(BRAINSTORM_SESSION_KEY, BRAINSTORM_CLEARED_SENTINEL);
    setSession(null);
    setMessage('');
    setError(null);
  }

  return (
    <div className="brainstorm-pane">
      {session != null && session.messages.length > 0 && (
        <div className="brainstorm-history">
          {session.messages.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="brainstorm-turn brainstorm-turn-user">
                {turn.content}
              </div>
            ) : (
              <div key={i} className="brainstorm-turn brainstorm-turn-assistant">
                <p>{turn.content}</p>
                {/* An empty `ideas` array is the expected shape for a purely
                    conversational reply (see STRUCTURED_OUTPUT_ADDENDUM in
                    cli/server/brainstorm.ts) as well as for the parse-failure
                    salvage path — the two are indistinguishable here, so we
                    render nothing extra rather than asserting a failure that
                    may not have happened; `turn.content` above already shows
                    whatever the model said (including raw salvaged text). */}
                {turn.ideas != null && turn.ideas.length > 0 && (
                  <div className="idea-grid">
                    {turn.ideas.map((idea, j) => (
                      <IdeaCard key={j} idea={idea} sessionId={session.id} />
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {session?.status === 'error' && session.errorMessage != null && (
        <div className="error-note">{session.errorMessage}</div>
      )}

      <p className="dialog-note">
        Each turn costs one LLM call
        {brainstormModel != null ? ` · ${modelLabel(brainstormModel)}` : ''}.
      </p>

      <form className="brainstorm-composer" onSubmit={onSend}>
        <textarea
          className="dispute-argument"
          rows={3}
          maxLength={TOPIC_MAX}
          aria-label={session == null ? 'Brainstorm' : 'Refine'}
          placeholder={
            session == null
              ? "What kind of question do you want? e.g. 'something about React state management'"
              : 'Refine — ask for more ideas, a different angle, etc.'
          }
          value={message}
          disabled={disabled || thinking || sending}
          onChange={(e) => setMessage(e.target.value)}
        />
        {error != null && <div className="error-note">{error}</div>}
        <div className="settings-row">
          <button className="btn btn-accent" type="submit" disabled={!canSend}>
            {thinking ? 'Thinking…' : sending ? 'Sending…' : session == null ? 'Brainstorm' : 'Send'}
          </button>
          {session != null && (
            <button type="button" className="btn btn-small" onClick={onStartOver}>
              Start over
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
