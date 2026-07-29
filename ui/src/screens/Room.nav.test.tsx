import { render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room';
import type { AttemptRow, QuestionDetail, QuestionRow, QuestionWithStats, TestRunRow } from '../types';

// Node 22+ defines a global `localStorage` accessor that reads as `undefined`
// unless the process is started with --localstorage-file, and it shadows
// happy-dom's own window.localStorage in this test environment. Room.tsx
// reads localStorage synchronously on mount (autorun / AI-panel prefs), so
// give it a real in-memory stand-in.
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

vi.mock('../sse', () => ({
  useSseEvent: (_name: string, _handler: (payload: unknown) => void) => {
    // no-op: these tests don't drive any live SSE events
    const ref = useRef(_handler);
    ref.current = _handler;
    useEffect(() => {}, []);
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
  getSettings,
  getAttempt,
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
    getSettings: vi.fn(),
    getAttempt: vi.fn(),
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
  getSettings,
  getAttempt,
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
    slug: 'bravo',
    title: 'Bravo',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: 'questions/js-ts/bravo',
    source: 'generated',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    missingAt: null,
    ...overrides,
  };
}

function questionWithStats(overrides: Partial<QuestionWithStats> = {}): QuestionWithStats {
  return {
    ...questionRow(),
    stats: {
      attemptCount: 0,
      lastRun: null,
      lastActivityAt: null,
      status: 'not-attempted',
      imported: false,
    },
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

function questionDetail(overrides: Partial<QuestionDetail> = {}): QuestionDetail {
  return {
    question: questionRow(),
    readme: '# Bravo',
    files: [
      { name: 'solution.ts', relPath: 'solution.ts', kind: 'solution', readonly: false },
      { name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true },
    ],
    activeAttempt: null,
    lastRun: null,
    ...overrides,
  };
}

function renderRoom(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/q/:category/:slug" element={<Room />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The four-question fixture shared by the nav tests below: three in
 * 'js-ts' (Alpha < Bravo < Charlie by title and by createdAt) plus one in a
 * different category ('algorithms') to prove category scoping works. */
function fourQuestions(): QuestionWithStats[] {
  return [
    questionWithStats({
      id: 'q-alpha',
      slug: 'alpha',
      title: 'Alpha',
      createdAt: '2026-01-01T00:00:00.000Z',
      stats: { attemptCount: 0, lastRun: null, lastActivityAt: null, status: 'not-attempted', imported: false },
    }),
    questionWithStats({
      id: 'q-bravo',
      slug: 'bravo',
      title: 'Bravo',
      createdAt: '2026-01-02T00:00:00.000Z',
      stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'in-progress', imported: false },
    }),
    questionWithStats({
      id: 'q-charlie',
      slug: 'charlie',
      title: 'Charlie',
      createdAt: '2026-01-03T00:00:00.000Z',
      stats: { attemptCount: 1, lastRun: null, lastActivityAt: null, status: 'not-attempted', imported: false },
    }),
    questionWithStats({
      id: 'q-delta',
      category: 'algorithms',
      slug: 'delta',
      title: 'Delta',
      createdAt: '2026-01-04T00:00:00.000Z',
      stats: { attemptCount: 0, lastRun: null, lastActivityAt: null, status: 'not-attempted', imported: false },
    }),
  ];
}

beforeEach(() => {
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
  );
  getTestRuns.mockResolvedValue([]);
  getReviews.mockResolvedValue([]);
  getDisputes.mockResolvedValue([]);
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

describe('Room prev/next navigation (NEE-310)', () => {
  it('walks the ordering given by the URL context params, carrying them onward', async () => {
    getQuestionDetail.mockResolvedValue(questionDetail({ question: questionRow({ id: 'q-bravo', slug: 'bravo', title: 'Bravo' }) }));
    createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow({ questionId: 'q-bravo' }) });
    getQuestions.mockResolvedValue(fourQuestions());

    renderRoom('/q/js-ts/bravo?category=js-ts&sort=title&dir=asc');

    await screen.findByTestId('editor-file:///solution.ts');

    const prev = await screen.findByRole('link', { name: '← Prev' });
    expect(prev).toHaveAttribute('href', '/q/js-ts/alpha?category=js-ts&sort=title&dir=asc');

    const next = screen.getByRole('link', { name: 'Next →' });
    expect(next).toHaveAttribute('href', '/q/js-ts/charlie?category=js-ts&sort=title&dir=asc');
  });

  it('hides Prev at the start of the ordered list and Next at the end', async () => {
    getQuestionDetail.mockResolvedValue(questionDetail({ question: questionRow({ id: 'q-alpha', slug: 'alpha', title: 'Alpha' }) }));
    createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow({ questionId: 'q-alpha' }) });
    getQuestions.mockResolvedValue(fourQuestions());

    renderRoom('/q/js-ts/alpha?category=js-ts&sort=title&dir=asc');

    await screen.findByTestId('editor-file:///solution.ts');

    expect(screen.queryByRole('link', { name: '← Prev' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Next →' })).toHaveAttribute(
      'href',
      '/q/js-ts/bravo?category=js-ts&sort=title&dir=asc',
    );
  });

  it('falls back to a same-category default order for a deep link with no context params', async () => {
    getQuestionDetail.mockResolvedValue(questionDetail({ question: questionRow({ id: 'q-bravo', slug: 'bravo', title: 'Bravo' }) }));
    createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow({ questionId: 'q-bravo' }) });
    getQuestions.mockResolvedValue(fourQuestions());

    // No query string at all — a bare deep link.
    renderRoom('/q/js-ts/bravo');

    await screen.findByTestId('editor-file:///solution.ts');

    // Default order is newest-activity-first (createdAt fallback), scoped to
    // 'js-ts' only: Charlie, Bravo, Alpha — 'algorithms' Delta never appears.
    const prev = await screen.findByRole('link', { name: '← Prev' });
    expect(prev).toHaveAttribute('href', '/q/js-ts/charlie'); // no query string carried — none was ever present
    const next = screen.getByRole('link', { name: 'Next →' });
    expect(next).toHaveAttribute('href', '/q/js-ts/alpha');
  });

  it('renders neither link when the library has nothing else in the (filtered) order', async () => {
    getQuestionDetail.mockResolvedValue(questionDetail({ question: questionRow({ id: 'q-bravo', slug: 'bravo', title: 'Bravo' }) }));
    createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow({ questionId: 'q-bravo' }) });
    getQuestions.mockResolvedValue([
      questionWithStats({ id: 'q-bravo', slug: 'bravo', title: 'Bravo' }),
    ]);

    renderRoom('/q/js-ts/bravo?category=js-ts');

    await screen.findByTestId('editor-file:///solution.ts');

    expect(screen.queryByRole('link', { name: '← Prev' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Next →' })).toBeNull();
  });
});

describe('Room "Next question" on the solved banner (NEE-310)', () => {
  it('picks the next unsolved question in the ordering and preserves context params onward', async () => {
    const latestAttempt = attemptRow({ id: 'att-3', number: 3, endedAt: new Date().toISOString(), endReason: 'solved' });
    getQuestionDetail.mockResolvedValue(
      questionDetail({ question: questionRow({ id: 'q-charlie', slug: 'charlie', title: 'Charlie' }) }),
    );
    createOrResumeAttempt.mockResolvedValue({ attempt: null, readonly: true, latestAttempt });
    getQuestions.mockResolvedValue([
      ...fourQuestions().map((q) => (q.id === 'q-charlie' ? { ...q, stats: { ...q.stats, status: 'solved' as const } } : q)),
    ]);

    renderRoom('/q/js-ts/charlie?category=js-ts&sort=title&dir=asc');

    expect(await screen.findByText(/Solved/)).toBeInTheDocument();
    // Charlie is last alphabetically among js-ts questions — the next
    // unsolved wraps back around to Alpha, the first not-attempted one.
    const nextQuestion = screen.getByRole('link', { name: 'Next question →' });
    expect(nextQuestion).toHaveAttribute('href', '/q/js-ts/alpha?category=js-ts&sort=title&dir=asc');
    expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeInTheDocument();
  });

  it('hides "Next question" once every other question is solved too', async () => {
    const latestAttempt = attemptRow({ id: 'att-3', number: 3, endedAt: new Date().toISOString(), endReason: 'solved' });
    getQuestionDetail.mockResolvedValue(
      questionDetail({ question: questionRow({ id: 'q-charlie', slug: 'charlie', title: 'Charlie' }) }),
    );
    createOrResumeAttempt.mockResolvedValue({ attempt: null, readonly: true, latestAttempt });
    getQuestions.mockResolvedValue(
      fourQuestions()
        .filter((q) => q.category === 'js-ts')
        .map((q) => ({ ...q, stats: { ...q.stats, status: 'solved' as const } })),
    );

    renderRoom('/q/js-ts/charlie?category=js-ts');

    expect(await screen.findByText(/Solved/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next question →' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeInTheDocument();
  });
});
