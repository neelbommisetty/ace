import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room';
import type { AttemptRow, PreviewStatus, QuestionDetail, QuestionRow } from '../types';

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
let memoryStorage: MemoryStorage;

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
  cancelTestRun,
  postAttemptEvent,
  applyDispute,
  startDispute,
  flushFileSave,
  flushActiveSeconds,
  flushAttemptEnd,
  patchAttempt,
  getPreviewStatus,
  openPreview,
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
    cancelTestRun: vi.fn(),
    postAttemptEvent: vi.fn(),
    applyDispute: vi.fn(),
    startDispute: vi.fn(),
    flushFileSave: vi.fn(),
    flushActiveSeconds: vi.fn(),
    flushAttemptEnd: vi.fn(),
    patchAttempt: vi.fn(),
    getPreviewStatus: vi.fn(),
    openPreview: vi.fn(),
  };
});

// Full replacement mock (not importOriginal — see Room.readonly.test.tsx):
// Room + everything it mounts only ever touches this named set of exports.
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
  cancelTestRun,
  postAttemptEvent,
  applyDispute,
  startDispute,
  flushFileSave,
  flushActiveSeconds,
  flushAttemptEnd,
  patchAttempt,
  getPreviewStatus,
  openPreview,
  getToken: () => 'test-token',
}));

function questionRow(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    category: 'react-apps',
    slug: 'todo-app',
    title: 'Todo App',
    difficulty: 'medium',
    suggestedMinutes: 45,
    dirPath: 'questions/react-apps/todo-app',
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
    activeSeconds: 0,
    hintsUsed: 0,
    imported: false,
    ...overrides,
  };
}

function questionDetail(overrides: Partial<QuestionDetail> = {}): QuestionDetail {
  return {
    question: questionRow(),
    readme: '# Todo App\n\nBuild a todo app.',
    files: [
      { name: 'App.tsx', relPath: 'App.tsx', kind: 'solution', readonly: false },
      { name: 'App.test.tsx', relPath: 'App.test.tsx', kind: 'test', readonly: true },
    ],
    activeAttempt: null,
    lastRun: null,
    ...overrides,
  };
}

function readyStatus(url = 'http://127.0.0.1:5199'): PreviewStatus {
  return { state: 'ready', url, reason: null };
}

