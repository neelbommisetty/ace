import { describe, expect, it } from 'vitest';
import { hasMeaningfulDesignNotes } from './feedback.js';

describe('hasMeaningfulDesignNotes', () => {
  it('treats the untouched template as empty', () => {
    const notes = `# Responsive Accessible Dashboard - Design Notes

## Requirements

### Functional Requirements
<!-- List the core features and user-facing requirements -->

### Non-Functional Requirements
<!-- Performance, scalability, availability, security, etc. -->
`;

    expect(hasMeaningfulDesignNotes(notes)).toBe(false);
  });

  it('treats notes with real content as non-empty even if scaffold comments remain', () => {
    const notes = `# Responsive Accessible Dashboard - Design Notes

## Requirements

### Functional Requirements
<!-- List the core features and user-facing requirements -->
- Users can rearrange dashboard widgets with keyboard and mouse support.

### Non-Functional Requirements
<!-- Performance, scalability, availability, security, etc. -->
The dashboard should remain usable at 320px width and on screen readers.
`;

    expect(hasMeaningfulDesignNotes(notes)).toBe(true);
  });
});
