import { act, render, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';
import type { QuestionRow, SseEventMap, SseEventName } from '../types';

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
}));

function emit<K extends SseEventName>(name: K, payload: SseEventMap[K]) {
  act(() => {
    emitSse(name, payload);
  });
}

function question(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    category: 'js-ts',
    slug: 'closures-and-scope',
    title: 'Closures and Scope',
    difficulty: 'medium',
    suggestedMinutes: 30,
    dirPath: 'questions/js-ts/closures-and-scope',
    source: 'generated',
    createdAt: new Date().toISOString(),
    archivedAt: null,
    missingAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  sseHandlers.clear();
});

describe('Toast', () => {
  it('renders nothing before any event fires', () => {
    const { container } = render(
      <MemoryRouter>
        <Toast />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('appears on generation-done with the ready message and an Open room link', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Toast />
      </MemoryRouter>,
    );

    emit('generation-done', { jobId: 'job-1', question: question() });

    expect(await screen.findByText('"Closures and Scope" is ready')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open room' });
    expect(link).toHaveAttribute('href', '/q/js-ts/closures-and-scope');
  });

  it('appears on generation-error with the error message', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Toast />
      </MemoryRouter>,
    );

    emit('generation-error', { jobId: 'job-1', message: 'the model timed out' });

    expect(await screen.findByText('the model timed out')).toBeInTheDocument();
  });

  it('does not render on /new', () => {
    render(
      <MemoryRouter initialEntries={['/new']}>
        <Toast />
      </MemoryRouter>,
    );

    emit('generation-done', { jobId: 'job-1', question: question() });

    expect(screen.queryByText('"Closures and Scope" is ready')).toBeNull();
  });

  it('dismisses when the close button is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Toast />
      </MemoryRouter>,
    );

    emit('generation-done', { jobId: 'job-1', question: question() });
    const dismissed = await screen.findByText('"Closures and Scope" is ready');
    expect(dismissed).toBeInTheDocument();

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText('"Closures and Scope" is ready')).toBeNull();
  });
});
