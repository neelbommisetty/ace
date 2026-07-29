import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemPane } from './ProblemPane';
import type { SnapshotRow } from '../types';

const { getAttempt, getSnapshots, getSnapshot } = vi.hoisted(() => ({
  getAttempt: vi.fn(),
  getSnapshots: vi.fn(),
  getSnapshot: vi.fn(),
}));

vi.mock('../api', () => ({ getAttempt, getSnapshots, getSnapshot }));

function snapshot(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 's-1',
    questionId: 'q-1',
    attemptId: null,
    relPath: 'questions/behavioral/disagreed/story.md',
    hash: 'a'.repeat(40),
    at: '2026-07-20T10:00:00.000Z',
    trigger: 'reset',
    ...overrides,
  };
}

function renderPane(overrides: Partial<Parameters<typeof ProblemPane>[0]> = {}) {
  return render(
    <ProblemPane
      readme="# Readme"
      category="behavioral"
      slug="disagreed"
      attemptId="a-1"
      attemptNumber={1}
      history={[]}
      disputes={[]}
      onCollapse={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProblemPane — Activity tab "Past attempt code" (NEE-363)', () => {
  it('is not fetched/shown while the Problem tab is active', () => {
    getSnapshots.mockResolvedValue([snapshot()]);
    renderPane();
    expect(getSnapshots).not.toHaveBeenCalled();
    expect(screen.queryByText('Past attempt code')).not.toBeInTheDocument();
  });

  it('lists every past snapshot for the question after switching to Activity', async () => {
    getAttempt.mockResolvedValue({ attempt: {}, events: [] });
    getSnapshots.mockResolvedValue([
      snapshot({ id: 's-1', relPath: 'questions/behavioral/disagreed/story.md' }),
      snapshot({ id: 's-2', relPath: 'questions/behavioral/disagreed/story.md', trigger: 'scaffold' }),
    ]);
    renderPane();

    fireEvent.click(screen.getByText('Activity'));

    await waitFor(() => expect(getSnapshots).toHaveBeenCalledWith('behavioral', 'disagreed'));
    expect(await screen.findByText('Past attempt code')).toBeInTheDocument();
    expect(screen.getAllByText('questions/behavioral/disagreed/story.md')).toHaveLength(2);
  });

  it('lazily fetches and renders the blob content on first expand', async () => {
    getAttempt.mockResolvedValue({ attempt: {}, events: [] });
    getSnapshots.mockResolvedValue([snapshot()]);
    getSnapshot.mockResolvedValue({ ...snapshot(), content: 'my real story text' });
    renderPane();

    fireEvent.click(screen.getByText('Activity'));
    const summary = await screen.findByText('questions/behavioral/disagreed/story.md');
    expect(getSnapshot).not.toHaveBeenCalled();

    fireEvent.click(summary);

    expect(await screen.findByText('my real story text')).toBeInTheDocument();
    expect(getSnapshot).toHaveBeenCalledWith('s-1');
  });

  it('shows "gone from disk" when the blob is missing instead of erroring', async () => {
    getAttempt.mockResolvedValue({ attempt: {}, events: [] });
    getSnapshots.mockResolvedValue([snapshot()]);
    getSnapshot.mockResolvedValue({ ...snapshot(), content: null });
    renderPane();

    fireEvent.click(screen.getByText('Activity'));
    const summary = await screen.findByText('questions/behavioral/disagreed/story.md');
    fireEvent.click(summary);

    expect(await screen.findByText('Snapshot blob is gone from disk.')).toBeInTheDocument();
  });

  it('renders no heading at all when the question has no snapshots yet', async () => {
    getAttempt.mockResolvedValue({ attempt: {}, events: [] });
    getSnapshots.mockResolvedValue([]);
    renderPane();

    fireEvent.click(screen.getByText('Activity'));
    await waitFor(() => expect(getSnapshots).toHaveBeenCalled());
    expect(screen.queryByText('Past attempt code')).not.toBeInTheDocument();
  });
});
