import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { QuestionRow } from '../types';
import { TopBar } from './TopBar';

const question: QuestionRow = {
  id: 'q1',
  category: 'js-ts',
  slug: 'two-sum',
  title: 'Two Sum',
  difficulty: 'easy',
  suggestedMinutes: 15,
  dirPath: '/ws/questions/js-ts/two-sum',
  source: 'manual',
  createdAt: new Date().toISOString(),
  archivedAt: null,
  missingAt: null,
};

describe('TopBar — Run/Stop button (NEE-295)', () => {
  it('renders "Run" and calls onRun when idle', () => {
    const onRun = vi.fn();
    const onStop = vi.fn();
    render(
      <TopBar
        question={question}
        seconds={0}
        timerActive
        running={false}
        onRun={onRun}
        onStop={onStop}
      />,
    );

    expect(screen.queryByText('Stop')).toBeNull();
    fireEvent.click(screen.getByText('Run'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('flips to a destructive "Stop" button while running, and calls onStop', () => {
    const onRun = vi.fn();
    const onStop = vi.fn();
    render(
      <TopBar
        question={question}
        seconds={0}
        timerActive
        running
        onRun={onRun}
        onStop={onStop}
      />,
    );

    expect(screen.queryByText('Run')).toBeNull();
    const stopBtn = screen.getByText('Stop');
    expect(stopBtn.closest('button')).toHaveClass('btn-danger');
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('renders no run/stop button at all when onRun is absent (design categories / readonly)', () => {
    render(<TopBar question={question} seconds={0} timerActive running={false} />);
    expect(screen.queryByText('Run')).toBeNull();
    expect(screen.queryByText('Stop')).toBeNull();
  });
});
