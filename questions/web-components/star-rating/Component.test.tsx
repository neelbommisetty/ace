import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StarRating } from './Component';

// Contract under test: a fully controlled, keyboard-operable radiogroup of
// star buttons. Rendered state always derives from `value`; every input path
// goes through onChange; readOnly suppresses all of them.

describe('StarRating', () => {
  it('renders max stars inside a named radiogroup, five by default', () => {
    render(<StarRating value={0} label="Order rating" onChange={() => {}} />);

    const group = screen.getByRole('radiogroup', { name: 'Order rating' });
    expect(group).toBeTruthy();
    // max defaults to 5 -> exactly 5 radios.
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  it('honours a custom max', () => {
    render(<StarRating value={0} max={3} label="Rating" onChange={() => {}} />);

    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('checks exactly the star matching value, and none at zero', () => {
    const { rerender } = render(<StarRating value={3} label="Rating" onChange={() => {}} />);

    const checkedStates = screen.getAllByRole('radio').map((el) => el.getAttribute('aria-checked'));
    // value=3 -> the 3rd star (index 2) is the only checked one.
    expect(checkedStates).toEqual(['false', 'false', 'true', 'false', 'false']);

    rerender(<StarRating value={0} label="Rating" onChange={() => {}} />);
    expect(
      screen.getAllByRole('radio').every((el) => el.getAttribute('aria-checked') === 'false'),
    ).toBe(true);
  });

  it('names each star with a correctly pluralised label', () => {
    render(<StarRating value={0} max={3} label="Rating" onChange={() => {}} />);

    const names = screen.getAllByRole('radio').map((el) => el.getAttribute('aria-label'));
    expect(names).toEqual(['1 star', '2 stars', '3 stars']);
  });

  it('emits the 1-based star number on click', () => {
    const onChange = vi.fn();
    render(<StarRating value={1} label="Rating" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('clears the rating when the already-selected star is clicked', () => {
    const onChange = vi.fn();
    render(<StarRating value={3} label="Rating" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: '3 stars' }));

    // Clicking your own rating is the documented "clear" gesture.
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('is controlled: ignoring onChange leaves the rendering untouched', () => {
    const { rerender } = render(<StarRating value={2} label="Rating" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));

    // The parent dropped the change, so the 2nd star must still be the checked one.
    const afterClick = screen.getAllByRole('radio').map((el) => el.getAttribute('aria-checked'));
    expect(afterClick).toEqual(['false', 'true', 'false', 'false', 'false']);

    rerender(<StarRating value={5} label="Rating" onChange={() => {}} />);
    const afterCommit = screen.getAllByRole('radio').map((el) => el.getAttribute('aria-checked'));
    expect(afterCommit).toEqual(['false', 'false', 'false', 'false', 'true']);
  });

  it('steps the value with the arrow keys', () => {
    const onChange = vi.fn();
    render(<StarRating value={3} label="Rating" onChange={onChange} />);
    const group = screen.getByRole('radiogroup');

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(4); // 3 + 1

    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(4); // still 3 + 1: controlled, value never moved

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(2); // 3 - 1

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(2);

    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('clamps arrow keys at both ends but still emits', () => {
    const onChange = vi.fn();
    const { rerender } = render(<StarRating value={5} label="Rating" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(5); // clamped to max

    rerender(<StarRating value={0} label="Rating" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(0); // clamped to 0

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('jumps to the ends with Home and End', () => {
    const onChange = vi.fn();
    render(<StarRating value={3} max={4} label="Rating" onChange={onChange} />);
    const group = screen.getByRole('radiogroup');

    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(4); // max
  });

  it('ignores unrelated keys', () => {
    const onChange = vi.fn();
    render(<StarRating value={2} label="Rating" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'a' });
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('exposes the group to keyboard focus', () => {
    render(<StarRating value={0} label="Rating" onChange={() => {}} />);

    expect(screen.getByRole('radiogroup').getAttribute('tabindex')).toBe('0');
  });

  it('refuses every input path in readOnly mode', () => {
    const onChange = vi.fn();
    render(<StarRating value={2} label="Rating" readOnly onChange={onChange} />);
    const group = screen.getByRole('radiogroup');

    expect(group.getAttribute('aria-readonly')).toBe('true');
    expect(
      screen.getAllByRole('radio').every((el) => (el as HTMLButtonElement).disabled),
    ).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    fireEvent.keyDown(group, { key: 'Home' });

    expect(onChange).not.toHaveBeenCalled();
    // The value is still rendered, just not editable.
    expect(screen.getByRole('radio', { name: '2 stars' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });
});
