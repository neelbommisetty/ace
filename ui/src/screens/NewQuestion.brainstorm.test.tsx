import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewQuestion } from './NewQuestion';
import type { BrainstormSessionRow, SettingsInfo } from '../types';

// Same seam as NewQuestion.test.tsx / GenerationJobStrip.test.tsx: `useSseEvent`
// registers into a module-level handler registry. None of these tests need to
// drive it directly (thinking-state is exercised via a reopened session
// fixture, not a live send-then-SSE round trip), so a no-op stub is enough.
vi.mock('../sse', () => ({
  useSseEvent: (_name: string, handler: (payload: unknown) => void) => {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {}, []);
  },
}));

const {
  getSettings,
  getGenerationJobs,
  startGenerationJob,
  getBrainstormSession,
  getBrainstormSessions,
  sendBrainstormTurn,
} = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getGenerationJobs: vi.fn(),
  startGenerationJob: vi.fn(),
  getBrainstormSession: vi.fn(),
  getBrainstormSessions: vi.fn(),
  sendBrainstormTurn: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getSettings,
    getGenerationJobs,
    startGenerationJob,
    getBrainstormSession,
    getBrainstormSessions,
    sendBrainstormTurn,
  };
});

const CONFIGURED_SETTINGS: SettingsInfo = {
  openai: { configured: true, masked: 'sk-...abcd', baseUrl: null },
  anthropic: { configured: false, masked: null, baseUrl: null },
  defaultProvider: 'openai',
  mockMode: false,
  models: {
    generate: { provider: 'openai', model: 'gpt-5.6-sol' },
    'edge-audit': { provider: 'openai', model: 'gpt-5.6-terra' },
    review: { provider: 'openai', model: 'gpt-5.6-sol' },
    'review-extract': { provider: 'openai', model: 'gpt-5.6-luna' },
    brainstorm: { provider: 'openai', model: 'gpt-5.6-terra' },
    dispute: { provider: 'openai', model: 'gpt-5.6-sol' },
    probe: { provider: 'openai', model: 'gpt-5.6-terra' },
  },
};

const SESSION_KEY = 'ace-brainstorm-session';

function session(overrides: Partial<BrainstormSessionRow> = {}): BrainstormSessionRow {
  return {
    id: 'sess-1',
    status: 'idle',
    title: 'something about closures',
    messages: [],
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderNewQuestion() {
  return render(
    <MemoryRouter>
      <NewQuestion />
    </MemoryRouter>,
  );
}

async function openBrainstormTab() {
  renderNewQuestion();
  await waitFor(() => expect(getSettings).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'Brainstorm' }));
}

