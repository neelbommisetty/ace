import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
let memoryStorage: MemoryStorage;

const { formatDocSpy } = vi.hoisted(() => ({ formatDocSpy: vi.fn() }));

// A fake monaco model registry keyed by relPath, mirroring the real
// monaco-editor global model registry that formatDirtyBuffers (NEE-331)
// looks models up in via `monaco.editor.getModel(uri)`. Persists across
// re-renders of the mocked <Editor> below (which — like every other Room
// test's mock — re-invokes onMount on every render, so ANY per-render local
// state has to be backed by this module-level map instead).
const models = new Map<string, { uri: { path: string }; value: string }>();
function modelFor(relPath: string) {
  let m = models.get(relPath);
  if (!m) {
    m = { uri: { path: `/${relPath}` }, value: '' };
    models.set(relPath, m);
  }
  return m;
}

vi.mock('@monaco-editor/react', () => {
  const monacoApi = {
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { Enter: 1, KeyS: 1 },
    Uri: { parse: (s: string) => ({ path: s.replace(/^file:\/\//, '') }) },
    editor: {
      getModel: (uri: { path: string }) =>
        models.get(uri.path.startsWith('/') ? uri.path.slice(1) : uri.path) ?? null,
    },
  };

  return {
    default: (props: {
      path?: string;
      value?: string;
      options?: { readOnly?: boolean };
      onChange?: (value: string) => void;
      onMount?: (editor: unknown, monaco: unknown) => void;
    }) => {
      const relPath = (props.path ?? '').replace(/^file:\/\//, '').replace(/^\//, '');
      const model = modelFor(relPath);
      model.value = props.value ?? '';
      let attached = model;

      const editor = {
        addCommand: () => {},
        focus: () => {},
        getModel: () => attached,
        setModel: (m: typeof model) => {
          attached = m;
        },
        getAction: (id: string) =>
          id === 'editor.action.formatDocument'
            ? {
                run: () => {
                  formatDocSpy(attached.uri.path);
                  // Simulate a real document formatter's edit — mutate the
                  // model and fire onChange, same as Monaco's own
                  // FormattingEdit.execute would via onDidChangeModelContent.
                  attached.value = `/* formatted */${attached.value}`;
                  if (attached === model) props.onChange?.(attached.value);
                  return Promise.resolve();
                },
              }
            : null,
      };
      props.onMount?.(editor, monacoApi);
      return (
        <textarea
          data-testid={`editor-${props.path ?? ''}`}
          readOnly={!!props.options?.readOnly}
          value={model.value}
          onChange={(e) => {
            model.value = e.target.value;
            props.onChange?.(e.target.value);
          }}
        />
      );
    },
  };
});

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
  models.clear();
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
  putFile.mockImplementation((relPath: string) =>
    Promise.resolve({ hash: `hash-${relPath}-v2` }),
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
  startTestRun.mockResolvedValue({ runId: 'run-new' });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  sseHandlers.clear();
});

describe('Room Cmd+S: format then flush (NEE-331)', () => {
  it('formats the active file before flushing the save, without opening a browser save dialog', async () => {
    renderRoom();
    const editor = await screen.findByTestId('editor-file:///solution.ts');
    fireEvent.change(editor, { target: { value: 'const x=1' } });

    const preventDefault = vi.fn();
    act(() => {
      fireEvent.keyDown(window, { key: 's', metaKey: true, preventDefault });
    });

    await waitFor(() => {
      expect(formatDocSpy).toHaveBeenCalledWith('/solution.ts');
    });
    await waitFor(() => {
      expect(putFile).toHaveBeenCalledWith('solution.ts', '/* formatted */const x=1');
    });
  });

  it('skips the format half for a readonly file but still leaves the flush no-op (no crash, no format call)', async () => {
    renderRoom();
    await screen.findByTestId('editor-file:///solution.ts');

    // switch to the readonly test file
    fireEvent.click(screen.getByTitle('solution.test.ts'));
    await screen.findByTestId('editor-file:///solution.test.ts');

    fireEvent.keyDown(window, { key: 's', metaKey: true });

    // give any (wrongly-fired) format microtask a tick to show up
    await new Promise((r) => setTimeout(r, 0));
    expect(formatDocSpy).not.toHaveBeenCalled();
  });
});

describe('Room format-before-run toggle (NEE-331)', () => {
  it('starts unchecked and persists the opt-in to localStorage on toggle', async () => {
    renderRoom();
    const checkbox = await screen.findByLabelText('format before run');
    expect(checkbox).not.toBeChecked();
    await waitFor(() => {
      expect(memoryStorage.getItem('ace-format-before-run')).toBe('false');
    });

    fireEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    await waitFor(() => {
      expect(memoryStorage.getItem('ace-format-before-run')).toBe('true');
    });
  });

  it('formats the dirty file before Run when the toggle is on', async () => {
    memoryStorage.setItem('ace-format-before-run', 'true');
    renderRoom();
    const editor = await screen.findByTestId('editor-file:///solution.ts');
    fireEvent.change(editor, { target: { value: 'const y=2' } });

    fireEvent.click(screen.getByText('Run ⌘↩'));

    await waitFor(() => {
      expect(formatDocSpy).toHaveBeenCalledWith('/solution.ts');
    });
    await waitFor(() => {
      expect(startTestRun).toHaveBeenCalledWith('att-1', 'manual');
    });
    // format happened before the run saw the file
    expect(putFile).toHaveBeenCalledWith('solution.ts', '/* formatted */const y=2');
  });

  it('does not format before Run when the toggle is off', async () => {
    renderRoom();
    const editor = await screen.findByTestId('editor-file:///solution.ts');
    fireEvent.change(editor, { target: { value: 'const z=3' } });

    fireEvent.click(screen.getByText('Run ⌘↩'));

    await waitFor(() => {
      expect(startTestRun).toHaveBeenCalledWith('att-1', 'manual');
    });
    expect(formatDocSpy).not.toHaveBeenCalled();
  });
});

describe('Room background autosave never formats (NEE-331)', () => {
  it('the 600ms debounce saves the raw buffer without ever invoking the format action', async () => {
    renderRoom();
    const editor = await screen.findByTestId('editor-file:///solution.ts');
    fireEvent.change(editor, { target: { value: '// edited, unformatted' } });

    await waitFor(
      () => expect(putFile).toHaveBeenCalledWith('solution.ts', '// edited, unformatted'),
      { timeout: 2000 },
    );
    expect(formatDocSpy).not.toHaveBeenCalled();
  });
});
