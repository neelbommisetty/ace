import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusChip } from './Chip';
import type { QuestionStatus } from '../types';

describe('StatusChip', () => {
  const cases: Array<[QuestionStatus, string, string]> = [
    ['not-attempted', 'not attempted', 'chip-status-not-attempted'],
    ['in-progress', 'in progress', 'chip-status-in-progress'],
    ['solved', 'solved', 'chip-status-solved'],
  ];

  it.each(cases)('renders %s as "%s" with class %s', (status, label, className) => {
    render(<StatusChip status={status} />);
    const chip = screen.getByText(label);
    expect(chip).toHaveClass(className);
  });
});
