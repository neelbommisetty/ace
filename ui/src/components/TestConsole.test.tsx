import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewConsoleEntry } from '../hooks/usePreviewConsole';
import { TestConsole, type RunDisplay } from './TestConsole';

const baseProps = {
  running: null,
  historyCount: 1,
  output: '',
  runError: null,
  autorun: false,
  onToggleAutorun: vi.fn(),
  formatBeforeRun: false,
  onToggleFormatBeforeRun: vi.fn(),
  onRun: vi.fn(),
  onStop: vi.fn(),
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

describe('TestConsole — Run/Stop button (NEE-295)', () => {
  it('shows "Run ⌘↩" and calls onRun when idle', () => {
    const onRun = vi.fn();
    const onStop = vi.fn();
    render(<TestConsole {...baseProps} onRun={onRun} onStop={onStop} lastRun={null} />);

    const btn = screen.getByText('Run ⌘↩');
    expect(screen.queryByText('Stop')).toBeNull();
    fireEvent.click(btn);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('flips to a destructive "Stop" button while a run is in flight, and calls onStop', () => {
    const onRun = vi.fn();
    const onStop = vi.fn();
    render(
      <TestConsole
        {...baseProps}
        running={{ runId: 'r1', trigger: 'manual' }}
        onRun={onRun}
        onStop={onStop}
        lastRun={null}
      />,
    );

    expect(screen.queryByText('Run ⌘↩')).toBeNull();
    const stopBtn = screen.getByText('Stop');
    expect(stopBtn.closest('button')).toHaveClass('btn-danger');
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe('TestConsole — Preview tab (NEE-351)', () => {
  function entry(overrides: Partial<PreviewConsoleEntry> = {}): PreviewConsoleEntry {
    return {
      id: 1,
      kind: 'console-log',
      text: 'hello from the preview',
      file: null,
      line: null,
      count: 1,
      at: Date.now(),
      ...overrides,
    };
  }

  it('is absent entirely for a non-react question (showPreviewTab=false, the default)', () => {
    renderConsole(null);
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('shows the tab (with no error badge) once a react-group question opts in, even with zero entries', () => {
    render(<TestConsole {...baseProps} lastRun={null} showPreviewTab />);
    expect(screen.getByText('Preview')).toBeTruthy();
    expect(document.querySelector('.preview-tab-badge')).toBeNull();
  });

  it('renders console-log/warn/error lines, attributed to Preview, when the tab is selected', () => {
    render(
      <TestConsole
        {...baseProps}
        lastRun={null}
        showPreviewTab
        previewEntries={[entry({ id: 1, kind: 'console-error', text: 'boom' })]}
      />,
    );
    fireEvent.click(screen.getByText('Preview'));
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getAllByText('Preview').length).toBeGreaterThan(1); // tab label + per-line attribution
  });

  it('shows a collapsed repeat count instead of one row per identical message', () => {
    render(
      <TestConsole
        {...baseProps}
        lastRun={null}
        showPreviewTab
        previewEntries={[entry({ id: 1, kind: 'console-error', text: 'infinite loop', count: 47 })]}
      />,
    );
    fireEvent.click(screen.getByText('Preview'));
    expect(screen.getByText('×47')).toBeTruthy();
    // one row, not 47
    expect(document.querySelectorAll('.preview-log-line')).toHaveLength(1);
  });

  it('maps a vite-error entry onto the same compile-error presentation as a vitest transform failure, with file/line', () => {
    render(
      <TestConsole
        {...baseProps}
        lastRun={null}
        showPreviewTab
        previewEntries={[
          entry({
            id: 1,
            kind: 'vite-error',
            text: 'Unexpected token',
            file: 'questions/react-apps/demo/App.tsx',
            line: 12,
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText('Preview'));
    expect(screen.getByText('✕ Compilation failed')).toBeTruthy();
    expect(screen.getByText(/App\.tsx:12/)).toBeTruthy();
    expect(screen.getByText(/Unexpected token/)).toBeTruthy();
  });

  it('badges the tab with the error count while a different tab is active', () => {
    render(
      <TestConsole
        {...baseProps}
        lastRun={null}
        showPreviewTab
        previewEntries={[
          entry({ id: 1, kind: 'console-log', text: 'routine log' }),
          entry({ id: 2, kind: 'console-error', text: 'err one' }),
          entry({ id: 3, kind: 'window-error', text: 'err two' }),
        ]}
      />,
    );
    expect(screen.getByText('2')).toBeTruthy(); // 2 error-shaped entries, 1 routine log excluded
  });

  it('never lets preview entries appear in — or evict — the Output tab’s run stream', () => {
    render(
      <TestConsole
        {...baseProps}
        lastRun={null}
        output="test run output line"
        showPreviewTab
        previewEntries={[entry({ id: 1, kind: 'console-error', text: 'preview-only text' })]}
      />,
    );
    fireEvent.click(screen.getByText('Output'));
    expect(screen.getByText('test run output line')).toBeTruthy();
    expect(screen.queryByText('preview-only text')).toBeNull();
  });
});
