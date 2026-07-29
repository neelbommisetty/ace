import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room';
import type { AttemptRow, QuestionDetail, QuestionRow, TestRunRow } from '../types';

// Node 22+ defines a global `localStorage` accessor that reads as `undefined`
// unless the process is started with --localstorage-file, and it shadows
// happy-dom's own window.localStorage in this test environment. Room.tsx
// reads localStorage synchronously on mount (autorun / AI-panel prefs), so
// give it a real in-memory stand-in — this is the first test to render Room.
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
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

// EditorPane renders one Monaco <Editor> per active tab. Stub it with a
// textarea that honors options.readOnly so read-only-mode assertions can
// check a real DOM attribute instead of reaching into Monaco internals.
vi.mock('@monaco-editor/react', () => ({
  default: (props: {
    path?: string;
    value?: string;
    options?: { readOnly?: boolean };
    onChange?: (value: string) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    // Room's handleEditorMount registers Cmd+Enter / Cmd+S editor commands —
    // give it just enough of a fake editor/monaco to not throw. getModel()
    // mirrors EditorPane's onChange (NEE-334), which resolves the emitting
    // file from the editor's current model URI — same "file:///<relPath>" ->
    // "/<relPath>" shape monaco's Uri.parse produces.
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

// Room subscribes to SSE for run/review updates and connection state. Most
// readonly-mode cases below don't drive a live event, but the 'end on leave'
// tests need to feed a real run-done event, so use the same module-level
// handler registry as Library.test.tsx / GenerationJobStrip.test.tsx (mirrors
// the real hook's mount/unmount lifecycle) instead of a no-op stub.
const { sseHandlers, emitSse } = vi.hoisted(() => {
  const sseHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitSse = (name: string, payload: unknown) => {
    const set = sseHandlers.get(name);
    if (set) for (const fn of [...set]) fn(payload);
  };
  return { sseHandlers, emitSse };
});

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

// Full replacement mock (not importOriginal — see NEE-178 subtask notes):
// Room + everything it mounts (ProblemPane, DisputeModal, useActiveTimer)
// only ever touches this named set of exports.
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
    category: 'js-ts',
    slug: 'closures',
    title: 'Closures and Scope',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: 'questions/js-ts/closures',
    source: 'generated',
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
    activeSeconds: 42,
    hintsUsed: 0,
    imported: false,
    ...overrides,
  };
}

function testRunRow(overrides: Partial<TestRunRow> = {}): TestRunRow {
  return {
    id: 'run-1',
    attemptId: 'att-1',
    questionId: 'q-1',
    at: new Date().toISOString(),
    trigger: 'manual',
    status: 'done',
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    results: null,
    stdout: null,
    stderr: null,
    errorMessage: null,
    ...overrides,
  };
}

function questionDetail(overrides: Partial<QuestionDetail> = {}): QuestionDetail {
  return {
    question: questionRow(),
    readme: '# Closures\n\nExplain closures.',
    files: [
      { name: 'solution.ts', relPath: 'solution.ts', kind: 'solution', readonly: false },
      { name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true },
    ],
    activeAttempt: null,
    lastRun: null,
    ...overrides,
  };
}

/**
 * A behavioral (prose) question's detail: one editable story.md, no test
 * file — the exact shape questions.ts sends for a `testFiles: []` category
 * (`kind: 'notes'` for the primary answer file).
 */
function proseDetail(): QuestionDetail {
  return questionDetail({
    question: questionRow({ category: 'behavioral', slug: 'greatest-failure' }),
    readme: '# Greatest Failure\n\nTell me about it.',
    files: [{ name: 'story.md', relPath: 'story.md', kind: 'notes', readonly: false }],
  });
}

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/q/js-ts/closures']}>
      <Routes>
        <Route path="/q/:category/:slug" element={<Room />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getQuestionDetail.mockResolvedValue(questionDetail());
  getQuestions.mockResolvedValue([]);
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Room readonly reference mode', () => {
  it('renders a readonly reference for a solved question without touching patchAttempt or putFile', async () => {
    const latestAttempt = attemptRow({ id: 'att-3', number: 3, endedAt: new Date().toISOString(), endReason: 'solved' });
    createOrResumeAttempt.mockResolvedValue({
      attempt: null,
      readonly: true,
      latestAttempt,
    });

    renderRoom();

    expect(await screen.findByText(/Solved/)).toBeInTheDocument();
    expect(screen.getByText(/read-only reference/)).toBeInTheDocument();

    // both files ended up forced read-only, including the non-test file
    // that is normally editable — the regression is a crash on
    // `loaded.attempt.id` before this file was ever rendered at all.
    await waitFor(() => {
      expect(screen.getAllByTitle('Generated tests are read-only — dispute a failing assertion to propose a fix')).toHaveLength(2);
    });
    const editor = screen.getByTestId('editor-file:///solution.ts');
    expect(editor).toHaveAttribute('readonly');

    // give any stray timers/effects a tick, then assert nothing fired
    await new Promise((r) => setTimeout(r, 0));
    expect(patchAttempt).not.toHaveBeenCalled();
    expect(putFile).not.toHaveBeenCalled();
    expect(createOrResumeAttempt).toHaveBeenCalledWith('js-ts', 'closures');
  });

  it('opens Start new attempt, confirms via startFreshAttempt, and refetches', async () => {
    const latestAttempt = attemptRow({ id: 'att-3', number: 3, endedAt: new Date().toISOString(), endReason: 'solved' });
    createOrResumeAttempt.mockResolvedValueOnce({
      attempt: null,
      readonly: true,
      latestAttempt,
    });
    createOrResumeAttempt.mockResolvedValueOnce({
      attempt: attemptRow({ id: 'att-4', number: 4 }),
    });
    startFreshAttempt.mockResolvedValue({ attempt: attemptRow({ id: 'att-4', number: 4 }) });

    renderRoom();

    const startButton = await screen.findByRole('button', { name: 'Start new attempt' });
    fireEvent.click(startButton);

    expect(await screen.findByText('Start attempt #4?')).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Start attempt #4' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(startFreshAttempt).toHaveBeenCalledWith('att-3', false);
    });
    await waitFor(() => {
      expect(createOrResumeAttempt).toHaveBeenCalledTimes(2);
    });
  });

  it('renders the editable room for a normal (non-readonly) attempt response', async () => {
    createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow() });

    renderRoom();

    await waitFor(() => {
      expect(screen.getByTestId('editor-file:///solution.ts')).not.toHaveAttribute('readonly');
    });
    expect(screen.queryByText(/read-only reference/)).not.toBeInTheDocument();
    // the editable solution file has no lock badge; only the test file does
    expect(screen.getAllByTitle('Generated tests are read-only — dispute a failing assertion to propose a fix')).toHaveLength(1);
    expect(screen.getByText('00:42')).toBeInTheDocument();
  });
});

