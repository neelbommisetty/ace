import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiPanel } from './AiPanel';
import type { QuestionRow, SettingsInfo } from '../types';

const { getDebrief } = vi.hoisted(() => ({ getDebrief: vi.fn() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, getDebrief };
});

const QUESTION: QuestionRow = {
  id: 'q-1',
  category: 'leetcode-ds',
  slug: 'two-sum',
  title: 'Two Sum',
  difficulty: 'easy',
  suggestedMinutes: 20,
  dirPath: '/tmp/q',
  source: 'manual',
  createdAt: new Date().toISOString(),
  archivedAt: null,
  missingAt: null,
};

const BEHAVIORAL_QUESTION: QuestionRow = {
  ...QUESTION,
  id: 'q-2',
  category: 'behavioral',
  slug: 'conflict-navigated',
  title: 'A Conflict You Navigated',
};

const KEYLESS_SETTINGS: SettingsInfo = {
  openai: { configured: false, masked: null, baseUrl: null },
  anthropic: { configured: false, masked: null, baseUrl: null },
  defaultProvider: null,
  mockMode: false,
  models: null,
};

const KEYED_SETTINGS: SettingsInfo = {
  openai: { configured: false, masked: null, baseUrl: null },
  anthropic: { configured: true, masked: '...abcd', baseUrl: null },
  defaultProvider: 'anthropic',
  mockMode: false,
  models: {
    generate: { provider: 'anthropic', model: 'claude-opus-5' },
    'edge-audit': { provider: 'anthropic', model: 'claude-sonnet-5' },
    review: { provider: 'anthropic', model: 'claude-opus-5' },
    'review-extract': { provider: 'anthropic', model: 'claude-haiku-4-5' },
    brainstorm: { provider: 'anthropic', model: 'claude-sonnet-5' },
    dispute: { provider: 'anthropic', model: 'claude-opus-5' },
    probe: { provider: 'anthropic', model: 'claude-sonnet-5' },
  },
};

function renderPanel(props: Partial<Parameters<typeof AiPanel>[0]> = {}) {
  return render(
    <MemoryRouter>
      <AiPanel
        question={QUESTION}
        reviews={[]}
        stream={null}
        notice={null}
        justDoneId={null}
        settings={null}
        onRequest={vi.fn()}
        onCollapse={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AiPanel — keyless gating (NEE-303)', () => {
  it('renders the "add one in Settings" notice instead of an enabled button when no key is configured', () => {
    renderPanel({ settings: KEYLESS_SETTINGS });

    expect(screen.queryByRole('button', { name: /Request review/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No LLM API key configured/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'add one in Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('does not render the notice while settings are still loading (null)', () => {
    renderPanel({ settings: null });

    expect(screen.queryByText(/No LLM API key configured/)).not.toBeInTheDocument();
    // No enabled button either — null is "not yet known", not "keyed".
    expect(screen.queryByRole('button', { name: /Request review/ })).not.toBeInTheDocument();
  });

  it('renders an enabled button naming the resolved provider/model when a key is configured', () => {
    renderPanel({ settings: KEYED_SETTINGS });

    expect(screen.queryByText(/No LLM API key configured/)).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Request review · anthropic/claude-opus-5' });
    expect(button).toBeEnabled();
  });

  it('never renders the button or the notice in readonly mode (no onRequest), regardless of key state', () => {
    renderPanel({ settings: KEYLESS_SETTINGS, onRequest: undefined });
    expect(screen.queryByRole('button', { name: /Request review/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No LLM API key configured/)).not.toBeInTheDocument();

    renderPanel({ settings: KEYED_SETTINGS, onRequest: undefined });
    expect(screen.queryByRole('button', { name: /Request review/ })).not.toBeInTheDocument();
  });

  it('disables the button while a review is streaming', () => {
    renderPanel({
      settings: KEYED_SETTINGS,
      stream: { jobId: 'job-1', text: '', error: null },
    });

    expect(screen.getByRole('button', { name: /Reviewing…/ })).toBeDisabled();
  });
});

describe('AiPanel — follow-up probes gating (NEE-345)', () => {
  it('never renders the probes button for a non-prose category, keyed or not', () => {
    renderPanel({ question: QUESTION, settings: KEYED_SETTINGS, onRequestProbes: vi.fn() });
    expect(screen.queryByRole('button', { name: /Follow-up probes/ })).not.toBeInTheDocument();
  });

  it('hides the probes button (and shows the no-key notice) when no key is configured', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: KEYLESS_SETTINGS,
      onRequestProbes: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /Follow-up probes/ })).not.toBeInTheDocument();
    expect(screen.getByText(/to request follow-up probes\./)).toBeInTheDocument();
  });

  it('does not render the probes button while settings are still loading (null)', () => {
    renderPanel({ question: BEHAVIORAL_QUESTION, settings: null, onRequestProbes: vi.fn() });
    expect(screen.queryByRole('button', { name: /Follow-up probes/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No LLM API key configured/)).not.toBeInTheDocument();
  });

  it('renders an enabled probes button naming the resolved model for a prose category once keyed', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: KEYED_SETTINGS,
      onRequestProbes: vi.fn(),
    });
    const button = screen.getByRole('button', {
      name: 'Follow-up probes · anthropic/claude-sonnet-5',
    });
    expect(button).toBeEnabled();
  });

  it('never renders the probes button in readonly mode (no onRequestProbes), regardless of key state', () => {
    renderPanel({ question: BEHAVIORAL_QUESTION, settings: KEYLESS_SETTINGS });
    expect(screen.queryByRole('button', { name: /Follow-up probes/ })).not.toBeInTheDocument();

    renderPanel({ question: BEHAVIORAL_QUESTION, settings: KEYED_SETTINGS });
    expect(screen.queryByRole('button', { name: /Follow-up probes/ })).not.toBeInTheDocument();
  });

  it('disables the probes button while a probe round is running', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: KEYED_SETTINGS,
      onRequestProbes: vi.fn(),
      probesRunning: true,
    });
    expect(screen.getByRole('button', { name: /Drafting probes…/ })).toBeDisabled();
  });

  it('renders the returned probes as a read-only list with the "answer in story.md" hint', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: KEYED_SETTINGS,
      onRequestProbes: vi.fn(),
      probeSets: [
        {
          id: 'ps-1',
          questionId: 'q-2',
          attemptId: null,
          at: new Date().toISOString(),
          model: 'claude-sonnet-5',
          appliedAt: new Date().toISOString(),
          probes: [
            { question: 'What would the other engineer say?', source: 'derived' },
            { question: 'How would this change at 10x scale?', source: 'bank' },
          ],
        },
      ],
    });

    expect(screen.getByText('What would the other engineer say?')).toBeInTheDocument();
    expect(screen.getByText('How would this change at 10x scale?')).toBeInTheDocument();
    expect(screen.getByText(/answer these in/)).toBeInTheDocument();
    expect(screen.getByText('story.md')).toBeInTheDocument();
    // No textarea anywhere — answers are typed in the Monaco editor, not here.
    expect(document.querySelector('textarea')).toBeNull();
  });
});
