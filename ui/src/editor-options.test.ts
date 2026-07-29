import { describe, expect, it } from 'vitest';

import { EDITOR_APPEARANCE } from './editor-options';

describe('EDITOR_APPEARANCE', () => {
  it('turns word wrap on so both the room editor and the dispute diff wrap long lines (NEE-299)', () => {
    expect(EDITOR_APPEARANCE.wordWrap).toBe('on');
  });
});
