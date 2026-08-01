import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings';
import { SLOT_ORDER } from '../lib/models';
import type { LLMSlot, ResolvedModel, SettingsInfo, SlotInfo, WorkspaceInfo } from '../types';

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
  models: null,
  availableModels: [],
};

/** Every slot defaulted to the same route, with per-slot overrides for the cases a test cares about. */
function makeModels(
  overrides: Partial<Record<LLMSlot, SlotInfo>> = {},
): Record<LLMSlot, SlotInfo> {
  const base = {} as Record<LLMSlot, SlotInfo>;
  for (const slot of SLOT_ORDER) {
    base[slot] = {
      route: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        source: 'default',
        defaultModel: 'claude-sonnet-5',
      },
      override: null,
      warning: null,
    };
  }
  return { ...base, ...overrides };
}

const AVAILABLE_MODELS: ResolvedModel[] = [
  { provider: 'openai', model: 'gpt-5.6-sol' },
  { provider: 'openai', model: 'gpt-5.6-terra' },
  { provider: 'openai', model: 'gpt-5.6-luna' },
  { provider: 'anthropic', model: 'claude-opus-5' },
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  { provider: 'anthropic', model: 'claude-fable-5' },
  { provider: 'anthropic', model: 'claude-opus-4-8' },
  { provider: 'anthropic', model: 'claude-opus-4-6' },
];

/** The `<li>` row for a slot, found by its label text. */
function slotRow(label: string): HTMLElement {
  const el = screen.getByText(label).closest('li');
  if (!el) throw new Error(`no <li> ancestor for slot label ${JSON.stringify(label)}`);
  return el;
}

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
    // Routing is per-slot now (NEE-40x) — the old single "Default provider"
    // picker is gone from the UI even though the wire field is kept.
    expect(screen.queryByText('Default provider')).not.toBeInTheDocument();
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

