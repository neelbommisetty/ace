import { categoryShortName } from '../lib/categories';
import type { Difficulty, QuestionStatus } from '../types';

export function CategoryChip({ category }: { category: string }) {
  return <span className="chip chip-category">{categoryShortName(category)}</span>;
}

export function DifficultyChip({ difficulty }: { difficulty: Difficulty }) {
  return <span className={`chip chip-difficulty chip-${difficulty}`}>{difficulty}</span>;
}

const STATUS_LABELS: Record<QuestionStatus, string> = {
  'not-started': 'not started',
  'in-progress': 'in progress',
  green: 'green',
};

export function StatusChip({ status }: { status: QuestionStatus }) {
  return <span className={`chip chip-status chip-status-${status}`}>{STATUS_LABELS[status]}</span>;
}