function renderRoom(initialPath = '/q/react-apps/todo-app') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/q/:category/:slug" element={<Room />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  memoryStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
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
  getPreviewStatus.mockResolvedValue({ state: 'stopped', url: null, reason: null });
  openPreview.mockResolvedValue(readyStatus());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Room live preview pane — react-group gating (NEE-349)', () => {
  it('offers the preview pane for a react-apps question and auto-starts the dev server', async () => {
    renderRoom();

    await screen.findByTestId('editor-file:///App.tsx');
    await waitFor(() => expect(openPreview).toHaveBeenCalled());
    expect(await screen.findByTitle('Live preview')).toHaveAttribute(
      'src',
      'http://127.0.0.1:5199/preview/react-apps/todo-app/',
    );
  });

  it('does NOT offer a preview pane or Preview console tab for a non-react category', async () => {
    getQuestionDetail.mockResolvedValue(
      questionDetail({
        question: questionRow({ category: 'js-ts', slug: 'closures', dirPath: 'questions/js-ts/closures' }),
        files: [
          { name: 'solution.ts', relPath: 'solution.ts', kind: 'solution', readonly: false },
          { name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true },
        ],
      }),
    );

    renderRoom('/q/js-ts/closures');

    await screen.findByTestId('editor-file:///solution.ts');
    await new Promise((r) => setTimeout(r, 0));
    expect(openPreview).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Live preview')).toBeNull();
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('renders a starting state, not a blank rectangle, before the server is ready', async () => {
    let resolveOpen!: (s: PreviewStatus) => void;
    openPreview.mockReturnValue(new Promise((resolve) => (resolveOpen = resolve)));

    renderRoom();
    await screen.findByTestId('editor-file:///App.tsx');

    expect(await screen.findByText(/starting the preview server/)).toBeInTheDocument();

    resolveOpen(readyStatus());
    expect(await screen.findByTitle('Live preview')).toBeInTheDocument();
  });

  it('renders a failed state with a reason and a working Retry affordance', async () => {
    openPreview.mockResolvedValueOnce({
      state: 'failed',
      url: null,
      reason: 'live preview needs the "vite" package',
    });

    renderRoom();
    await screen.findByTestId('editor-file:///App.tsx');

    expect(await screen.findByText('Preview failed to start')).toBeInTheDocument();
    expect(screen.getByText(/needs the "vite" package/)).toBeInTheDocument();

    openPreview.mockResolvedValueOnce(readyStatus());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTitle('Live preview')).toBeInTheDocument();
    expect(openPreview).toHaveBeenCalledTimes(2);
  });

  it('renders a stopped state (idle-timeout) with a working Start-preview affordance', async () => {
    renderRoom();
    await screen.findByTitle('Live preview');

    // The idle timeout stops the dev server server-side and pushes this
    // over SSE — the manager itself never resolves open() to 'stopped'.
    act(() => {
      emitSse('preview-status', { state: 'stopped', url: null, reason: null });
    });
    expect(await screen.findByText('Preview server is stopped.')).toBeInTheDocument();

    openPreview.mockResolvedValueOnce(readyStatus());
    fireEvent.click(screen.getByRole('button', { name: 'Start preview' }));
    expect(await screen.findByTitle('Live preview')).toBeInTheDocument();
  });

  it('reacts to a preview-status SSE push (e.g. the idle-timeout stopping the server)', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///App.tsx');
    await screen.findByTitle('Live preview');

    act(() => {
      emitSse('preview-status', { state: 'stopped', url: null, reason: null });
    });

    expect(await screen.findByText('Preview server is stopped.')).toBeInTheDocument();
  });

  it('persists the preview pane open/width state through the localStorage key registry', async () => {
    renderRoom();
    await screen.findByTitle('Live preview');

    fireEvent.click(screen.getByTitle('Collapse preview pane'));
    await waitFor(() => expect(memoryStorage.getItem('ace-preview-open')).toBe('false'));
    expect(screen.queryByTitle('Live preview')).toBeNull();

    fireEvent.click(screen.getByTitle('Show live preview'));
    await waitFor(() => expect(memoryStorage.getItem('ace-preview-open')).toBe('true'));
  });

  it('flushes pending saves before reload, then reloads without remounting the iframe', async () => {
    renderRoom();
    const frame = await screen.findByTitle('Live preview');
    const initialSrc = frame.getAttribute('src');

    const editor = await screen.findByTestId('editor-file:///App.tsx');
    fireEvent.change(editor, { target: { value: '// edited' } });

    fireEvent.click(screen.getByTitle('Reload the preview (flushes unsaved edits first)'));

    await waitFor(() => expect(putFile).toHaveBeenCalled());
    // still the same <iframe> element — a remount would have thrown away
    // whatever HMR/live state Vite was holding.
    expect(screen.getByTitle('Live preview')).toBe(frame);
    expect(screen.getByTitle('Live preview').getAttribute('src')).toBe(initialSrc);
  });

  it("forwards a console.error from the preview iframe into the console's Preview tab", async () => {
    renderRoom();
    await screen.findByTitle('Live preview');
    // The Preview tab's own listener attaches from a passive effect keyed
    // off `previewOrigin` — let it settle before dispatching (the iframe
    // itself paints on the same commit that computes previewOrigin, so a
    // bare `findByTitle` can otherwise resolve one tick ahead of it).
    await new Promise((r) => setTimeout(r, 0));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'ace-preview', kind: 'console-error', text: 'boom from the preview', file: null, line: null },
          origin: 'http://127.0.0.1:5199',
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    expect(await screen.findByText('boom from the preview')).toBeInTheDocument();
  });

  it('offers the live preview for a playground question but hides Run, the test console, and the AI panel (NEE-387)', async () => {
    getQuestionDetail.mockResolvedValue(
      questionDetail({
        question: questionRow({
          category: 'playground',
          slug: 'scratch-1',
          source: 'manual',
          dirPath: 'questions/playground/scratch-1',
        }),
        files: [{ name: 'App.tsx', relPath: 'App.tsx', kind: 'solution', readonly: false }],
      }),
    );

    renderRoom('/q/playground/scratch-1');

    await screen.findByTestId('editor-file:///App.tsx');
    await waitFor(() => expect(openPreview).toHaveBeenCalled());
    expect(await screen.findByTitle('Live preview')).toHaveAttribute(
      'src',
      'http://127.0.0.1:5199/preview/playground/scratch-1/',
    );

    expect(screen.queryByTitle('Run tests (⌘/Ctrl+Enter)')).toBeNull();
    expect(screen.queryByTitle('Show test console')).toBeNull();
    expect(screen.queryByText('Tests ▴')).toBeNull();
    expect(screen.queryByTitle('Show AI review panel')).toBeNull();
  });

  it('renders a console-mode preview pane for a playground-ts question, forwards a console-log entry, and clears it (NEE-387)', async () => {
    getQuestionDetail.mockResolvedValue(
      questionDetail({
        question: questionRow({
          category: 'playground-ts',
          slug: 'scratch-1',
          source: 'manual',
          dirPath: 'questions/playground-ts/scratch-1',
        }),
        files: [{ name: 'index.ts', relPath: 'index.ts', kind: 'solution', readonly: false }],
      }),
    );

    renderRoom('/q/playground-ts/scratch-1');

    await screen.findByTestId('editor-file:///index.ts');
    await waitFor(() => expect(openPreview).toHaveBeenCalled());

    const frame = await screen.findByTitle('Live preview');
    expect(frame).toHaveClass('preview-frame-hidden');
    expect(screen.getByText('Console')).toBeInTheDocument();
    expect(screen.queryByTitle('Mobile width')).toBeNull();

    // Let the Preview pane's message listener attach (keyed off previewOrigin,
    // computed from the same commit that paints the iframe — see the
    // forwarding test above for why the settle tick is needed).
    await new Promise((r) => setTimeout(r, 0));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: 'ace-preview',
            kind: 'console-log',
            text: 'hello from the TS playground',
            file: null,
            line: null,
          },
          origin: 'http://127.0.0.1:5199',
        }),
      );
    });

    expect(await screen.findByText('hello from the TS playground')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Clear console'));
    expect(screen.queryByText('hello from the TS playground')).toBeNull();
  });
});
