import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TestConsole, type RunDisplay } from './TestConsole';

const baseProps = {
  running: null,
  historyCount: 1,
  output: '',
  runError: null,
  autorun: false,
  onToggleAutorun: vi.fn(),
  onRun: vi.fn(),
  onCollapse: vi.fn(),
};

function renderConsole(lastRun: RunDisplay | null) {
  return render(<TestConsole {...baseProps} lastRun={lastRun} />);
}

describe('TestConsole — compile-error and no-tests states (NEE-332)', () => {
  it('renders a compile-failure banner instead of a green "0/0 passed" summary', () => {
    renderConsole({
      runId: 'r1',
      at: new Date().toISOString(),
      status: 'compile-error',
      summary: null,
      results: null,
      errorMessage: "SyntaxError: Unexpected token (solution.ts:12:3)",
    });

    expect(screen.getByText('✕ Compilation failed')).toBeTruthy();
    expect(screen.getByText(/Unexpected token/)).toBeTruthy();
    expect(screen.queryByText(/passed/)).toBeNull();
    // nothing green: no summary-pass node anywhere
    expect(document.querySelector('.summary-pass')).toBeNull();
  });

  it('renders a neutral "no tests found" state for a genuinely empty, successfully-compiled suite', () => {
    renderConsole({
      runId: 'r2',
      at: new Date().toISOString(),
      status: 'done',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 12 },
      results: [],
      errorMessage: null,
    });

    expect(screen.getByText('no tests found')).toBeTruthy();
    expect(document.querySelector('.summary-pass')).toBeNull();
    expect(document.querySelector('.summary-neutral')).not.toBeNull();
  });

  it('still renders a green summary for a real all-passing run', () => {
    renderConsole({
      runId: 'r3',
      at: new Date().toISOString(),
      status: 'done',
      summary: { total: 3, passed: 3, failed: 0, skipped: 0, durationMs: 12 },
      results: [],
      errorMessage: null,
    });

    expect(screen.getByText('3/3')).toBeTruthy();
    expect(document.querySelector('.summary-pass')).not.toBeNull();
  });

  it('still renders a red summary for a real run with failures', () => {
    renderConsole({
      runId: 'r4',
      at: new Date().toISOString(),
      status: 'done',
      summary: { total: 3, passed: 2, failed: 1, skipped: 0, durationMs: 12 },
      results: [],
      errorMessage: null,
    });

    expect(screen.getByText('2/3')).toBeTruthy();
    expect(document.querySelector('.summary-fail')).not.toBeNull();
    expect(document.querySelector('.summary-pass')).toBeNull();
  });
});
