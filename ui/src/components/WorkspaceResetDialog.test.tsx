import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceResetDialog } from './WorkspaceResetDialog';
import { ApiError } from '../api';

const { armSuppressNextReset, disarmSuppressNextReset } = vi.hoisted(() => ({
  armSuppressNextReset: vi.fn(),
  disarmSuppressNextReset: vi.fn(),
}));

vi.mock('../lib/resetSuppress', () => ({ armSuppressNextReset, disarmSuppressNextReset }));

const { resetWorkspace } = vi.hoisted(() => ({ resetWorkspace: vi.fn() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, resetWorkspace };
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
});
