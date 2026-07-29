import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceResetDialog } from './WorkspaceResetDialog';
import { ApiError } from '../api';

const { armSuppressNextReset, disarmSuppressNextReset } = vi.hoisted(() => ({
  armSuppressNextReset: vi.fn(),
  disarmSuppressNextReset: vi.fn(),
}));

vi.mock('../lib/resetSuppress', () => ({ armSuppressNextReset, disarmSuppressNextReset }));

const { resetWorkspace, getResetPreview } = vi.hoisted(() => ({
  resetWorkspace: vi.fn(),
  // Every test below is 'full' or 'progress' with no at-risk prose by
  // default — individual tests override this to exercise the concrete
  // at-risk wording.
  getResetPreview: vi.fn().mockResolvedValue({ atRiskProse: [] }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, resetWorkspace, getResetPreview };
});

const FOLDER = 'my-prep';

function confirmButton() {
  return screen.getByRole('button', { name: /clear progress|reset workspace/i });
}

function input() {
  return screen.getByPlaceholderText(FOLDER);
}

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('WorkspaceResetDialog', () => {
  it('disables the destructive button until the typed input exactly matches the folder name', () => {
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(input(), { target: { value: 'My-Prep' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(input(), { target: { value: `${FOLDER} ` } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(input(), { target: { value: FOLDER } });
    expect(confirmButton()).toBeEnabled();
  });

  it('shows "Archiving…" and disables cancel while busy, and blocks overlay dismiss', () => {
    let resolvePromise: (v: unknown) => void = () => {};
    resetWorkspace.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );
    const onClose = vi.fn();
    render(<WorkspaceResetDialog mode="full" folderName={FOLDER} onClose={onClose} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());

    expect(screen.getByText('Archiving…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    const overlay = document.querySelector('.modal-overlay')!;
    fireEvent.mouseDown(overlay);
    expect(onClose).not.toHaveBeenCalled();

    resolvePromise({
      mode: 'full',
      archivedTo: '/tmp/.ace-archive-2026-07-20',
      restored: { questions: 3, files: 6 },
      workspace: {} as never,
    });
  });

  it('arms the shared suppress flag (keyed by request id) before the request, and disarms it if the request fails', async () => {
    resetWorkspace.mockRejectedValue(new ApiError(409, 'a test run is in progress — wait for it to finish and try again'));
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());

    // Armed synchronously, before resetWorkspace's promise settles, with a
    // freshly generated request id — and that same id is what's passed to
    // resetWorkspace() so the server can echo it back in its broadcast.
    expect(armSuppressNextReset).toHaveBeenCalledTimes(1);
    const requestId = armSuppressNextReset.mock.calls[0][0];
    expect(typeof requestId).toBe('string');
    expect(resetWorkspace).toHaveBeenCalledWith('progress', FOLDER, requestId);

    await screen.findByText('a test run is in progress — wait for it to finish and try again');

    // The request failed, so no reset actually happened — the armed id must
    // not be left standing for some unrelated future reset broadcast.
    expect(disarmSuppressNextReset).toHaveBeenCalledWith(requestId);
  });

  it('renders the server message verbatim on a 409 rejection and re-enables the form', async () => {
    resetWorkspace.mockRejectedValue(new ApiError(409, 'a test run is in progress — wait for it to finish and try again'));
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());

    expect(
      await screen.findByText('a test run is in progress — wait for it to finish and try again'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(input()).toHaveValue('');
    expect(confirmButton()).toBeDisabled();
  });

  it('renders the archive path (and restored count for full mode) on success', async () => {
    resetWorkspace.mockResolvedValue({
      mode: 'full',
      archivedTo: '/workspace/.ace-archive-2026-07-20',
      restored: { questions: 4, files: 9 },
      workspace: {} as never,
    });
    render(<WorkspaceResetDialog mode="full" folderName={FOLDER} onClose={vi.fn()} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());

    expect(await screen.findByText('/workspace/.ace-archive-2026-07-20')).toBeInTheDocument();
    expect(screen.getByText(/4\s+questions were reset/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Library' })).toBeInTheDocument();
  });

  it('does not show a restored count for progress mode', async () => {
    resetWorkspace.mockResolvedValue({
      mode: 'progress',
      archivedTo: '/workspace/.ace-archive-2026-07-20',
      restored: { questions: 4, files: 0 },
      workspace: {} as never,
    });
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());

    expect(await screen.findByText('/workspace/.ace-archive-2026-07-20')).toBeInTheDocument();
    expect(screen.queryByText(/questions were reset/)).not.toBeInTheDocument();
  });

  it('"Go to Library" navigates to /', async () => {
    resetWorkspace.mockResolvedValue({
      mode: 'progress',
      archivedTo: '/workspace/.ace-archive-2026-07-20',
      restored: { questions: 0, files: 0 },
      workspace: {} as never,
    });
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());

    const goBtn = await screen.findByRole('button', { name: 'Go to Library' });

    const original = window.location;
    const replaceSpy = vi.fn();
    // @ts-expect-error -- happy-dom allows redefining location for the test
    delete window.location;
    // @ts-expect-error -- stub with a minimal object carrying the spy
    window.location = { ...original, replace: replaceSpy };

    fireEvent.click(goBtn);

    expect(replaceSpy).toHaveBeenCalledWith('/');

    // @ts-expect-error -- restoring the real Location object stubbed above
    window.location = original;
  });

  it('has dialog semantics labelled by its heading', () => {
    render(<WorkspaceResetDialog mode="full" folderName={FOLDER} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Reset workspace?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('focuses the confirmation input on mount', () => {
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);
    expect(input()).toHaveFocus();
  });

  it('restores focus to the invoking element on close (unmount)', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Reset workspace';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />,
    );
    expect(trigger).not.toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('closes on Escape while idle', () => {
    const onClose = vi.fn();
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape while busy (request in flight)', () => {
    resetWorkspace.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<WorkspaceResetDialog mode="full" folderName={FOLDER} onClose={onClose} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());
    expect(screen.getByText('Archiving…')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on Escape once done (only "Go to Library" exits)', async () => {
    resetWorkspace.mockResolvedValue({
      mode: 'progress',
      archivedTo: '/workspace/.ace-archive-2026-07-20',
      restored: { questions: 0, files: 0 },
      workspace: {} as never,
    });
    const onClose = vi.fn();
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={onClose} />);

    fireEvent.change(input(), { target: { value: FOLDER } });
    fireEvent.click(confirmButton());
    await screen.findByRole('button', { name: 'Go to Library' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  // NEE-363: the dialog names what prose is actually at risk, in words —
  // "2 stories and 1 design answer", not the old generic "solution files
  // are reset to scaffold" line.
  it('names at-risk prose files by title, with a concrete count summary (full mode)', async () => {
    getResetPreview.mockResolvedValue({
      atRiskProse: [
        { category: 'behavioral', slug: 'a', title: 'A Time I Disagreed', relPath: 'a' },
        { category: 'behavioral', slug: 'b', title: 'A Time I Failed', relPath: 'b' },
        { category: 'design-fe', slug: 'c', title: 'Infinite Scroll', relPath: 'c' },
      ],
    });
    render(<WorkspaceResetDialog mode="full" folderName={FOLDER} onClose={vi.fn()} />);

    expect(await screen.findByText(/2 stories and 1 design answer/)).toBeInTheDocument();
    expect(screen.getByText('A Time I Disagreed')).toBeInTheDocument();
    expect(screen.getByText('A Time I Failed')).toBeInTheDocument();
    expect(screen.getByText('Infinite Scroll')).toBeInTheDocument();
  });

  it('shows no at-risk section when nothing differs from scaffold (full mode)', async () => {
    getResetPreview.mockResolvedValue({ atRiskProse: [] });
    render(<WorkspaceResetDialog mode="full" folderName={FOLDER} onClose={vi.fn()} />);

    // Let the preview fetch settle before asserting its absence.
    await Promise.resolve();
    expect(screen.queryByText(/will be reset to their original/)).not.toBeInTheDocument();
  });

  it('never fetches the reset preview in progress mode (solution files are never touched)', async () => {
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);
    await Promise.resolve();
    expect(getResetPreview).not.toHaveBeenCalled();
  });

  it('traps Tab within the dialog (first <-> last wrap)', () => {
    render(<WorkspaceResetDialog mode="progress" folderName={FOLDER} onClose={vi.fn()} />);
    const closeBtn = screen.getByTitle('Close');
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });

    // The confirm button is disabled (input doesn't match yet) so it's
    // excluded from the focusable set — Cancel is the last stop.
    closeBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(cancelBtn).toHaveFocus();

    cancelBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeBtn).toHaveFocus();
  });
});