beforeEach(() => {
  sessionStorage.clear();
  getSettings.mockResolvedValue(CONFIGURED_SETTINGS);
  getGenerationJobs.mockResolvedValue({ jobs: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('NewQuestion — brainstorm mode', () => {
  it('reopens from sessionStorage: calls getBrainstormSession with the stored id and renders its turns', async () => {
    sessionStorage.setItem(SESSION_KEY, 'stored-session-id');
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'stored-session-id',
        messages: [
          { role: 'user', content: 'something about React state' },
          { role: 'assistant', content: 'Here are a few ideas.', ideas: [] },
        ],
      }),
    });

    await openBrainstormTab();

    await waitFor(() => expect(getBrainstormSession).toHaveBeenCalledWith('stored-session-id'));
    expect(getBrainstormSessions).not.toHaveBeenCalled();
    expect(await screen.findByText('something about React state')).toBeInTheDocument();
    expect(screen.getByText('Here are a few ideas.')).toBeInTheDocument();
  });

  it('falls back to the latest session from getBrainstormSessions when sessionStorage has no key', async () => {
    getBrainstormSessions.mockResolvedValue({
      sessions: [{ id: 'latest-id', title: 'closures', status: 'idle', updatedAt: new Date().toISOString() }],
    });
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'latest-id',
        messages: [{ role: 'user', content: 'closures please' }],
      }),
    });

    await openBrainstormTab();

    await waitFor(() => expect(getBrainstormSessions).toHaveBeenCalledWith(1));
    expect(getBrainstormSession).toHaveBeenCalledWith('latest-id');
    expect(await screen.findByText('closures please')).toBeInTheDocument();
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('latest-id');
  });

  it('disables the composer input and send button while the reopened session is thinking', async () => {
    sessionStorage.setItem(SESSION_KEY, 'thinking-session');
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'thinking-session',
        status: 'thinking',
        messages: [{ role: 'user', content: 'refine this please' }],
      }),
    });

    await openBrainstormTab();

    await screen.findByText('refine this please');
    expect(screen.getByLabelText('Refine')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeDisabled();
  });

  it('renders a turn with an empty ideas array as plain text, no idea cards and no false parse-failure hint', async () => {
    // An empty `ideas` array is the expected shape for BOTH a purely
    // conversational reply and the parse-failure salvage path (see
    // cli/server/brainstorm.ts) — indistinguishable here, so the UI must not
    // assert a failure that may not have happened.
    sessionStorage.setItem(SESSION_KEY, 'parse-fail-session');
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'parse-fail-session',
        messages: [
          { role: 'user', content: 'give me ideas' },
          { role: 'assistant', content: 'raw unparsed reply text' },
        ],
      }),
    });

    await openBrainstormTab();

    expect(await screen.findByText('raw unparsed reply text')).toBeInTheDocument();
    expect(screen.queryByText(/try refining your ask below/)).not.toBeInTheDocument();
    expect(screen.queryByText('Generate this')).not.toBeInTheDocument();
  });

  it("IdeaCard 'Generate this' calls startGenerationJob with the idea's fields and the current session id", async () => {
    sessionStorage.setItem(SESSION_KEY, 'idea-session');
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'idea-session',
        messages: [
          { role: 'user', content: 'give me ideas' },
          {
            role: 'assistant',
            content: 'Here is one.',
            ideas: [
              {
                title: 'Debounced search',
                category: 'js-ts',
                difficulty: 'medium',
                pitch: 'Build a debounced search input.',
                topic: 'a debounced search input with cancel-in-flight',
              },
            ],
          },
        ],
      }),
    });
    startGenerationJob.mockResolvedValue({ jobId: 'job-99' });

    await openBrainstormTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Generate this' }));

    await waitFor(() =>
      expect(startGenerationJob).toHaveBeenCalledWith({
        category: 'js-ts',
        difficulty: 'medium',
        topic: 'a debounced search input with cancel-in-flight',
        brainstormSessionId: 'idea-session',
      }),
    );
  });

  it("'Start over' resets to the empty composer without any network call, and the reset sticks (no sessionStorage fallback resurrection)", async () => {
    sessionStorage.setItem(SESSION_KEY, 'stored-session-id');
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'stored-session-id',
        messages: [{ role: 'user', content: 'something about React state' }],
      }),
    });

    await openBrainstormTab();
    await screen.findByText('something about React state');

    const callsBefore =
      getBrainstormSession.mock.calls.length +
      getBrainstormSessions.mock.calls.length +
      sendBrainstormTurn.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));

    // Written as a "cleared" sentinel, not removed — an absent key means
    // "fall back to the latest session" (see reopen()), which is exactly
    // what must NOT happen right after an explicit Start over.
    expect(sessionStorage.getItem(SESSION_KEY)).toBe('cleared');
    expect(screen.queryByText('something about React state')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Brainstorm')).toBeInTheDocument();
    expect(screen.getByLabelText('Brainstorm')).toHaveValue('');

    const callsAfter =
      getBrainstormSession.mock.calls.length +
      getBrainstormSessions.mock.calls.length +
      sendBrainstormTurn.mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });

  it("'Start over' stays cleared across a tab-switch remount instead of resurrecting the discarded session", async () => {
    sessionStorage.setItem(SESSION_KEY, 'stored-session-id');
    getBrainstormSession.mockResolvedValue({
      session: session({
        id: 'stored-session-id',
        messages: [{ role: 'user', content: 'something about React state' }],
      }),
    });
    // Would be hit by the "no stored id" fallback path if Start over's
    // sentinel were mistaken for an absent key.
    getBrainstormSessions.mockResolvedValue({
      sessions: [session({ id: 'stored-session-id' })],
    });

    await openBrainstormTab();
    await screen.findByText('something about React state');
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByText('something about React state')).not.toBeInTheDocument();

    // BrainstormPane unmounts on tab-switch away and remounts on switch-back
    // — exactly the path the reopen effect runs on.
    fireEvent.click(screen.getByRole('tab', { name: 'Describe' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Brainstorm' }));

    await waitFor(() => expect(screen.getByLabelText('Brainstorm')).toHaveValue(''));
    expect(screen.queryByText('something about React state')).not.toBeInTheDocument();
    expect(getBrainstormSessions).not.toHaveBeenCalled();
  });

  it('states the per-turn cost and resolved model before Brainstorm/Send is invoked (NEE-303)', async () => {
    await openBrainstormTab();

    expect(await screen.findByText(/Each turn costs one LLM call/)).toHaveTextContent(
      'openai/gpt-5.6-terra',
    );
  });
});
