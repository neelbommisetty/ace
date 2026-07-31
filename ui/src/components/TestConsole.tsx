import { useEffect, useRef, useState } from 'react';
import { formatDuration, relTime } from '../lib/format';
import type { PreviewConsoleEntry } from '../hooks/usePreviewConsole';
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
  formatBeforeRun,
  onToggleFormatBeforeRun,
  onRun,
  onStop,
  onCollapse,
  onDispute,
  showPreviewTab = false,
  previewEntries = [],
}: {
  running: { runId: string; trigger: TestRunTrigger } | null;
  lastRun: RunDisplay | null;
  historyCount: number;
  output: string;
  runError: string | null;
  autorun: boolean;
  onToggleAutorun: () => void;
  /** 'ace-format-before-run' toggle (NEE-331): format dirty editable buffers
   * through the editor action before Run sees them. */
  formatBeforeRun: boolean;
  onToggleFormatBeforeRun: () => void;
  onRun: () => void;
  /** Stops the in-flight run (NEE-295). */
  onStop: () => void;
  onCollapse: () => void;
  /** Present when the shown run's failures can be disputed (status 'done'). */
  onDispute?: (testName: string) => void;
  /** NEE-351: only react-group questions (the ones with a preview pane at
   * all) get a Preview tab — everyone else's console is exactly what it was
   * before this ticket. */
  showPreviewTab?: boolean;
  /** Entries from usePreviewConsole — a SEPARATE array from `output`, so a
   * flooded preview channel can never starve test output for room. */
  previewEntries?: PreviewConsoleEntry[];
}) {
  const [tab, setTab] = useState<'results' | 'output' | 'preview'>('results');
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
          {showPreviewTab && (
            <button
              className={`pane-tab ${tab === 'preview' ? 'active' : ''}`}
              onClick={() => setTab('preview')}
            >
              Preview
              {previewErrorCount(previewEntries) > 0 && (
                <span className="preview-tab-badge">{previewErrorCount(previewEntries)}</span>
              )}
            </button>
          )}
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
            {/* dropped first at narrow widths (styles.css) — the checkbox (with
                its title tooltip) stays, so the setting is still reachable
                even once its label is hidden */}
            <span className="autorun-label">auto-run on save</span>
          </label>
          <label
            className="autorun-toggle"
            title="Format dirty files before Run (NEE-331) — never fires from the background autosave"
          >
            <input type="checkbox" checked={formatBeforeRun} onChange={onToggleFormatBeforeRun} />
            <span className="autorun-label">format before run</span>
          </label>
          {running ? (
            <button
              className="btn btn-small btn-danger"
              onClick={onStop}
              title="Stop the running test run"
            >
              Stop
            </button>
          ) : (
            <button
              className="btn btn-small btn-accent"
              onClick={onRun}
              title="Run tests (⌘/Ctrl+Enter)"
            >
              Run ⌘↩
            </button>
          )}
          <button className="icon-btn" onClick={onCollapse} title="Collapse console">
            ▾
          </button>
        </div>
      </div>
      <div className="console-body">
        {tab === 'results' && (
          <ResultsTab
            running={running}
            lastRun={lastRun}
            runError={runError}
            onDispute={onDispute}
          />
        )}
        {tab === 'output' && (
          <div className="output-tab">
            {(lastRun?.status === 'error' || lastRun?.status === 'compile-error') && !running && (
              <div className="run-error-block">
                <strong>{lastRun.status === 'compile-error' ? 'Compilation failed:' : 'Run failed:'}</strong>{' '}
                {lastRun.errorMessage ?? 'unknown error'}
              </div>
            )}
            {runError && <div className="run-error-block">{runError}</div>}
            <pre ref={outputRef} className="output-pre">
              {output || (running ? 'waiting for output…' : 'No output. Run tests to see the raw stream.')}
            </pre>
          </div>
        )}
        {tab === 'preview' && <PreviewTab entries={previewEntries} />}
      </div>
    </section>
  );
}

/** Kinds that read as an actual problem rather than routine console chatter
 * — drives the Preview tab's badge count. */
function isPreviewErrorKind(kind: PreviewConsoleEntry['kind']): boolean {
  return kind === 'console-error' || kind === 'window-error' || kind === 'unhandled-rejection' || kind === 'vite-error';
}