describe('Room ends the attempt as solved on leaving', () => {
  it('claims solved on unmount when the last run (live run-done) fully passes and postdates the attempt', async () => {
    const attempt = attemptRow({
      id: 'att-1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    createOrResumeAttempt.mockResolvedValue({ attempt });

    const { unmount } = renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    act(() => {
      emitSse('run-done', {
        questionId: 'q-1',
        runId: 'run-pass',
        status: 'done',
        summary: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 10 },
        results: null,
        errorMessage: null,
      });
    });

    unmount();

    await waitFor(() => {
      expect(patchAttempt).toHaveBeenCalledWith('att-1', { end: { reason: 'solved' } });
    });
  });

  it('does not claim solved when the last run had failures', async () => {
    const attempt = attemptRow({
      id: 'att-1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    createOrResumeAttempt.mockResolvedValue({ attempt });

    const { unmount } = renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    act(() => {
      emitSse('run-done', {
        questionId: 'q-1',
        runId: 'run-fail',
        status: 'done',
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 10 },
        results: null,
        errorMessage: null,
      });
    });

    unmount();
    // give any stray timers/effects a tick, then assert the end claim never fired
    await new Promise((r) => setTimeout(r, 0));
    expect(patchAttempt).not.toHaveBeenCalledWith('att-1', { end: { reason: 'solved' } });
  });

  it('does not claim solved when the only passing run predates the attempt (fresh-attempt scenario)', async () => {
    const attemptStart = new Date();
    const attempt = attemptRow({ id: 'att-4', startedAt: attemptStart.toISOString() });
    // the fresh attempt N+1 seeds lastRun from detail.lastRun, which is the
    // OLD passing run from the attempt it superseded
    const staleRun = testRunRow({
      at: new Date(attemptStart.getTime() - 60_000).toISOString(),
      status: 'done',
      total: 2,
      passed: 2,
      failed: 0,
    });
    createOrResumeAttempt.mockResolvedValue({ attempt });
    getQuestionDetail.mockResolvedValue(questionDetail({ lastRun: staleRun }));

    const { unmount } = renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(patchAttempt).not.toHaveBeenCalledWith('att-4', { end: { reason: 'solved' } });
  });

  it('a prose room never claims solved on leaving — its attempt is the server\'s to end (NEE-356)', async () => {
    const attempt = attemptRow({
      id: 'att-1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    createOrResumeAttempt.mockResolvedValue({ attempt });
    getQuestionDetail.mockResolvedValue(proseDetail());

    const { unmount } = renderRoom();
    await screen.findByTestId('editor-file:///story.md');

    unmount();
    await new Promise((r) => setTimeout(r, 0));
    // No test run can ever exist here, so there is nothing to claim from —
    // endProseAttemptOnReview (cli/server/reviews.ts) owns this transition.
    expect(patchAttempt).not.toHaveBeenCalledWith('att-1', { end: { reason: 'solved' } });
    expect(flushAttemptEnd).not.toHaveBeenCalled();
  });

  it('never claims solved in readonly mode', async () => {
    const latestAttempt = attemptRow({
      id: 'att-3',
      number: 3,
      endedAt: new Date().toISOString(),
      endReason: 'solved',
    });
    createOrResumeAttempt.mockResolvedValue({ attempt: null, readonly: true, latestAttempt });

    const { unmount } = renderRoom();
    await screen.findByText(/Solved/);

    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(patchAttempt).not.toHaveBeenCalled();
    expect(flushAttemptEnd).not.toHaveBeenCalled();
  });
});

// NEE-356: prose (design/behavioral) attempts are ended by the SERVER when
// their review completes — there is no test run for the client to watch, so
// the room learns about it from the 'attempt-ended' SSE event and reloads,
// letting the server decide what the room becomes (readonly reference when
// the verdict solved it, a fresh attempt when it did not).
describe('Room reacts to a server-side attempt end (NEE-356)', () => {
  it('reloads into readonly reference mode when the review closes the attempt as solved', async () => {
    const attempt = attemptRow({ id: 'att-1', number: 1 });
    const endedAttempt = attemptRow({
      id: 'att-1',
      number: 1,
      endedAt: new Date().toISOString(),
      endReason: 'solved',
    });
    getQuestionDetail.mockResolvedValue(proseDetail());
    // first open: live attempt; after the server ends it: readonly reference
    createOrResumeAttempt.mockResolvedValueOnce({ attempt });
    createOrResumeAttempt.mockResolvedValueOnce({
      attempt: null,
      readonly: true,
      latestAttempt: endedAttempt,
    });

    renderRoom();
    await screen.findByTestId('editor-file:///story.md');
    expect(screen.queryByText(/read-only reference/)).not.toBeInTheDocument();

    act(() => {
      emitSse('attempt-ended', {
        attemptId: 'att-1',
        questionId: 'q-1',
        attempt: endedAttempt,
      });
    });

    expect(await screen.findByText(/read-only reference/)).toBeInTheDocument();
    // both affordances the ticket unlocked for prose are now reachable
    expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeInTheDocument();
    expect(createOrResumeAttempt).toHaveBeenCalledTimes(2);
  });

  it('reloads into a fresh editable attempt when the verdict fell short of solved', async () => {
    const attempt = attemptRow({ id: 'att-1', number: 1 });
    const endedAttempt = attemptRow({
      id: 'att-1',
      number: 1,
      endedAt: new Date().toISOString(),
      endReason: 'submitted',
    });
    getQuestionDetail.mockResolvedValue(proseDetail());
    createOrResumeAttempt.mockResolvedValueOnce({ attempt });
    // unsolved question, no active attempt -> the server mints attempt #2
    createOrResumeAttempt.mockResolvedValueOnce({ attempt: attemptRow({ id: 'att-2', number: 2 }) });

    renderRoom();
    await screen.findByTestId('editor-file:///story.md');

    act(() => {
      emitSse('attempt-ended', {
        attemptId: 'att-1',
        questionId: 'q-1',
        attempt: endedAttempt,
      });
    });

    await waitFor(() => {
      expect(createOrResumeAttempt).toHaveBeenCalledTimes(2);
    });
    // still editable — a missed verdict is not a solved question
    await waitFor(() => {
      expect(screen.getByTestId('editor-file:///story.md')).not.toHaveAttribute('readonly');
    });
    expect(screen.queryByText(/read-only reference/)).not.toBeInTheDocument();
  });

  it('ignores an attempt-ended for a different attempt', async () => {
    const attempt = attemptRow({ id: 'att-1', number: 1 });
    getQuestionDetail.mockResolvedValue(proseDetail());
    createOrResumeAttempt.mockResolvedValue({ attempt });

    renderRoom();
    await screen.findByTestId('editor-file:///story.md');

    act(() => {
      emitSse('attempt-ended', {
        attemptId: 'att-99',
        questionId: 'q-other',
        attempt: attemptRow({ id: 'att-99', endedAt: new Date().toISOString() }),
      });
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(createOrResumeAttempt).toHaveBeenCalledTimes(1);
  });
});
