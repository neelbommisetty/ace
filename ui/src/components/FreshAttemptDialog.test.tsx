import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FreshAttemptDialog } from './FreshAttemptDialog';

function renderDialog(props: Partial<ComponentProps<typeof FreshAttemptDialog>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(
    <FreshAttemptDialog
      nextNumber={3}
      category="js-ts"
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('FreshAttemptDialog', () => {
  it('has dialog semantics labelled by its heading', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Start attempt #3?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('focuses the first radio option ("Keep current code") on mount', () => {
    renderDialog();
    expect(screen.getByRole('radio', { name: /Keep current code/ })).toHaveFocus();
  });

  it('restores focus to the invoking element on close (unmount)', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'New attempt';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <FreshAttemptDialog
        nextNumber={3}
        category="js-ts"
        busy={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(trigger).not.toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('closes on Escape when not busy', () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape while busy (attempt in flight)', () => {
    const { onCancel } = renderDialog({ busy: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('traps Tab within the dialog (first <-> last wrap)', () => {
    renderDialog();
    const closeBtn = screen.getByTitle('Close');
    const startBtn = screen.getByRole('button', { name: /Start attempt/ });

    closeBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(startBtn).toHaveFocus();

    startBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeBtn).toHaveFocus();
  });

  // NEE-363: prose categories name what's actually at risk ("story"/"notes",
  // not "code") and default to Keep — same as coding's unchanged default.
  it('names the story for a behavioral question and defaults to keeping it', () => {
    renderDialog({ category: 'behavioral' });
    expect(screen.getByText(/Your current story is snapshotted/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Keep current story/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Reset story to stub/ })).not.toBeChecked();
  });

  it('names the notes for a design question and defaults to keeping them', () => {
    renderDialog({ category: 'design-fe' });
    expect(screen.getByText(/Your current notes are snapshotted/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Keep current notes/ })).toBeChecked();
  });

  it('coding default is unchanged: "Keep current code" is checked first', () => {
    renderDialog({ category: 'js-ts' });
    expect(screen.getByRole('radio', { name: /Keep current code/ })).toBeChecked();
  });
});
