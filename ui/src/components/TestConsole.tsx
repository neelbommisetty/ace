import { useEffect, useRef, useState } from 'react';
import { formatDuration, relTime } from '../lib/format';
import type { TestCaseResult, TestRunStatus, TestRunSummary, TestRunTrigger } from '../types';

export interface RunDisplay {
  runId: string;
  at: string;
  status: TestRunStatus;
  summary: TestRunSummary | null;
  results: TestCaseResult[] | null;
  errorMessage: string | null;
}

export function TestConsole({
  running,
  lastRun,
  historyCount,
  output,
  runError,
  autorun,
  onToggleAutorun,
  onRun,
  onCollapse,
}: {
  running: { runId: string; trigger: TestRunTrigger } | null;
  lastRun: RunDisplay | null;
  historyCount: number;
  output: string;
  runError: string | null;
  autorun: boolean;
  onToggleAutorun: () => void;
  onRun: () => void;
  onCollapse: () => void;
}) {
  const [tab, setTab] = useState<'results' | 'output'>('results');
  const outputRef = useRef<HTMLPreElement>(null);
  const wasRunning = useRef(false);

  // follow the run: live output while running, results (or the error) when done
  useEffect(() => {
    if (running && !wasRunning.current) setTab('output');
    if (!running && wasRunning.current && lastRun?.status !== 'error') setTab('results');
    wasRunning.current = running != null;
  }, [running, lastRun]);

  useEffect(() => {
    const el = outputRef.current;
    if (tab === 'output' && el) el.scrollTop = el.scrollHeight;
  }, [output, tab]);

  return (
    <section className="console">
      <div className="console-header">
        <div className="pane-tabs">
          <button
            className={`pane-tab ${tab === 'results' ? 'active' : ''}`}
            onClick={() => setTab('results')}
          >
            Results
          </button>
          <button
            className={`pane-tab ${tab === 'output' ? 'active' : ''}`}
            onClick={() => setTab('output')}
          >
            Output
          </button>
        </div>
        <div className="console-meta">
          {historyCount > 0 && (
            <span className="console-history">
              {historyCount >= 50 ? '50+' : historyCount} {historyCount === 1 ? 'run' : 'runs'}
              {lastRun && ` · last ${relTime(lastRun.at)}`}
            </span>
          )}
          <label className="autorun-toggle" title="Run tests automatically after each save">
            <input type="checkbox" checked={autorun} onChange={onToggleAutorun} />
            auto-run on save
          </label>
          <button className="btn btn-small btn-accent" onClick={onRun} title="Run tests (⌘/Ctrl+Enter)">
            {running ? 'Running…' : 'Run ⌘↩'}
          </button>
          <button className="icon-btn" onClick={onCollapse} title="Collapse console">
            ▾
          </button>
        </div>
      </div>
      <div className="console-body">
        {tab === 'results' ? (
          <ResultsTab running={running} lastRun={lastRun} runError={runError} />
        ) : (
          <div className="output-tab">
            {lastRun?.status === 'error' && !running && (
              <div className="run-error-block">
                <strong>Run failed:</strong> {lastRun.errorMessage ?? 'unknown error'}
              </div>
            )}
            {runError && <div className="run-error-block">{runError}</div>}
            <pre ref={outputRef} className="output-pre">
              {output || (running ? 'waiting for output…' : 'No output. Run tests to see the raw stream.')}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}

function ResultsTab({
  running,
  lastRun,
  runError,
}: {
  running: { runId: string; trigger: TestRunTrigger } | null;
  lastRun: RunDisplay | null;
  runError: string | null;
}) {
  if (runError && !running) {
    return <div className="results-banner results-banner-error">{runError}</div>;
  }
  return (
    <div className="results-tab">
      {running && (
        <div className="results-running">
          <span className="pulse-dot" />
          running tests… {running.trigger === 'save' ? '(auto, on save)' : ''}
        </div>
      )}
      {!running && lastRun == null && (
        <div className="pane-empty">No runs yet — hit Run or ⌘/Ctrl+Enter.</div>
      )}
      {lastRun != null && (
        <>
          {lastRun.status === 'error' && (
            <div className="results-banner results-banner-error">
              Run failed: {lastRun.errorMessage ?? 'unknown error'} — see Output for details.
            </div>
          )}
          {lastRun.status === 'cancelled' && (
            <div className="results-banner results-banner-dim">Run was cancelled.</div>
          )}
          {lastRun.summary && (
            <div
              className={`results-summary ${
                lastRun.summary.failed > 0 ? 'summary-fail' : 'summary-pass'
              }`}
            >
              <span className="mono">
                {lastRun.summary.passed}/{lastRun.summary.total}
              </span>{' '}
              passed
              {lastRun.summary.skipped > 0 && ` · ${lastRun.summary.skipped} skipped`}
              {' · '}
              {formatDuration(lastRun.summary.durationMs)}
              {' · '}
              {relTime(lastRun.at)}
            </div>
          )}
          {lastRun.results && lastRun.results.length > 0 && (
            <CaseList key={lastRun.runId} results={lastRun.results} />
          )}
        </>
      )}
    </div>
  );
}

function CaseList({ results }: { results: TestCaseResult[] }) {
  // failures start expanded; every failing row toggles
  const [collapsedOverride, setCollapsedOverride] = useState<Record<number, boolean>>({});

  return (
    <ul className="case-list">
      {results.map((r, i) => {
        const expanded =
          r.status === 'failed' && r.error != null && !(collapsedOverride[i] ?? false);
        const toggle =
          r.status === 'failed' && r.error != null
            ? () => setCollapsedOverride((prev) => ({ ...prev, [i]: !(prev[i] ?? false) }))
            : undefined;
        return (
          <li key={i} className={`case-row case-${r.status}`}>
            <button
              className={`case-line ${toggle ? 'case-line-toggle' : ''}`}
              onClick={toggle}
              disabled={!toggle}
            >
              <span className="case-glyph">
                {r.status === 'passed' ? '✓' : r.status === 'failed' ? '✕' : '○'}
              </span>
              <span className="case-name">
                {r.suite && <span className="case-suite">{r.suite} › </span>}
                {r.name}
              </span>
              <span className="case-duration mono">{formatDuration(r.durationMs)}</span>
            </button>
            {expanded && <pre className="case-error">{r.error}</pre>}
          </li>
        );
      })}
    </ul>
  );
}
