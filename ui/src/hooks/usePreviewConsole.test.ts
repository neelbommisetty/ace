import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePreviewConsole } from './usePreviewConsole';

const ORIGIN = 'http://127.0.0.1:5199';

function postFromPreview(data: unknown, origin = ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin }));
  });
}

describe('usePreviewConsole (NEE-351)', () => {
  it('ignores messages until a preview origin is known', () => {
    const { result } = renderHook(() => usePreviewConsole(null));
    postFromPreview({ source: 'ace-preview', kind: 'console-log', text: 'hi', file: null, line: null });
    expect(result.current.entries).toEqual([]);
  });

  it('accepts a well-shaped message from the expected origin', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    postFromPreview({ source: 'ace-preview', kind: 'console-error', text: 'boom', file: null, line: null });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ kind: 'console-error', text: 'boom', count: 1 });
  });

  it('drops a message from an unexpected origin (SECURITY: origin-check)', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    postFromPreview(
      { source: 'ace-preview', kind: 'console-error', text: 'evil', file: null, line: null },
      'http://evil.example',
    );
    expect(result.current.entries).toEqual([]);
  });

  it('drops a malformed payload (missing/wrong-typed fields, wrong source tag)', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    postFromPreview({ source: 'not-ace-preview', kind: 'console-error', text: 'x', file: null, line: null });
    postFromPreview({ source: 'ace-preview', kind: 'console-error', text: 42, file: null, line: null });
    postFromPreview({ source: 'ace-preview', kind: 'console-error' }); // missing text
    // An unrecognised kind is dropped, not rendered with an undefined label —
    // the iframe is untrusted, so only the closed set is accepted (NEE-351).
    postFromPreview({ source: 'ace-preview', kind: 'evil-kind', text: 'x', file: null, line: null });
    postFromPreview('just a string');
    postFromPreview(null);
    expect(result.current.entries).toEqual([]);
  });

  it('collapses consecutive identical (kind, text) messages into one entry with a bumped count', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    for (let i = 0; i < 5; i++) {
      postFromPreview({ source: 'ace-preview', kind: 'console-error', text: 'loop', file: null, line: null });
    }
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].count).toBe(5);
  });

  it('does not collapse across a different kind or text, even back-to-back', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    postFromPreview({ source: 'ace-preview', kind: 'console-error', text: 'a', file: null, line: null });
    postFromPreview({ source: 'ace-preview', kind: 'console-warn', text: 'a', file: null, line: null });
    postFromPreview({ source: 'ace-preview', kind: 'console-warn', text: 'b', file: null, line: null });
    expect(result.current.entries).toHaveLength(3);
    expect(result.current.entries.map((e) => e.count)).toEqual([1, 1, 1]);
  });

  it('caps the buffer, evicting the oldest entries first (never test output — a separate array)', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    for (let i = 0; i < 210; i++) {
      postFromPreview({ source: 'ace-preview', kind: 'console-log', text: `line ${i}`, file: null, line: null });
    }
    expect(result.current.entries.length).toBe(200);
    expect(result.current.entries[0].text).toBe('line 10');
    expect(result.current.entries[result.current.entries.length - 1].text).toBe('line 209');
  });

  it('carries file/line through for a vite-error entry', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    postFromPreview({
      source: 'ace-preview',
      kind: 'vite-error',
      text: 'Unexpected token',
      file: '/ws/questions/react-apps/demo/App.tsx',
      line: 12,
    });
    expect(result.current.entries[0]).toMatchObject({
      kind: 'vite-error',
      file: '/ws/questions/react-apps/demo/App.tsx',
      line: 12,
    });
  });

  it('clear() empties the buffer', () => {
    const { result } = renderHook(() => usePreviewConsole(ORIGIN));
    postFromPreview({ source: 'ace-preview', kind: 'console-log', text: 'x', file: null, line: null });
    expect(result.current.entries).toHaveLength(1);
    act(() => result.current.clear());
    expect(result.current.entries).toEqual([]);
  });
});
