import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room';
import type { AttemptRow, QuestionDetail, QuestionRow } from '../types';

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
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow() });
  getQuestionDetail.mockResolvedValue(questionDetail());
  getQuestions.mockResolvedValue([]);
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
  );
  putFile.mockImplementation((relPath: string) => Promise.resolve({ hash: `hash-${relPath}-v2` }));
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
  sseHandlers.clear();
});

describe('Room keyboard shortcuts overlay (NEE-309)', () => {
  it('opens on "?" and lists the run/save/pane-toggle bindings', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    fireEvent.keyDown(window, { key: '?' });

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('⌘/Ctrl + Enter')).toBeInTheDocument();
    expect(screen.getByText('⌘/Ctrl + S')).toBeInTheDocument();
    expect(screen.getByText('Toggle problem pane')).toBeInTheDocument();
    expect(screen.getByText('Toggle AI panel')).toBeInTheDocument();
    expect(screen.getByText('Toggle console')).toBeInTheDocument();
    expect(screen.getByText('Focus editor')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    fireEvent.keyDown(window, { key: '?' });
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    });
  });

  it('does not open when "?" is typed inside an input/textarea', async () => {
    renderRoom();
    const editor = await screen.findByTestId('editor-file:///solution.ts');

    fireEvent.keyDown(editor, { key: '?' });

    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('Alt+P toggles the problem pane closed and back open', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    // problem pane starts open at default test width; collapsing it swaps in the expander button.
    // Matches by e.code (physical KeyP), not e.key, since macOS composes Option+letter into an
    // alt-glyph character in e.key (see Room.tsx handler) — code is what a real browser reports.
    fireEvent.keyDown(window, { key: 'π', code: 'KeyP', altKey: true });
    await screen.findByTitle('Show problem pane');

    fireEvent.keyDown(window, { key: 'π', code: 'KeyP', altKey: true });
    await waitFor(() => {
      expect(screen.queryByTitle('Show problem pane')).toBeNull();
    });
  });
});
