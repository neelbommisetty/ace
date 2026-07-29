import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorPane, type FileState } from './EditorPane';
import type { QuestionFileInfo } from '../types';

// NEE-334 regression coverage.
//
// monaco-react (4.7.0) keeps ONE Editor instance alive across tab switches
// and just swaps its model. During a tab-switch commit its model-swap effect
// runs *before* it resubscribes onChange, so a change event can fire off a
// listener captured on a PREVIOUS render — one whose closure still thinks
// the active tab is the file we just switched away from — while the
// editor's live model has already moved to the NEW tab. Compounding that,
// monaco-react's value-sync effect calls `editor.setValue(...)` when
// swapping into a *readonly* tab without the change-suppression flag it uses
// on the editable branch, so that swap itself can fire a spurious change
// event carrying the new tab's content.
//
// The fix resolves the emitting file from the editor's *current* model URI
// (captured via onMount into a ref) instead of the `active` prop closed over
// at listener-creation time, and drops anything that resolves to an unknown
// or readonly file. These tests stub @monaco-editor/react with a bare
// prop-recorder (no real Monaco) and drive that exact sequence by hand:
// capturing the onChange closure from one render, then invoking it after
// swapping the fake editor's reported model to a different (readonly) file.
const { editorCalls } = vi.hoisted(() => ({
  editorCalls: [] as Array<{
    path?: string;
    value?: string;
    options?: { readOnly?: boolean };
    onMount?: (editor: unknown, monaco: unknown) => void;
    onChange?: (value: string | undefined) => void;
  }>,
}));

vi.mock('@monaco-editor/react', () => ({
  default: (props: (typeof editorCalls)[number]) => {
    editorCalls.push(props);
    return null;
  },
}));

function fileInfo(overrides: Partial<QuestionFileInfo> = {}): QuestionFileInfo {
  return {
    name: 'solution.ts',
    relPath: 'solution.ts',
    kind: 'solution',
    readonly: false,
    ...overrides,
  };
}

function fileState(info: QuestionFileInfo, buffer: string): FileState {
  return {
    info,
    buffer,
    savedContent: buffer,
    savedHash: 'h',
    loaded: true,
    loadError: null,
    saveState: 'saved',
    lastSavedAt: null,
    saveError: null,
    conflict: false,
  };
}

function baseProps() {
  const solutionInfo = fileInfo({ name: 'solution.ts', relPath: 'solution.ts', kind: 'solution', readonly: false });
  const testInfo = fileInfo({ name: 'solution.test.ts', relPath: 'solution.test.ts', kind: 'test', readonly: true });
  const files: Record<string, FileState> = {
    'solution.ts': fileState(solutionInfo, 'export const solution = 1;'),
    'solution.test.ts': fileState(testInfo, 'test content'),
  };
  const onChange = vi.fn();
  const onSelect = vi.fn();
  const onMount = vi.fn();
  const onConflictReload = vi.fn();
  const onConflictKeep = vi.fn();
  return {
    order: [solutionInfo, testInfo],
    files,
    onChange,
    onSelect,
    onMount,
    onConflictReload,
    onConflictKeep,
  };
}

// A fake monaco editor whose reported model can be swapped independently of
// which render's onChange closure ends up firing — this is what lets the
// test simulate monaco-react's real internal sequencing.
function makeFakeEditor(initialPath: string) {
  let path = initialPath;
  return {
    editor: {
      getModel: () => ({ uri: { path } }),
    },
    setPath: (p: string) => {
      path = p;
    },
  };
}

describe('EditorPane onChange attribution (NEE-334)', () => {
  it('drops a change event attributed the old way during a tab-switch model swap, leaving solution.ts untouched', () => {
    editorCalls.length = 0;
    const props = baseProps();
    const { rerender } = render(<EditorPane {...props} active="solution.ts" />);

    // onMount fires once, from the solution.ts render — capture it into
    // EditorPane's internal editorRef via its own onMount wrapper.
    const fake = makeFakeEditor('/solution.ts');
    expect(editorCalls).toHaveLength(1);
    editorCalls[0].onMount?.(fake.editor, {});

    // Keep a handle on the onChange closure that was live while solution.ts
    // was active — this stands in for "whatever listener monaco-react has
    // subscribed," stale or not.
    const onChangeWhileSolutionActive = editorCalls[0].onChange;
    expect(onChangeWhileSolutionActive).toBeTypeOf('function');

    // User switches to the read-only test tab.
    rerender(<EditorPane {...props} active="solution.test.ts" />);
    expect(editorCalls.length).toBeGreaterThanOrEqual(2);

    // Simulate monaco-react's model-swap effect having already run (it runs
    // before onChange resubscribes): the editor's live model is now the test
    // file's, and the readonly value-sync branch fires a change event onto
    // whatever listener is still attached.
    fake.setPath('/solution.test.ts');
    onChangeWhileSolutionActive?.('malicious test content leaking into solution.ts');

    // The event must never be attributed to solution.ts, dirtying or saving
    // over it, regardless of which render's closure carried it.
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.files['solution.ts'].buffer).toBe('export const solution = 1;');
  });

  it('still attributes a real edit on the active editable tab correctly', () => {
    editorCalls.length = 0;
    const props = baseProps();
    render(<EditorPane {...props} active="solution.ts" />);

    const fake = makeFakeEditor('/solution.ts');
    editorCalls[0].onMount?.(fake.editor, {});
    editorCalls[0].onChange?.('export const solution = 2;');

    expect(props.onChange).toHaveBeenCalledWith('solution.ts', 'export const solution = 2;');
  });

  it('drops an edit that resolves to an unknown model path', () => {
    editorCalls.length = 0;
    const props = baseProps();
    render(<EditorPane {...props} active="solution.ts" />);

    const fake = makeFakeEditor('/not-a-tracked-file.ts');
    editorCalls[0].onMount?.(fake.editor, {});
    editorCalls[0].onChange?.('whatever');

    expect(props.onChange).not.toHaveBeenCalled();
  });
});
