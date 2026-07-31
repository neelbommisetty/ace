import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewPane } from './PreviewPane';
import type { PreviewConsoleEntry } from '../hooks/usePreviewConsole';
import type { PreviewStatus } from '../types';

const READY: PreviewStatus = { state: 'ready', url: 'http://127.0.0.1:5199', reason: null };
const STARTING: PreviewStatus = { state: 'starting', url: null, reason: null };
const FAILED: PreviewStatus = { state: 'failed', url: null, reason: 'vite is not installed' };
const STOPPED: PreviewStatus = { state: 'stopped', url: null, reason: null };

const baseProps = {
  category: 'react-apps',
  slug: 'todo-app',
  onRetry: vi.fn(),
  flushSaves: vi.fn().mockResolvedValue(undefined),
  onCollapse: vi.fn(),
};

describe('PreviewPane (NEE-349)', () => {
  it('renders the iframe pointed at the workspace dev server URL for the current question', () => {
    render(<PreviewPane {...baseProps} status={READY} />);
    const frame = screen.getByTitle('Live preview');
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:5199/preview/react-apps/todo-app/');
  });

  it('shows a "starting" notice instead of a blank rectangle', () => {
    render(<PreviewPane {...baseProps} status={STARTING} />);
    expect(screen.getByText(/starting the preview server/)).toBeInTheDocument();
    expect(screen.queryByTitle('Live preview')).toBeNull();
  });

  it('shows the failure reason and calls onRetry from the Retry button', () => {
    const onRetry = vi.fn();
    render(<PreviewPane {...baseProps} status={FAILED} onRetry={onRetry} />);
    expect(screen.getByText('Preview failed to start')).toBeInTheDocument();
    expect(screen.getByText('vite is not installed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a stopped notice with a Start-preview affordance wired to onRetry', () => {
    const onRetry = vi.fn();
    render(<PreviewPane {...baseProps} status={STOPPED} onRetry={onRetry} />);
    expect(screen.getByText('Preview server is stopped.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start preview' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables reload/open-in-tab controls until the preview is ready', () => {
    render(<PreviewPane {...baseProps} status={STARTING} />);
    expect(screen.getByTitle('Reload the preview (flushes unsaved edits first)')).toBeDisabled();
    expect(screen.getByTitle('Open the preview in a new tab')).toBeDisabled();
  });

  it('flushes pending saves before reloading the iframe', async () => {
    const flushSaves = vi.fn().mockResolvedValue(undefined);
    render(<PreviewPane {...baseProps} status={READY} flushSaves={flushSaves} />);
    fireEvent.click(screen.getByTitle('Reload the preview (flushes unsaved edits first)'));
    expect(flushSaves).toHaveBeenCalledTimes(1);
  });

  it('opens the preview page in a new tab via window.open', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<PreviewPane {...baseProps} status={READY} />);
    fireEvent.click(screen.getByTitle('Open the preview in a new tab'));
    expect(openSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:5199/preview/react-apps/todo-app/',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('toggles the viewport emulation width (mobile/tablet/full)', () => {
    render(<PreviewPane {...baseProps} status={READY} />);
    const frame = screen.getByTitle('Live preview');
    expect(frame).not.toHaveAttribute('style');

    fireEvent.click(screen.getByTitle('Mobile width'));
    expect(frame).toHaveStyle({ width: '390px' });

    fireEvent.click(screen.getByTitle('Tablet width'));
    expect(frame).toHaveStyle({ width: '834px' });

    fireEvent.click(screen.getByTitle('Full width'));
    expect(frame.getAttribute('style') ?? '').not.toContain('width');
  });

  it('calls onCollapse from the collapse control', () => {
    const onCollapse = vi.fn();
    render(<PreviewPane {...baseProps} status={READY} onCollapse={onCollapse} />);
    fireEvent.click(screen.getByTitle('Collapse preview pane'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('does not remount the iframe across a re-render with the same category/slug (no HMR-fighting reload loop)', () => {
    const { rerender } = render(<PreviewPane {...baseProps} status={READY} />);
    const frame = screen.getByTitle('Live preview');
    rerender(<PreviewPane {...baseProps} status={READY} flushSaves={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByTitle('Live preview')).toBe(frame);
  });
});

const CONSOLE_ENTRIES: PreviewConsoleEntry[] = [
  { id: 1, kind: 'console-log', text: 'hello from the console', file: null, line: null, count: 1, at: 0 },
];

describe('PreviewPane console mode (NEE-387)', () => {
  it('renders a "Console" header, PreviewTab entries, Re-run, and Clear — no viewport toggle', () => {
    const onClearConsole = vi.fn();
    render(
      <PreviewPane
        {...baseProps}
        status={READY}
        mode="import"
        consoleEntries={CONSOLE_ENTRIES}
        onClearConsole={onClearConsole}
      />,
    );

    expect(screen.getByText('Console')).toBeInTheDocument();
    expect(screen.getByText('hello from the console')).toBeInTheDocument();
    expect(screen.queryByTitle('Mobile width')).toBeNull();
    expect(screen.getByTitle('Re-run (reloads the sandbox)')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Clear console'));
    expect(onClearConsole).toHaveBeenCalledTimes(1);
  });

  it('keeps the iframe mounted (it executes the code) but visually hidden', () => {
    render(<PreviewPane {...baseProps} status={READY} mode="import" consoleEntries={[]} />);
    const frame = screen.getByTitle('Live preview');
    expect(frame).toHaveClass('preview-frame-hidden');
  });

  it('keeps the iframe stable across consoleEntries prop updates (key stability)', () => {
    const { rerender } = render(
      <PreviewPane {...baseProps} status={READY} mode="import" consoleEntries={[]} />,
    );
    const frame = screen.getByTitle('Live preview');
    rerender(<PreviewPane {...baseProps} status={READY} mode="import" consoleEntries={CONSOLE_ENTRIES} />);
    expect(screen.getByTitle('Live preview')).toBe(frame);
  });

  it('defaults to the original mount rendering when mode is omitted (regression pin for the new optional props)', () => {
    render(<PreviewPane {...baseProps} status={READY} />);
    const frame = screen.getByTitle('Live preview');
    expect(frame).not.toHaveClass('preview-frame-hidden');
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByTitle('Mobile width')).toBeInTheDocument();
  });
});
