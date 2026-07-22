import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings';
import type { SettingsInfo, WorkspaceInfo } from '../types';

const { getSettings, getWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getSettings, getWorkspace };
});

const SETTINGS_INFO: SettingsInfo = {
  openai: { configured: false, masked: null },
  anthropic: { configured: false, masked: null },
  defaultProvider: null,
  mockMode: false,
};

const WORKSPACE_INFO: WorkspaceInfo = {
  root: '/Users/neel/my-prep',
  questionsDir: '/Users/neel/my-prep/questions',
  version: '0.2.1',
  counts: { questions: 0, attempts: 0, testRuns: 0 },
  skippedDirs: [],
  legacyImport: { available: false, questionCount: 0 },
  activeAttempt: null,
  confirmName: 'my-prep',
};

function dangerButtons() {
  return {
    clear: screen.getByRole('button', { name: 'Clear progress…' }),
    reset: screen.getByRole('button', { name: 'Reset workspace…' }),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Settings danger zone', () => {
  it('renders both danger-zone cards once getWorkspace resolves', async () => {
    getSettings.mockResolvedValue(SETTINGS_INFO);
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await waitFor(() => expect(dangerButtons().clear).toBeEnabled());
    expect(screen.getByText('Clear progress')).toBeInTheDocument();
    expect(screen.getByText('Reset workspace')).toBeInTheDocument();
    expect(dangerButtons().reset).toBeEnabled();
  });

  it('gives the configured-key chip the solved status styling', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      openai: { configured: true, masked: 'sk-...abcd' },
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    const configured = await screen.findByText('sk-...abcd');
    expect(configured).toHaveClass('chip-status-solved');
    const notConfigured = screen.getByText('not configured');
    expect(notConfigured).toHaveClass('chip-status-not-attempted');
  });

  it('disables the danger buttons while workspace info is loading', () => {
    getSettings.mockResolvedValue(SETTINGS_INFO);
    getWorkspace.mockReturnValue(new Promise(() => {})); // never resolves
    render(<Settings />);

    const { clear, reset } = dangerButtons();
    expect(clear).toBeDisabled();
    expect(reset).toBeDisabled();
    expect(screen.getAllByText('loading workspace info…')).toHaveLength(2);
  });

  it('disables the danger buttons and shows a hint when the workspace fails to load', async () => {
    getSettings.mockResolvedValue(SETTINGS_INFO);
    getWorkspace.mockRejectedValue(new Error('boom'));
    render(<Settings />);

    await waitFor(() =>
      expect(screen.getAllByText('workspace info unavailable')).toHaveLength(2),
    );
    const { clear, reset } = dangerButtons();
    expect(clear).toBeDisabled();
    expect(reset).toBeDisabled();
  });

  it('clicking "Reset workspace…" opens the dialog with mode=full and the correct folder name', async () => {
    getSettings.mockResolvedValue(SETTINGS_INFO);
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await waitFor(() => expect(dangerButtons().reset).toBeEnabled());
    fireEvent.click(dangerButtons().reset);

    expect(screen.getByRole('heading', { name: 'Reset workspace?' })).toBeInTheDocument();
    expect(screen.getByText('my-prep')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-prep')).toBeInTheDocument();
  });

  it('clicking "Clear progress…" opens the dialog with mode=progress', async () => {
    getSettings.mockResolvedValue(SETTINGS_INFO);
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await waitFor(() => expect(dangerButtons().clear).toBeEnabled());
    fireEvent.click(dangerButtons().clear);

    expect(screen.getByRole('heading', { name: 'Clear progress?' })).toBeInTheDocument();
  });
});
