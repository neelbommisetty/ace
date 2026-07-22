import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room';
import type { AttemptRow, QuestionDetail, QuestionRow } from '../types';

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
    // give it just enough of a fake editor/monaco to not throw.
    props.onMount?.(
      { addCommand: () => {}, focus: () => {} },
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

// Room subscribes to SSE for run/review updates and connection state; none
// of the readonly-mode cases below drive a live event, so a no-op stub is
// enough (same seam as NewQuestion.test.tsx).
vi.mock('../sse', () => ({
  useSseEvent: () => {},
  useSseConnected: () => true,
}));

const {
  ApiErrorMock,
  createOrResumeAttempt,
  getQuestionDetail,
  getFile,
  putFile,
  getTestRuns,
  getReviews,
  getDisputes,
  getAttempt,
  startFreshAttempt,
  startTestRun,
  startReview,
  postAttemptEvent,
  applyDispute,
  startDispute,
  flushFileSave,
  flushActiveSeconds,
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
    getFile: vi.fn(),
    putFile: vi.fn(),
    getTestRuns: vi.fn(),
    getReviews: vi.fn(),
    getDisputes: vi.fn(),
    getAttempt: vi.fn(),
    startFreshAttempt: vi.fn(),
    startTestRun: vi.fn(),
    startReview: vi.fn(),
    postAttemptEvent: vi.fn(),
    applyDispute: vi.fn(),
    startDispute: vi.fn(),
    flushFileSave: vi.fn(),
    flushActiveSeconds: vi.fn(),
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
  getFile,
  putFile,
  getTestRuns,
  getReviews,
  getDisputes,
  getAttempt,
  startFreshAttempt,
  startTestRun,
  startReview,
  postAttemptEvent,
  applyDispute,
  startDispute,
  flushFileSave,
  flushActiveSeconds,
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
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
  );
  getTestRuns.mockResolvedValue([]);
  getReviews.mockResolvedValue([]);
  getDisputes.mockResolvedValue([]);
  getAttempt.mockResolvedValue({ attempt: attemptRow(), events: [] });
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
      expect(screen.getAllByTitle('Test file — read-only in M1')).toHaveLength(2);
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
    expect(screen.getAllByTitle('Test file — read-only in M1')).toHaveLength(1);
    expect(screen.getByText('00:42')).toBeInTheDocument();
  });
});
