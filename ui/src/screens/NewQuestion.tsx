import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, getSettings, startGenerationJob } from '../api';
import { GenerationJobStrip } from '../components/GenerationJobStrip';
import {
  CATEGORY_SLUGS,
  categoryHint,
  categoryShortName,
  suggestedMinutes,
} from '../lib/categories';
import type { Difficulty, GenerationJobRow, SettingsInfo } from '../types';

type Tab = 'describe' | 'brainstorm';

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const TOPIC_MAX = 4000;

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
            <div className="pane-empty">Brainstorm mode is coming soon.</div>
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