function previewErrorCount(entries: PreviewConsoleEntry[]): number {
  return entries.filter((e) => isPreviewErrorKind(e.kind)).length;
}

/**
 * Compile-error presentation shared between a vitest transform failure
 * (ResultsTab, below) and a Vite transform/syntax failure forwarded from the
 * preview iframe (NEE-351) — the same markup either way, so a TSX syntax
 * error looks identical whichever tool found it.
 */
function CompileErrorBanner({ text }: { text: string }) {
  return (
    <div className="results-banner results-banner-error compile-error-banner">
      <div className="compile-error-title">✕ Compilation failed</div>
      <pre className="compile-error-text">{text}</pre>
    </div>
  );
}

const PREVIEW_KIND_LABEL: Record<PreviewConsoleEntry['kind'], string> = {
  'console-log': 'log',
  'console-warn': 'warn',
  'console-error': 'error',
  'window-error': 'error',
  'unhandled-rejection': 'rejection',
  'vite-error': 'compile error',
  'rate-limited': 'throttled',
};

/** NEE-351: preview console/error entries — a Preview tab sharing this same
 * console component with test output rather than forking a second one.
 * Exported (NEE-387) so PreviewPane's console-mode variant (import-mode
 * categories like playground-ts, which have no TestConsole at all since
 * hasTests is false) can reuse the exact same rendering. */
export function PreviewTab({ entries }: { entries: PreviewConsoleEntry[] }) {
  if (entries.length === 0) {
    return <div className="pane-empty">No preview activity yet — console output and errors from the live preview will show up here.</div>;
  }
  return (
    <div className="results-tab preview-console">
      {entries.map((entry) => {
        if (entry.kind === 'vite-error') {
          const located = entry.file != null ? `${entry.file}${entry.line != null ? ':' + entry.line : ''}\n${entry.text}` : entry.text;
          return <CompileErrorBanner key={entry.id} text={located} />;
        }
        return (
          <div key={entry.id} className={`preview-log-line preview-log-${PREVIEW_KIND_LABEL[entry.kind]}`}>
            <span className="preview-log-source">Preview</span>
            <span className="preview-log-text">{entry.text}</span>
            {entry.count > 1 && <span className="preview-log-count">×{entry.count}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ResultsTab({
  running,
  lastRun,
  runError,
  onDispute,
}: {
  running: { runId: string; trigger: TestRunTrigger } | null;
  lastRun: RunDisplay | null;
  runError: string | null;
  onDispute?: (testName: string) => void;
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
          {lastRun.status === 'compile-error' && (
            <CompileErrorBanner text={lastRun.errorMessage ?? 'Unknown error — see Output for details.'} />
          )}
          {lastRun.status === 'cancelled' && (
            <div className="results-banner results-banner-dim">Run was cancelled.</div>
          )}
          {lastRun.status === 'done' &&
            lastRun.summary &&
            (lastRun.summary.total === 0 ? (
              <div className="results-summary summary-neutral">
                <span className="mono">no tests found</span>
                {' · '}
                {formatDuration(lastRun.summary.durationMs)}
                {' · '}
                {relTime(lastRun.at)}
              </div>
            ) : (
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
            ))}
          {lastRun.results && lastRun.results.length > 0 && (
            <CaseList
              key={lastRun.runId}
              results={lastRun.results}
              onDispute={!running && lastRun.status === 'done' ? onDispute : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}

function CaseList({
  results,
  onDispute,
}: {
  results: TestCaseResult[];
  onDispute?: (testName: string) => void;
}) {
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
            <div className="case-line-wrap">
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
              {r.status === 'failed' && onDispute != null && (
                <CaseKebab onDispute={() => onDispute(r.suite ? `${r.suite} › ${r.name}` : r.name)} />
              )}
            </div>
            {expanded && <pre className="case-error">{r.error}</pre>}
          </li>
        );
      })}
    </ul>
  );
}

function CaseKebab({ onDispute }: { onDispute: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current != null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="kebab" ref={ref}>
      <button className="icon-btn kebab-btn" onClick={() => setOpen((v) => !v)} title="Test actions">
        ⋮
      </button>
      {open && (
        <div className="kebab-menu">
          <button
            className="kebab-item"
            onClick={() => {
              setOpen(false);
              onDispute();
            }}
          >
            Dispute this failure…
          </button>
        </div>
      )}
    </div>
  );
}
