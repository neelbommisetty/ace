import { formatClock } from '../lib/format';
import type { QuestionRow } from '../types';
import { CategoryChip, DifficultyChip } from './Chip';

export function TopBar({
  question,
  seconds,
  timerActive,
  running,
  readonly,
  onRun,
  onStop,
  onFreshAttempt,
}: {
  question: QuestionRow;
  seconds: number;
  timerActive: boolean;
  running: boolean;
  /** Solved question opened as a read-only reference — hides the timer. */
  readonly?: boolean;
  /** Absent for design categories (no test files → no run) or in readonly mode. */
  onRun?: () => void;
  /** Stops the in-flight run (NEE-295). Present whenever onRun is. */
  onStop?: () => void;
  onFreshAttempt?: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="topbar-title" title={`${question.category}/${question.slug}`}>
          {question.title}
        </h1>
        <CategoryChip category={question.category} />
        <DifficultyChip difficulty={question.difficulty} />
        <span className="topbar-suggested" title="Suggested time">
          ~{question.suggestedMinutes}m
        </span>
      </div>
      <div className="topbar-right">
        {onFreshAttempt && (
          <button
            className="btn btn-small"
            onClick={onFreshAttempt}
            title="End this attempt and start a fresh one (code is snapshotted)"
          >
            ↺ New attempt
          </button>
        )}
        {!readonly && (
          <span
            className={`timer ${timerActive ? '' : 'timer-paused'}`}
            title={timerActive ? 'Active time this attempt' : 'Paused — idle or tab hidden'}
          >
            {!timerActive && <span className="timer-pause-glyph">⏸</span>}
            {formatClock(seconds)}
          </span>
        )}
        {onRun &&
          (running ? (
            <button className="btn btn-danger" onClick={onStop} title="Stop the running test run">
              <span className="pulse-dot pulse-dot-on-accent" />
              Stop
            </button>
          ) : (
            <button className="btn btn-accent" onClick={onRun} title="Run tests (⌘/Ctrl+Enter)">
              Run
            </button>
          ))}
      </div>
    </header>
  );
}
