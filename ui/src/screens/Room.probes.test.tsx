// Regression coverage for NEE-345's "story buffer never reloaded after
// probes-done" bug: the handler used to look up the primary answer file by
// `kind === 'solution'`, but every prose category (the only ones probes ever
// run on) sends `kind: 'notes'` on the wire (see questions.ts's
// solutionKind) — so the lookup could never match, the story buffer was
// never reloaded, and the next autosave silently overwrote the server's
// `## Follow-ups` append. This fixture deliberately uses `kind: 'notes'`,
// matching what the server actually produces for a behavioral question.
import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room';
import type { AttemptRow, ProbeSetRow, QuestionDetail, QuestionRow } from '../types';

// See Room.readonly.test.tsx for why a real in-memory localStorage stand-in
// is required under Node 22+ / happy-dom.
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

vi.mock('@monaco-editor/react', () => ({
  default: (props: {
    path?: string;
    value?: string;
    options?: { readOnly?: boolean };
    onChange?: (value: string) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    props.onMount?.(
      {
        addCommand: () => {},
        focus: () => {},
        getModel: () => ({ uri: { path: props.path?.replace(/^file:\/\//, '') ?? '' } }),
      },
      { KeyMod: { CtrlCmd: 1 }, KeyCode: { Enter: 1, KeyS: 1 } },
    );
    return (
      <textarea
        data-testid={`editor-${props.path ?? ''}`}
        readOnly={!!props.options?.readOnly}
        value={props.value ?? ''}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    );
  },
}));

const { sseHandlers } = vi.hoisted(() => {
  const sseHandlers = new Map<string, Set<(payload: unknown) => void>>();
  return { sseHandlers };
});

function fireSse(name: string, payload: unknown) {
  const set = sseHandlers.get(name);
  if (!set) return;
  act(() => {
    for (const fn of set) fn(payload);
  });
}

vi.mock('../sse', () => ({
  useSseEvent: (name: string, handler: (payload: unknown) => void) => {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
      let set = sseHandlers.get(name);
      if (!set) {
        set = new Set();
        sseHandlers.set(name, set);
      }
      const fn = (payload: unknown) => ref.current(payload);
      set.add(fn);
      return () => {
        set!.delete(fn);
      };
    }, [name]);
  },
  useSseConnected: () => true,
}));

const {
  ApiErrorMock,
  createOrResumeAttempt,
  getQuestionDetail,
  getQuestions,
  getFile,
  putFile,
  getTestRuns,
  getReviews,
  getDisputes,
  getProbeSets,
  startProbes,
  getSettings,
  getAttempt,
  getSnapshots,
  getSnapshot,
  startFreshAttempt,
  startTestRun,
  startReview,
  postAttemptEvent,
  applyDispute,
  startDispute,
  flushFileSave,
  flushActiveSeconds,
  flushAttemptEnd,
  patchAttempt,
} = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiErrorMock,
    createOrResumeAttempt: vi.fn(),
    getQuestionDetail: vi.fn(),
    getQuestions: vi.fn(),
    getFile: vi.fn(),
    putFile: vi.fn(),
    getTestRuns: vi.fn(),
    getReviews: vi.fn(),
    getDisputes: vi.fn(),
    getProbeSets: vi.fn(),
    startProbes: vi.fn(),
    getSettings: vi.fn(),
    getAttempt: vi.fn(),
    getSnapshots: vi.fn(() => Promise.resolve([])),
    getSnapshot: vi.fn(),
    startFreshAttempt: vi.fn(),
    startTestRun: vi.fn(),
    startReview: vi.fn(),
    postAttemptEvent: vi.fn(),
    applyDispute: vi.fn(),
    startDispute: vi.fn(),
    flushFileSave: vi.fn(),
    flushActiveSeconds: vi.fn(),
    flushAttemptEnd: vi.fn(),
    patchAttempt: vi.fn(),
  };
});

vi.mock('../api', () => ({
  ApiError: ApiErrorMock,
  createOrResumeAttempt,
  getQuestionDetail,
  getQuestions,
  getFile,
  putFile,
  getTestRuns,
  getReviews,
  getDisputes,
  getProbeSets,
  startProbes,
  getSettings,
  getAttempt,
  getSnapshots,
  getSnapshot,
  startFreshAttempt,
  startTestRun,
  startReview,
  postAttemptEvent,
  applyDispute,
  startDispute,
  flushFileSave,
  flushActiveSeconds,
  flushAttemptEnd,
  patchAttempt,
  getToken: () => 'test-token',
}));

function questionRow(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    category: 'behavioral',
    slug: 'conflict-navigated',
    title: 'A Conflict You Navigated',
    difficulty: 'medium',
    suggestedMinutes: 10,
    dirPath: 'questions/behavioral/conflict-navigated',
    source: 'manual',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    missingAt: null,
    ...overrides,
  };
}

function attemptRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 'att-1',
    questionId: 'q-1',
    number: 1,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    activeSeconds: 0,
    hintsUsed: 0,
    imported: false,
    ...overrides,
  };
}

// The server never sends kind: 'solution' for a prose category — questions.ts
// assigns `kind: 'notes'` whenever isProseAnswer(config) is true. Behavioral
// has no test files at all, matching CATEGORIES.behavioral in shared/categories.ts.
function questionDetail(overrides: Partial<QuestionDetail> = {}): QuestionDetail {
  return {
    question: questionRow(),
    readme: '# A Conflict You Navigated',
    files: [{ name: 'story.md', relPath: 'story.md', kind: 'notes', readonly: false }],
    activeAttempt: null,
    lastRun: null,
    ...overrides,
  };
}

function probeSet(overrides: Partial<ProbeSetRow> = {}): ProbeSetRow {
  return {
    id: 'ps-1',
    questionId: 'q-1',
    attemptId: 'att-1',
    at: new Date().toISOString(),
    model: 'claude-sonnet-5',
    appliedAt: new Date().toISOString(),
    probes: [{ question: 'What would the other engineer say?', source: 'derived' }],
    ...overrides,
  };
}

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/q/behavioral/conflict-navigated']}>
      <Routes>
        <Route path="/q/:category/:slug" element={<Room />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow() });
  getQuestionDetail.mockResolvedValue(questionDetail());
  getQuestions.mockResolvedValue([]);
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `# story for ${relPath}`, hash: `hash-${relPath}` }),
  );
  getTestRuns.mockResolvedValue([]);
  getReviews.mockResolvedValue([]);
  getDisputes.mockResolvedValue([]);
  getProbeSets.mockResolvedValue([]);
  getSettings.mockResolvedValue({
    openai: { configured: true, masked: '...abcd', baseUrl: null },
    anthropic: { configured: false, masked: null, baseUrl: null },
    defaultProvider: 'openai',
    mockMode: false,
    models: null,
  });
  getAttempt.mockResolvedValue({ attempt: attemptRow(), events: [] });
  patchAttempt.mockResolvedValue({ attempt: attemptRow() });
  postAttemptEvent.mockResolvedValue({ event: {} });
});

afterEach(() => {
  vi.clearAllMocks();
  sseHandlers.clear();
});

describe('Room probes-done story reload (NEE-345)', () => {
  it('reloads the story.md buffer from disk once the append lands, using kind "notes" (not "solution")', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///story.md');

    // one call from the initial mount-time load
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getFile).toHaveBeenCalledWith('story.md');

    fireSse('probes-done', {
      probeJobId: 'job-1',
      questionId: 'q-1',
      probeSet: probeSet(),
    });

    await vi.waitFor(() => {
      expect(getFile).toHaveBeenCalledTimes(2);
    });
    // the reload must target the actual story file, not some hardcoded
    // 'solution.ts'-shaped path that only coding categories ever have
    expect(getFile).toHaveBeenLastCalledWith('story.md');
  });

  it('routes a raced dirty buffer into the conflict banner instead of clobbering it (onlyIfClean)', async () => {
    renderRoom();
    const editor = await screen.findByTestId('editor-file:///story.md');

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(editor, { target: { value: 'a fresh, unsaved edit' } });

    fireSse('probes-done', {
      probeJobId: 'job-1',
      questionId: 'q-1',
      probeSet: probeSet(),
    });

    // loadFileInto always fetches, but onlyIfClean must not apply the
    // result over a dirty buffer — it flags a conflict instead.
    await screen.findByRole('alert');
    expect(editor).toHaveValue('a fresh, unsaved edit');
  });
});

// FIX 2 (NEE-345 follow-up): the GET is now scoped by attemptId — assert the
// Room actually threads its active attempt through, not just that the
// server-side route filters correctly (covered separately in
// app-probes.test.ts).
describe('Room probe-set fetch is attempt-scoped (NEE-345 follow-up)', () => {
  it('fetches probe sets scoped to the current attempt, not every attempt on the question', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///story.md');

    expect(getProbeSets).toHaveBeenCalledWith('behavioral', 'conflict-navigated', 'att-1');
  });

  it('fetches the null-attempt bucket for a readonly (solved) room with no active attempt', async () => {
    createOrResumeAttempt.mockResolvedValue({
      attempt: null,
      readonly: true,
      latestAttempt: attemptRow({ id: 'att-old', endedAt: new Date().toISOString(), endReason: 'solved' }),
    });
    renderRoom();
    await screen.findByTestId('editor-file:///story.md');

    // readonly rooms scope to the ended reference attempt (Room's
    // refAttempt), not the null bucket — it's the attempt whose probes are
    // actually relevant to what's on screen.
    expect(getProbeSets).toHaveBeenCalledWith('behavioral', 'conflict-navigated', 'att-old');
  });
});
