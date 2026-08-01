import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewQuestion } from './NewQuestion';
import { GENERATABLE_CATEGORY_SLUGS } from '../lib/categories';
import { SLOT_ORDER } from '../lib/models';
import type { LLMSlot, SettingsInfo } from '../types';

// Same seam as GenerationJobStrip.test.tsx: `useSseEvent` registers into a
// module-level handler registry. NewQuestion mounts GenerationJobStrip, which
// uses this hook, so it needs the same mock even though these tests never
// drive it directly.
vi.mock('../sse', () => ({
  useSseEvent: (_name: string, handler: (payload: unknown) => void) => {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {}, []);
  },
}));

const { getSettings, startGenerationJob, getGenerationJobs } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  startGenerationJob: vi.fn(),
  getGenerationJobs: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getSettings, startGenerationJob, getGenerationJobs };
});

/**
 * A full per-slot routing map with the named slots pinned — SlotInfo's
 * source/warning/override/defaultModel are noise for these tests, so they are
 * uniform.
 */
function slotModels(
  provider: 'openai' | 'anthropic',
  base: string,
  overrides: Partial<Record<LLMSlot, string>> = {},
): NonNullable<SettingsInfo['models']> {
  const map = {} as NonNullable<SettingsInfo['models']>;
  for (const slot of SLOT_ORDER) {
    const model = overrides[slot] ?? base;
    map[slot] = {
      route: { provider, model, source: 'default', defaultModel: model },
      override: null,
      warning: null,
    };
  }
  return map;
}

const CONFIGURED_SETTINGS: SettingsInfo = {
  openai: { configured: true, masked: 'sk-...abcd', baseUrl: null },
  anthropic: { configured: false, masked: null, baseUrl: null },
  defaultProvider: 'openai',
  mockMode: false,
  models: slotModels('openai', 'gpt-5.6-terra', { 'draft-problem': 'gpt-5.6-sol' }),
  availableModels: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
};

const KEYLESS_SETTINGS: SettingsInfo = {
  openai: { configured: false, masked: null, baseUrl: null },
  anthropic: { configured: false, masked: null, baseUrl: null },
  defaultProvider: null,
  mockMode: false,
  models: null,
  availableModels: [],
};

const MOCK_MODE_KEYLESS_SETTINGS: SettingsInfo = {
  ...KEYLESS_SETTINGS,
  mockMode: true,
};

function renderNewQuestion() {
  return render(
    <MemoryRouter>
      <NewQuestion />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('NewQuestion — describe mode', () => {
  it('renders category and difficulty selects from lib/categories.ts data with hint text', async () => {
    getSettings.mockResolvedValue(CONFIGURED_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();

    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    const categorySelect = screen.getByLabelText('Category') as HTMLSelectElement;
    expect(categorySelect).toBeEnabled();
    expect(
      screen.getByRole('option', { name: /JS\/TS — Closures, async patterns, type utilities/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Design-FE — Component architecture, state, rendering/ }),
    ).toBeInTheDocument();

    const difficultySelect = screen.getByLabelText('Difficulty') as HTMLSelectElement;
    expect(difficultySelect).toBeEnabled();
    // No time labels — the LLM authors the estimate, not a static per-difficulty table.
    expect(screen.getByRole('option', { name: 'easy' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'medium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'hard' })).toBeInTheDocument();
  });

  it('offers exactly the generatable categories — never the playground slugs, whose jobs 400 server-side (NEE-387)', async () => {
    getSettings.mockResolvedValue(CONFIGURED_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    // Pins the picker to GENERATABLE_CATEGORY_SLUGS: a revert to the full
    // CATEGORY_SLUGS list (plausible — Library/History legitimately use it)
    // would offer Scratch / TS Scratch here, and every submit with one
    // selected dies on the server's 'category must be one of: …' 400.
    const options = within(screen.getByLabelText('Category')).getAllByRole(
      'option',
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(GENERATABLE_CATEGORY_SLUGS);
    expect(GENERATABLE_CATEGORY_SLUGS).not.toContain('playground');
    expect(GENERATABLE_CATEGORY_SLUGS).not.toContain('playground-ts');
  });

  it('disables submit when the topic is empty and enables it once text is entered', async () => {
    getSettings.mockResolvedValue(CONFIGURED_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    const submit = screen.getByRole('button', { name: 'Generate' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Topic'), {
      target: { value: 'a debounced search input' },
    });
    expect(submit).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
  });

  it('posts the expected startGenerationJob payload on submit', async () => {
    getSettings.mockResolvedValue(CONFIGURED_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    startGenerationJob.mockResolvedValue({ jobId: 'job-1' });
    renderNewQuestion();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'design-fe' } });
    fireEvent.change(screen.getByLabelText('Difficulty'), { target: { value: 'hard' } });
    fireEvent.change(screen.getByLabelText('Topic'), {
      target: { value: 'a virtualized list component' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() =>
      expect(startGenerationJob).toHaveBeenCalledWith({
        category: 'design-fe',
        difficulty: 'hard',
        topic: 'a virtualized list component',
      }),
    );
  });

  it('shows the keyless banner and disables inputs when no provider is configured and mockMode is false', async () => {
    getSettings.mockResolvedValue(KEYLESS_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();

    expect(
      await screen.findByText(/No LLM provider is configured/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByLabelText('Difficulty')).toBeDisabled();
    expect(screen.getByLabelText('Topic')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('does not show the keyless banner when mockMode is true, even with no configured provider', async () => {
    getSettings.mockResolvedValue(MOCK_MODE_KEYLESS_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();
    await waitFor(() => expect(getSettings).toHaveBeenCalled());

    expect(screen.queryByText(/No LLM provider is configured/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Topic')).toBeEnabled();
  });

  it('states the pipeline cost and resolved model before Generate is invoked (NEE-303)', async () => {
    getSettings.mockResolvedValue(CONFIGURED_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();

    expect(
      await screen.findByText(/costs several LLM calls and can take a couple of minutes/),
    ).toHaveTextContent('openai/gpt-5.6-sol');
  });

  it('omits the model from the disclosure line while settings are unresolved (keyless)', async () => {
    getSettings.mockResolvedValue(KEYLESS_SETTINGS);
    getGenerationJobs.mockResolvedValue({ jobs: [] });
    renderNewQuestion();

    const note = await screen.findByText(/costs several LLM calls and can take a couple of minutes/);
    expect(note).not.toHaveTextContent('openai/');
    expect(note).not.toHaveTextContent('anthropic/');
  });
});
