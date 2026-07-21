import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
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
import {
  CATEGORY_SLUGS,
  categoryHint,
  categoryShortName,
  suggestedMinutes,
} from '../lib/categories';
import { useSseEvent } from '../sse';
import type { BrainstormSessionRow, Difficulty, GenerationJobRow, SettingsInfo } from '../types';

type Tab = 'describe' | 'brainstorm';

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const TOPIC_MAX = 4000;

/** sessionStorage key for reopening the in-progress brainstorm session across a reload/tab-switch. */
const BRAINSTORM_SESSION_KEY = 'ace-brainstorm-session';

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

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((info) => {
        if (!cancelled) setSettings(info);
      })
      .catch(() => {
        // Leave settings null — the form stays disabled rather than risking
        // a submit with an unknown provider state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const settingsLoaded = settings != null;
  const keyless =
    settingsLoaded && !settings.mockMode && !settings.openai.configured && !settings.anthropic.configured;
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
            <DescribeForm disabled={formDisabled} />
          ) : (
            <BrainstormPane disabled={formDisabled} />
          )}

          <GenerationJobStrip />
        </div>
      </div>
    </div>
  );
}

function DescribeForm({ disabled }: { disabled: boolean }) {
  const [category, setCategory] = useState<string>(CATEGORY_SLUGS[0]);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [topic, setTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingJob, setPendingJob] = useState<GenerationJobRow | null>(null);

  const trimmedTopic = topic.trim();
  const canSubmit = !disabled && !submitting && trimmedTopic.length > 0 && trimmedTopic.length <= TOPIC_MAX;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setPendingJob({
      id: `local-${Date.now()}`,
      status: 'running',
      category,
      difficulty,
      topic: trimmedTopic,
      brainstormSessionId: null,
      title: null,
      slug: null,
      result: null,
      rawText: null,
      errorMessage: null,
      questionId: null,
      createdAt: new Date().toISOString(),
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
          {CATEGORY_SLUGS.map((slug) => (
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
              {d} — ~{suggestedMinutes(category, d)} min
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
function BrainstormPane({ disabled }: { disabled: boolean }) {
  const [session, setSession] = useState<BrainstormSessionRow | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ref, not state: this guard must not itself be an effect dependency —
  // flipping state inside the effect would re-run the effect and fire this
  // same run's cleanup (setting `cancelled`) before the in-flight fetch below
  // even resolves, silently dropping the reopened session.
  useEffect(() => {
    let cancelled = false;

    async function reopen() {
      const storedId = sessionStorage.getItem(BRAINSTORM_SESSION_KEY);
      if (storedId) {
        try {
          const res = await getBrainstormSession(storedId);
          if (!cancelled) setSession(res.session);
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
        if (latest == null || cancelled) return;
        const full = await getBrainstormSession(latest.id);
        if (!cancelled) {
          setSession(full.session);
          sessionStorage.setItem(BRAINSTORM_SESSION_KEY, full.session.id);
        }
      } catch {
        // Nothing to reopen — leave the empty composer.
      }
    }

    void reopen();
    return () => {
      cancelled = true;
    };
    // Runs once per mount (BrainstormPane itself unmounts on tab-switch away,
    // so this already covers "on mount/tab-switch, attempt session reopen").
  }, []);

  useSseEvent('brainstorm-done', ({ sessionId, turn }) => {
    setSession((prev) =>
      prev != null && prev.id === sessionId
        ? { ...prev, status: 'idle', errorMessage: null, messages: [...prev.messages, turn] }
        : prev,
    );
  });

  useSseEvent('brainstorm-error', ({ sessionId, message: msg }) => {
    setSession((prev) =>
      prev != null && prev.id === sessionId ? { ...prev, status: 'error', errorMessage: msg } : prev,
    );
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
    try {
      const { sessionId } = await sendBrainstormTurn(session?.id ?? null, sentMessage);
      setMessage('');
      setSession((prev) => {
        if (prev != null && prev.id === sessionId) {
          return {
            ...prev,
            status: 'thinking',
            errorMessage: null,
            messages: [...prev.messages, { role: 'user', content: sentMessage }],
          };
        }
        const now = new Date().toISOString();
        return {
          id: sessionId,
          status: 'thinking',
          title: sentMessage.slice(0, 80),
          messages: [{ role: 'user', content: sentMessage }],
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        };
      });
      sessionStorage.setItem(BRAINSTORM_SESSION_KEY, sessionId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  function onStartOver() {
    sessionStorage.removeItem(BRAINSTORM_SESSION_KEY);
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
                {turn.ideas != null && turn.ideas.length > 0 ? (
                  <div className="idea-grid">
                    {turn.ideas.map((idea, j) => (
                      <IdeaCard key={j} idea={idea} sessionId={session.id} />
                    ))}
                  </div>
                ) : (
                  <div className="brainstorm-refine-hint">
                    Couldn&apos;t parse ideas from that reply — try refining your ask below.
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
