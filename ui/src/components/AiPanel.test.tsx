import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiPanel } from './AiPanel';
import { SLOT_ORDER } from '../lib/models';
import type { LLMSlot, QuestionRow, ReviewRow, SettingsInfo } from '../types';

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

const KEYLESS_SETTINGS: SettingsInfo = {
  openai: { configured: false, masked: null, baseUrl: null },
  anthropic: { configured: false, masked: null, baseUrl: null },
  defaultProvider: null,
  mockMode: false,
  models: null,
  availableModels: [],
};

const KEYED_SETTINGS: SettingsInfo = {
  openai: { configured: false, masked: null, baseUrl: null },
  anthropic: { configured: true, masked: '...abcd', baseUrl: null },
  defaultProvider: 'anthropic',
  mockMode: false,
  models: slotModels('anthropic', 'claude-sonnet-5', {
    review: 'claude-opus-5',
    dispute: 'claude-opus-5',
    probe: 'claude-sonnet-5',
  }),
  availableModels: [{ provider: 'anthropic', model: 'claude-opus-5' }],
};

// A distinct model per slot, so the escalation tests below can tell which
// slot's model actually rendered in the button label (NEE-303 client mirror).
const ESCALATION_SETTINGS: SettingsInfo = {
  ...KEYED_SETTINGS,
  models: slotModels('anthropic', 'claude-sonnet-5', {
    review: 'claude-sonnet-5',
    'review-escalated': 'claude-opus-5',
  }),
};

function reviewRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 'r-1',
    questionId: 'q-1',
    attemptId: null,
    version: 1,
    at: new Date().toISOString(),
    model: 'claude-sonnet-5',
    verdict: 'Hire',
    score: 4,
    dimensions: null,
    bodyMd: 'Solid solution.',
    snapshotHash: null,
    source: 'user',
    ...overrides,
  };
}

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

// Every escalation test below renders with a non-empty `reviews` list, which
// triggers the (pre-existing) debrief fetch — give the mock a settled
// promise so that effect has something to resolve/catch instead of throwing
// on a bare vi.fn()'s undefined return.
afterEach(() => {
  vi.clearAllMocks();
});
beforeEach(() => {
  getDebrief.mockRejectedValue(new Error('debrief not under test here'));
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

describe('AiPanel — escalation label mirror (NEE-303)', () => {
  it('shows the routine review model with no prior reviews', () => {
    renderPanel({ settings: ESCALATION_SETTINGS, reviews: [], attemptId: 'attempt-1' });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument();
  });

  it('shows the escalated model once the active attempt already has a persisted review', () => {
    renderPanel({
      settings: ESCALATION_SETTINGS,
      reviews: [reviewRow({ attemptId: 'attempt-1' })],
      attemptId: 'attempt-1',
    });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-opus-5' }),
    ).toBeInTheDocument();
  });

  it('de-escalates back to the routine model on a fresh attempt with no review of its own', () => {
    renderPanel({
      settings: ESCALATION_SETTINGS,
      reviews: [reviewRow({ attemptId: 'attempt-1' })],
      attemptId: 'attempt-2',
    });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument();
  });

  it('never escalates with a null attemptId (readonly room), even with reviews on record', () => {
    renderPanel({
      settings: ESCALATION_SETTINGS,
      reviews: [reviewRow({ attemptId: 'attempt-1' })],
      attemptId: null,
    });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument();
  });

  // A prose attempt ENDS the moment its review lands (endProseAttemptOnReview),
  // so the two states below are the only ones a behavioral room is ever in
  // after review #1 — and the server escalates in both. An attempt-scoped
  // mirror labeled them routine while the escalated model actually ran.
  it('escalates a behavioral re-review even though its prior review is on an ended attempt', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: ESCALATION_SETTINGS,
      reviews: [reviewRow({ attemptId: 'attempt-1' })],
      attemptId: 'attempt-2',
    });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-opus-5' }),
    ).toBeInTheDocument();
  });

  it('escalates a behavioral re-review requested with no active attempt at all', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: ESCALATION_SETTINGS,
      reviews: [reviewRow({ attemptId: 'attempt-1' })],
      attemptId: null,
    });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-opus-5' }),
    ).toBeInTheDocument();
  });

  it('stays routine for a behavioral question with no review yet', () => {
    renderPanel({
      question: BEHAVIORAL_QUESTION,
      settings: ESCALATION_SETTINGS,
      reviews: [],
      attemptId: 'attempt-1',
    });
    expect(
      screen.getByRole('button', { name: 'Request review · anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument();
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