describe('Settings models section', () => {
  it('shows the add-a-key hint and no groups when models is null (keyless)', async () => {
    getSettings.mockResolvedValue(SETTINGS_INFO);
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Add an API key above to resolve models.');
    expect(screen.queryByText('Generation pipeline')).not.toBeInTheDocument();
  });

  it('renders the three grouped headings with a select per slot defaulting to the resolved model', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels(),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Generation pipeline');
    expect(screen.getByText('Practice room')).toBeInTheDocument();
    expect(screen.getByText('Creation')).toBeInTheDocument();

    const select = within(slotRow('Draft the problem')).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('claude-sonnet-5');
  });

  it('PUTs a model override on select change and replaces settings from the response', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels(),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    putSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        'draft-problem': {
          route: {
            provider: 'openai',
            model: 'gpt-5.6-terra',
            source: 'override',
            defaultModel: 'claude-sonnet-5',
          },
          override: 'gpt-5.6-terra',
          warning: null,
        },
      }),
      availableModels: AVAILABLE_MODELS,
    });
    render(<Settings />);

    await screen.findByText('Draft the problem');
    const select = within(slotRow('Draft the problem')).getByRole('combobox');
    fireEvent.change(select, { target: { value: 'gpt-5.6-terra' } });

    await waitFor(() =>
      expect(putSettings).toHaveBeenCalledWith({ models: { 'draft-problem': 'gpt-5.6-terra' } }),
    );
    await within(slotRow('Draft the problem')).findByText('reset to default');
  });

  it('shows "reset to default" for an overridden slot and PUTs null on click', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        'draft-problem': {
          route: {
            provider: 'openai',
            model: 'gpt-5.6-terra',
            source: 'override',
            defaultModel: 'claude-sonnet-5',
          },
          override: 'gpt-5.6-terra',
          warning: null,
        },
      }),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    putSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels(),
      availableModels: AVAILABLE_MODELS,
    });
    render(<Settings />);

    await screen.findByText('Draft the problem');
    fireEvent.click(within(slotRow('Draft the problem')).getByText('reset to default'));

    await waitFor(() =>
      expect(putSettings).toHaveBeenCalledWith({ models: { 'draft-problem': null } }),
    );
  });

  it('shows a dim note naming the missing provider for a provider-fallback slot', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        'author-solution': {
          route: {
            provider: 'openai',
            model: 'gpt-5.6-sol',
            source: 'provider-fallback',
            defaultModel: 'claude-opus-4-8',
          },
          override: null,
          warning: null,
        },
      }),
      availableModels: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Author the solution');
    expect(
      within(slotRow('Author the solution')).getByText('no Anthropic key — using gpt-5.6-sol'),
    ).toBeInTheDocument();
  });

  it('renders an error-note when a slot carries a non-null warning', async () => {
    const warning = '"bogus-model" is not a model ace can route to — using the default instead.';
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        calibrate: {
          route: {
            provider: 'openai',
            model: 'gpt-5.6-luna',
            source: 'default',
            defaultModel: 'gpt-5.6-luna',
          },
          override: null,
          warning,
        },
      }),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Time & complexity check');
    expect(within(slotRow('Time & complexity check')).getByText(warning)).toHaveClass('error-note');
  });

  it('renders "not available" with no select for a slot with no route', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        'review-escalated': { route: null, override: null, warning: null },
      }),
      availableModels: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Re-review (escalated)');
    const row = slotRow('Re-review (escalated)');
    expect(within(row).getByText('not available')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
  });

  // A saved override outlives the route it produced: it can lose its key, or
  // latch off claude-fable-5, and in both cases `source` is no longer
  // 'override'. Gating the reset control on `source` stranded the dead entry
  // in ~/.ace/config.json with no way to clear it from here.
  it('offers "reset to default" for a saved override that could not be honored', async () => {
    const warning = 'no openai API key — the saved "gpt-5.6-sol" choice cannot run.';
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        review: {
          route: {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            source: 'default',
            defaultModel: 'claude-sonnet-5',
          },
          override: 'gpt-5.6-sol',
          warning,
        },
      }),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    putSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels(),
      availableModels: AVAILABLE_MODELS,
    });
    render(<Settings />);

    await screen.findByText('Request review');
    const row = slotRow('Request review');
    expect(within(row).getByText(warning)).toHaveClass('error-note');
    fireEvent.click(within(row).getByText('reset to default'));

    await waitFor(() => expect(putSettings).toHaveBeenCalledWith({ models: { review: null } }));
  });

  it('offers "reset to default" and the reason on an unroutable slot that still has an override', async () => {
    const warning = '"gpt-9-fake" is not a model ace can route to — using the default instead.';
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        'review-escalated': { route: null, override: 'gpt-9-fake', warning },
      }),
      availableModels: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    putSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels(),
      availableModels: AVAILABLE_MODELS,
    });
    render(<Settings />);

    await screen.findByText('Re-review (escalated)');
    const row = slotRow('Re-review (escalated)');
    // "not available" alone never said WHY, nor offered a way out.
    expect(within(row).getByText(warning)).toHaveClass('error-note');
    fireEvent.click(within(row).getByText('reset to default'));

    await waitFor(() =>
      expect(putSettings).toHaveBeenCalledWith({ models: { 'review-escalated': null } }),
    );
  });

  it('explains a fable-fallback row and keeps its override clearable', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        repair: {
          route: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            source: 'fable-fallback',
            defaultModel: 'claude-fable-5',
          },
          override: 'claude-fable-5',
          warning: null,
        },
      }),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Repair & rework');
    const row = slotRow('Repair & rework');
    // The select shows what will actually run…
    expect((within(row).getByRole('combobox') as HTMLSelectElement).value).toBe('claude-opus-5');
    // …and the row says why that is not the saved choice.
    expect(
      within(row).getByText(
        'claude-fable-5 could not run for this account — using claude-opus-5 for the rest of this session',
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText('reset to default')).toBeInTheDocument();
  });

  it('names the slot default in a fable-fallback row with no override saved', async () => {
    getSettings.mockResolvedValue({
      ...SETTINGS_INFO,
      models: makeModels({
        repair: {
          route: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            source: 'fable-fallback',
            defaultModel: 'claude-fable-5',
          },
          override: null,
          warning: null,
        },
      }),
      availableModels: AVAILABLE_MODELS,
    });
    getWorkspace.mockResolvedValue(WORKSPACE_INFO);
    render(<Settings />);

    await screen.findByText('Repair & rework');
    const row = slotRow('Repair & rework');
    expect(
      within(row).getByText(
        'claude-fable-5 could not run for this account — using claude-opus-5 for the rest of this session',
      ),
    ).toBeInTheDocument();
    // Nothing was overridden, so there is nothing to reset.
    expect(within(row).queryByText('reset to default')).not.toBeInTheDocument();
  });
});
