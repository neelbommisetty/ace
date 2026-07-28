import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { WorkspacePicker, WorkspaceSwitchDialog } from './WorkspacePicker';

const { getWorkspaceRecents, switchWorkspace } = vi.hoisted(() => ({
  getWorkspaceRecents: vi.fn(),
  switchWorkspace: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getWorkspaceRecents, switchWorkspace };
});

const RECENTS = [
  { root: '/Users/neel/my-prep', lastOpenedAt: new Date().toISOString() },
  { root: '/Users/neel/other-prep', lastOpenedAt: '2026-07-01T00:00:00.000Z' },
];

let originalLocation: Location | undefined;

function stubLocationReload() {
  originalLocation = window.location;
  const reloadSpy = vi.fn();
  // @ts-expect-error -- happy-dom allows redefining location for the test
  delete window.location;
  // @ts-expect-error -- minimal stub carrying the spy
  window.location = { ...originalLocation, reload: reloadSpy };
  return { reloadSpy };
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalLocation != null) {
    // @ts-expect-error -- restoring the real Location object stubbed above
    window.location = originalLocation;
    originalLocation = undefined;
  }
});

describe('WorkspacePicker (full-screen, unmounted boot)', () => {
  it('lists recents with basename prominent and full path visible, and switches on click', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: RECENTS });
    switchWorkspace.mockReturnValue(new Promise(() => {})); // stays busy
    render(<WorkspacePicker />);

    expect(await screen.findByText('my-prep')).toBeInTheDocument();
    expect(screen.getByText('/Users/neel/my-prep')).toBeInTheDocument();
    expect(screen.getByText('other-prep')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('/Users/neel/my-prep'));
    expect(switchWorkspace).toHaveBeenCalledTimes(1);
    const [root, requestId] = switchWorkspace.mock.calls[0] as [string, string];
    expect(root).toBe('/Users/neel/my-prep');
    expect(typeof requestId).toBe('string');
  });

  it('shows the empty-state hint when there are no recents', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: [] });
    render(<WorkspacePicker />);
    expect(await screen.findByText(/No recent workspaces yet/)).toBeInTheDocument();
  });

  it('switches to a typed path via the free input', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: [] });
    switchWorkspace.mockReturnValue(new Promise(() => {}));
    render(<WorkspacePicker />);
    await screen.findByText(/No recent workspaces yet/);

    const input = screen.getByPlaceholderText('/path/to/workspace');
    const openButton = screen.getByRole('button', { name: 'Open' });
    expect(openButton).toBeDisabled();

    fireEvent.change(input, { target: { value: '  /tmp/typed-ws  ' } });
    expect(openButton).toBeEnabled();
    fireEvent.click(openButton);

    expect(switchWorkspace).toHaveBeenCalledWith('/tmp/typed-ws', expect.any(String));
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
  });

  it('reloads the page after a successful switch', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: RECENTS });
    switchWorkspace.mockResolvedValue({
      workspaceRoot: '/Users/neel/my-prep',
      epoch: 'epoch-b',
      workspace: {} as never,
    });
    const { reloadSpy } = stubLocationReload();
    render(<WorkspacePicker />);

    fireEvent.click(await screen.findByTitle('/Users/neel/my-prep'));
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  });

  it('renders the server error inline on a 400/409 rejection', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: [] });
    switchWorkspace.mockRejectedValue(
      new ApiError(400, 'no questions/ directory found at /tmp/nope — run `ace init` there first'),
    );
    render(<WorkspacePicker />);
    await screen.findByText(/No recent workspaces yet/);

    fireEvent.change(screen.getByPlaceholderText('/path/to/workspace'), {
      target: { value: '/tmp/nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(
      await screen.findByText(
        'no questions/ directory found at /tmp/nope — run `ace init` there first',
      ),
    ).toBeInTheDocument();
    // The form is usable again after the error.
    expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled();
  });
});

describe('WorkspaceSwitchDialog', () => {
  it('marks the current workspace, and a same-root 200 closes the dialog instead of reloading', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: RECENTS });
    switchWorkspace.mockResolvedValue({
      workspaceRoot: '/Users/neel/my-prep',
      epoch: 'epoch-a',
      workspace: {} as never,
    });
    const onClose = vi.fn();
    const { reloadSpy } = stubLocationReload();
    render(<WorkspaceSwitchDialog currentRoot="/Users/neel/my-prep" onClose={onClose} />);

    expect(await screen.findByText('current')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('/Users/neel/my-prep'));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('closes on backdrop mousedown and the ✕ button', async () => {
    getWorkspaceRecents.mockResolvedValue({ recents: [] });
    const onClose = vi.fn();
    render(<WorkspaceSwitchDialog currentRoot="/w" onClose={onClose} />);
    await screen.findByText(/No recent workspaces yet/);

    fireEvent.mouseDown(document.querySelector('.modal-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
