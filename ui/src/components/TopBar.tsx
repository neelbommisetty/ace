import { formatClock } from '../lib/format';
import type { QuestionRow } from '../types';
import { CategoryChip, DifficultyChip } from './Chip';

export function TopBar({
  question,
  seconds,
  timerActive,
  running,
  onRun,
}: {
  question: QuestionRow;
  seconds: number;
  timerActive: boolean;
  running: boolean;
  /** Absent for design categories (no test files → no run). */
  onRun?: () => void;
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
        <span
          className={`timer ${timerActive ? '' : 'timer-paused'}`}
          title={timerActive ? 'Active time this attempt' : 'Paused — idle or tab hidden'}
        >
          {!timerActive && <span className="timer-pause-glyph">⏸</span>}
          {formatClock(seconds)}
        </span>
        {onRun && (
          <button className="btn btn-accent" onClick={onRun} title="Run tests (⌘/Ctrl+Enter)">
            {running && <span className="pulse-dot pulse-dot-on-accent" />}
            {running ? 'Running…' : 'Run'}
          </button>
        )}
      </div>
    </header>
  );
}
