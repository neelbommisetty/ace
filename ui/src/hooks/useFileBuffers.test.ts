import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useFileBuffers } from './useFileBuffers';
import type { AttemptRow, QuestionDetail, QuestionFileInfo, TestRunTrigger } from '../types';

// NEE-334 defense-in-depth: even if something upstream of useFileBuffers
// mis-resolves which file a change event belongs to, handleChange itself
// must refuse to touch a readonly file's buffer or schedule a save for it.
const { getFile, putFile, flushFileSave, postAttemptEvent } = vi.hoisted(() => ({
  getFile: vi.fn(),
  putFile: vi.fn(),
  flushFileSave: vi.fn(),
  postAttemptEvent: vi.fn(),
}));

vi.mock('../api', () => ({ getFile, putFile, flushFileSave, postAttemptEvent }));
vi.mock('../sse', () => ({ useSseEvent: () => {} }));

function fileInfo(overrides: Partial<QuestionFileInfo> = {}): QuestionFileInfo {
  return {
    name: 'solution.ts',
    relPath: 'solution.ts',
    kind: 'solution',
    readonly: false,
    ...overrides,
  };
}

function questionDetail(files: QuestionFileInfo[]): QuestionDetail {
  return {
    question: {
      id: 'q-1',
      category: 'js-ts',
      slug: 'closures',
      title: 'Closures',
      difficulty: 'medium',
      suggestedMinutes: 30,
      dirPath: '/tmp/q',
      source: 'generated',
      createdAt: new Date().toISOString(),
      archivedAt: null,
      missingAt: null,
    },
    readme: '',
    files,
    activeAttempt: null,
    lastRun: null,
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

function setup(files: QuestionFileInfo[]) {
  const detail = questionDetail(files);
  const startRunRef = { current: vi.fn<(trigger: TestRunTrigger) => void>() };
  const hook = renderHook(() =>
    useFileBuffers({
      detail,
      readonly: false,
      attempt: attemptRow(),
      autorun: false,
      startRunRef,
    }),
  );
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  getFile.mockImplementation((relPath: string) =>
    Promise.resolve({ path: relPath, content: `// ${relPath}`, hash: `hash-${relPath}` }),
  );
  putFile.mockResolvedValue({ hash: 'new-hash' });
  postAttemptEvent.mockResolvedValue({ event: {} });
});

describe('useFileBuffers handleChange readonly guard (NEE-334)', () => {
  it('ignores a change targeting a readonly file: buffer, dirty state, and autosave all untouched', async () => {
    const solutionInfo = fileInfo({ relPath: 'solution.ts', readonly: false });
    const testInfo = fileInfo({ name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true });
    const { result } = setup([solutionInfo, testInfo]);

    await waitFor(() => {
      expect(result.current.files['solution.test.ts'].loaded).toBe(true);
    });
    const originalBuffer = result.current.files['solution.test.ts'].buffer;

    act(() => {
      result.current.handleChange('solution.test.ts', 'sneaked-in content');
    });

    // buffer/save-state untouched
    expect(result.current.files['solution.test.ts'].buffer).toBe(originalBuffer);
    expect(result.current.files['solution.test.ts'].saveState).toBe('saved');

    // give the 600ms autosave debounce a chance to fire, then confirm no PUT
    await new Promise((r) => setTimeout(r, 700));
    expect(putFile).not.toHaveBeenCalled();
  });

  it('still accepts a change targeting an editable file', async () => {
    const solutionInfo = fileInfo({ relPath: 'solution.ts', readonly: false });
    const testInfo = fileInfo({ name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true });
    const { result } = setup([solutionInfo, testInfo]);

    await waitFor(() => {
      expect(result.current.files['solution.ts'].loaded).toBe(true);
    });

    act(() => {
      result.current.handleChange('solution.ts', 'export const solution = 42;');
    });

    expect(result.current.files['solution.ts'].buffer).toBe('export const solution = 42;');
    expect(result.current.files['solution.ts'].saveState).toBe('unsaved');

    await waitFor(() => {
      expect(putFile).toHaveBeenCalledWith('solution.ts', 'export const solution = 42;');
    });
  });
});
