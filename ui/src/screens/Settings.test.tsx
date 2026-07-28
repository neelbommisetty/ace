import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings';
import type { SettingsInfo, WorkspaceInfo } from '../types';

const { getSettings, getWorkspace, putSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getWorkspace: vi.fn(),
  putSettings: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getSettings, getWorkspace, putSettings };
});

const SETTINGS_INFO: SettingsInfo = {
  openai: { configured: false, masked: null, baseUrl: null },
  anthropic: { configured: false, masked: null, baseUrl: null },
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
      openai: { configured: true, masked: 'sk-...abcd', baseUrl: null },
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

/**
 * The server validates the effective (key, base URL) pair on any change, so
 * these must travel in one patch — see the deadlock note in Settings.tsx.
 */
describe('Settings provider card', () => {
  /** The OpenAI card's inputs and its single Save button. */
  async function openaiCard(info: SettingsInfo = SETTINGS_INFO) {
    getSettings.mockResolvedValue(info);
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByRole('heading', { name: 'OpenAI' });
    return {
      key: screen.getAllByPlaceholderText(
        info.openai.configured ? 'paste a new key to replace' : 'paste your API key',
      )[0],
      baseUrl: screen.getAllByPlaceholderText('Base URL (optional)')[0],
      save: screen.getAllByRole('button', { name: 'Save' })[0],
    };
  }

  it('sends a changed key and base URL as a single combined patch', async () => {
    putSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      openai: { configured: true, masked: 'sk-...ocal', baseUrl: 'http://localhost:4242/v1' },
    });
    const card = await openaiCard();

    fireEvent.change(card.key, { target: { value: 'sk-local-abc' } });
    fireEvent.change(card.baseUrl, { target: { value: 'http://localhost:4242/v1' } });
    fireEvent.click(card.save);

    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith({
      openaiKey: 'sk-local-abc',
      openaiBaseUrl: 'http://localhost:4242/v1',
    });
    await screen.findByText('✓ saved');
  });

  it('omits the untouched field from the patch', async () => {
    putSettings.mockResolvedValue(SETTINGS_INFO);
    const card = await openaiCard();

    fireEvent.change(card.key, { target: { value: 'sk-vendor' } });
    fireEvent.click(card.save);

    await waitFor(() => expect(putSettings).toHaveBeenCalledWith({ openaiKey: 'sk-vendor' }));
  });

  it('clears the base URL with null while leaving a blank key alone', async () => {
    const configured: SettingsInfo = {
      ...SETTINGS_INFO,
      openai: { configured: true, masked: 'sk-...ocal', baseUrl: 'http://localhost:4242/v1' },
    };
    putSettings.mockResolvedValue(SETTINGS_INFO);
    const card = await openaiCard(configured);

    expect(card.baseUrl).toHaveValue('http://localhost:4242/v1');
    fireEvent.change(card.baseUrl, { target: { value: '' } });
    fireEvent.click(card.save);

    await waitFor(() => expect(putSettings).toHaveBeenCalledWith({ openaiBaseUrl: null }));
  });

  it('disables Save until something is dirty, and surfaces a failed validation', async () => {
    putSettings.mockRejectedValue(new Error('OpenAI key validation failed: 401 from https://api.openai.com/v1'));
    const card = await openaiCard();

    expect(card.save).toBeDisabled();
    fireEvent.change(card.key, { target: { value: 'sk-bad' } });
    expect(card.save).toBeEnabled();
    fireEvent.click(card.save);

    await screen.findByText('OpenAI key validation failed: 401 from https://api.openai.com/v1');
    expect(card.save).toBeEnabled();
  });

  it('saves from Enter in either input', async () => {
    putSettings.mockResolvedValue(SETTINGS_INFO);
    const card = await openaiCard();

    fireEvent.change(card.baseUrl, { target: { value: 'http://localhost:4242/v1' } });
    fireEvent.keyDown(card.baseUrl, { key: 'Enter' });
    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));

    fireEvent.change(card.key, { target: { value: 'sk-x' } });
    fireEvent.keyDown(card.key, { key: 'Enter' });
    await waitFor(() => expect(putSettings).toHaveBeenCalledTimes(2));
  });
});
