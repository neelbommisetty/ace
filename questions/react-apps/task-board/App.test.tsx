import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';

// Contract under test: add / toggle / filter / clear-done over one in-memory
// task list. Filtering is a render-time view — it never changes what is
// stored, and the counter always reflects the whole list.

function addTask(title: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), {
    target: { value: title },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
}

function titles(): string[] {
  return screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
}

describe('Sprint Task Board', () => {
  it('starts empty with the placeholder and a zeroed counter', () => {
    render(<App />);

    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
    expect(screen.getByText('0 of 0 done')).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('appends tasks in submission order and clears the input', () => {
    render(<App />);

    addTask('Write the RFC');
    addTask('Ship the migration');

    const items = titles();
    expect(items).toHaveLength(2);
    // New tasks go to the bottom, so the RFC stays first.
    expect(items[0]).toContain('Write the RFC');
    expect(items[1]).toContain('Ship the migration');
    expect((screen.getByRole('textbox', { name: 'New task' }) as HTMLInputElement).value).toBe('');
  });

  it('trims the title before storing it', () => {
    render(<App />);

    addTask('   Write the RFC   ');

    expect(screen.getByRole('checkbox', { name: 'Write the RFC' })).toBeTruthy();
  });

  it('rejects a blank submission without clearing the field', () => {
    render(<App />);

    fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), {
      target: { value: '    ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    // The user's text survives a rejected submit.
    expect((screen.getByRole('textbox', { name: 'New task' }) as HTMLInputElement).value).toBe(
      '    ',
    );
  });

  it('adds on form submit exactly as it does on button click', () => {
    render(<App />);

    const input = screen.getByRole('textbox', { name: 'New task' });
    fireEvent.change(input, { target: { value: 'Backfill the index' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: 'Backfill the index' })).toBeTruthy();
  });

  it('toggles a task done and back', () => {
    render(<App />);
    addTask('Write the RFC');

    const box = screen.getByRole('checkbox', { name: 'Write the RFC' }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    expect(
      (screen.getByRole('checkbox', { name: 'Write the RFC' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText('1 of 1 done')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Write the RFC' }));
    expect(
      (screen.getByRole('checkbox', { name: 'Write the RFC' }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByText('0 of 1 done')).toBeTruthy();
  });

  it('keeps duplicate titles independent', () => {
    render(<App />);
    addTask('Review PR');
    addTask('Review PR');

    const boxes = screen.getAllByRole('checkbox', { name: 'Review PR' }) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);

    fireEvent.click(boxes[0]);

    const after = screen.getAllByRole('checkbox', { name: 'Review PR' }) as HTMLInputElement[];
    // Toggling by id, not by title: only the first one flips.
    expect(after[0].checked).toBe(true);
    expect(after[1].checked).toBe(false);
    expect(screen.getByText('1 of 2 done')).toBeTruthy();
  });

  it('filters the view without changing the counter or the stored list', () => {
    render(<App />);
    addTask('Write the RFC');
    addTask('Ship the migration');
    addTask('Backfill the index');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship the migration' }));

    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    // 3 tasks, 1 done -> 2 remain active.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('1 of 3 done')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('1 of 3 done')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('marks exactly one filter as pressed, starting on All', () => {
    render(<App />);

    const pressed = (): string[] =>
      ['All', 'Active', 'Done'].filter(
        (name) =>
          screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true',
      );

    expect(pressed()).toEqual(['All']);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(pressed()).toEqual(['Done']);
  });

  it('shows the placeholder when the active filter yields nothing', () => {
    render(<App />);
    addTask('Write the RFC');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });

  it('clears done tasks and disables the sweep when there is nothing to sweep', () => {
    render(<App />);
    addTask('Write the RFC');
    addTask('Ship the migration');

    const clear = screen.getByRole('button', { name: 'Clear done' }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Write the RFC' }));
    expect((screen.getByRole('button', { name: 'Clear done' }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear done' }));

    const remaining = titles();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain('Ship the migration');
    expect(screen.getByText('0 of 1 done')).toBeTruthy();
  });
});
