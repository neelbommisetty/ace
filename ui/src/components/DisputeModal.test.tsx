import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisputeModal } from './DisputeModal';

const { startDispute } = vi.hoisted(() => ({ startDispute: vi.fn() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, startDispute };
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderModal(onClose = vi.fn()) {
  render(
    <DisputeModal
      runId="run-1"
      questionId="q-1"
      testName="handles empty input"
      onClose={onClose}
      onApplied={vi.fn()}
    />,
  );
  return onClose;
}

describe('DisputeModal', () => {
  it('has dialog semantics labelled by its heading', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: 'Dispute failing test' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('focuses the argument textarea on mount', () => {
    renderModal();
    expect(screen.getByLabelText('Your case (optional)')).toHaveFocus();
  });

  it('restores focus to the invoking element on close (unmount)', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Dispute';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(
      <DisputeModal
        runId="run-1"
        questionId="q-1"
        testName="handles empty input"
        onClose={vi.fn()}
        onApplied={vi.fn()}
      />,
    );
    expect(trigger).not.toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('closes on Escape while idle (input phase)', () => {
    const onClose = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape while a dispute analysis is in flight', async () => {
    let resolvePromise: (v: unknown) => void = () => {};
    startDispute.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );
    const onClose = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(await screen.findByText(/analyzing the failure/)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    resolvePromise(undefined);
  });

  it('traps Tab within the dialog (first <-> last wrap)', () => {
    renderModal();
    // DOM order: header close button, textarea, Cancel, Analyze.
    const closeBtn = screen.getByTitle('Close');
    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });

    // Shift+Tab from the first focusable element wraps to the last.
    closeBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(analyzeBtn).toHaveFocus();

    // Tab from the last wraps back to the first.
    analyzeBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeBtn).toHaveFocus();
  });
});
