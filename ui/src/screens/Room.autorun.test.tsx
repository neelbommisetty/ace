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

vi.mock('@monaco-editor/react', () => ({
  default: (props: {
    path?: string;
    value?: string;
    options?: { readOnly?: boolean };
    onChange?: (value: string) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    // EditorPane's onChange (NEE-334) resolves the emitting file from the
    // editor's current model URI rather than trusting a closed-over prop, so
    // the fake editor needs a getModel() that mirrors the real path — same
    // "file:///<relPath>" -> "/<relPath>" shape monaco's Uri.parse produces.
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

// Full replacement mock (not importOriginal — see Room.readonly.test.tsx):
// Room + everything it mounts only ever touches this named set of exports.
vi.mock('../api', () => ({
  ApiError: ApiErrorMock,
  createOrResumeAttempt,
  getQuestionDetail,
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
  memoryStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
  createOrResumeAttempt.mockResolvedValue({ attempt: attemptRow() });
  getQuestionDetail.mockResolvedValue(questionDetail());
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
  );
  putFile.mockImplementation((relPath: string) =>
    Promise.resolve({ hash: `hash-${relPath}-v2` }),
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
  startTestRun.mockResolvedValue({ runId: 'run-new' });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// Types the editor and lets the real 600ms autosave debounce elapse, without
// relying on fake timers (which would also have to account for the SSE /
// polling effects Room mounts elsewhere).
async function editAndWaitForSave(relPath: string, value: string) {
  const editor = await screen.findByTestId(`editor-file:///${relPath}`);
  fireEvent.change(editor, { target: { value } });
  await waitFor(() => expect(putFile).toHaveBeenCalledWith(relPath, value), { timeout: 2000 });
}

describe('Room auto-run-on-save default', () => {
  it('does not trigger a test run on save when no ace-autorun key is stored', async () => {
    renderRoom();
    await editAndWaitForSave('solution.ts', '// edited once');

    // give the (would-be) auto-run trigger a tick to fire if it were going to
    await new Promise((r) => setTimeout(r, 0));
    expect(startTestRun).not.toHaveBeenCalled();
  });

  it('does not trigger a test run on save when the stored value is neither "true" nor missing', async () => {
    memoryStorage.setItem('ace-autorun', 'false');
    renderRoom();
    await editAndWaitForSave('solution.ts', '// edited with false stored');

    await new Promise((r) => setTimeout(r, 0));
    expect(startTestRun).not.toHaveBeenCalled();
  });

  it('triggers a save-run when the stored value is the literal string "true" (opt-in)', async () => {
    memoryStorage.setItem('ace-autorun', 'true');
    renderRoom();
    await editAndWaitForSave('solution.ts', '// edited with autorun on');

    await waitFor(() => {
      expect(startTestRun).toHaveBeenCalledWith('att-1', 'save');
    });
  });

  it('checkbox starts unchecked by default and persists the opt-in to localStorage on toggle', async () => {
    renderRoom();
    const checkbox = await screen.findByLabelText('auto-run on save');
    expect(checkbox).not.toBeChecked();
    // the persistence effect (Room.tsx) writes the resolved default back on
    // mount, so the missing-key case settles to the literal string 'false'
    await waitFor(() => {
      expect(memoryStorage.getItem('ace-autorun')).toBe('false');
    });

    fireEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    await waitFor(() => {
      expect(memoryStorage.getItem('ace-autorun')).toBe('true');
    });

    // and the opt-in takes effect on the very next save, without a remount
    await editAndWaitForSave('solution.ts', '// edited after toggling on');
    await waitFor(() => {
      expect(startTestRun).toHaveBeenCalledWith('att-1', 'save');
    });
  });
});
