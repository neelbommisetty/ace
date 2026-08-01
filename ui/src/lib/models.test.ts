import { describe, expect, it } from 'vitest';
import { SLOT_GROUPS, SLOT_LABELS, SLOT_ORDER } from './models';
import type { LLMSlot } from '../types';

// SLOT_ORDER/SLOT_GROUPS decide which slots Settings can show at all: a slot
// missing from them is invisible AND uneditable even though the server
// happily accepts an override for it. They are derived from a
// Record<LLMSlot, …> so widening the union is a compile error — these tests
// pin the derivation itself (that nothing is dropped, duplicated, or
// regrouped), which no type can express.
describe('Settings slot order and grouping', () => {
  const labelled = Object.keys(SLOT_LABELS) as LLMSlot[];

  it('covers every labelled slot exactly once', () => {
    expect([...SLOT_ORDER].sort()).toEqual([...labelled].sort());
    expect(new Set(SLOT_ORDER).size).toBe(SLOT_ORDER.length);
  });

  it('partitions SLOT_ORDER across the groups, in display order', () => {
    expect(SLOT_GROUPS.flatMap((g) => g.slots)).toEqual(SLOT_ORDER);
    expect(SLOT_GROUPS.map((g) => g.heading)).toEqual([
      'Generation pipeline',
      'Practice room',
      'Creation',
    ]);
    for (const group of SLOT_GROUPS) expect(group.slots.length).toBeGreaterThan(0);
  });

  // The grouping used to be positional slices of a hand-kept array (0/7/12),
  // so inserting or moving a slot silently shifted rows under the wrong
  // heading. Membership is now per-slot, so it is worth stating.
  it('puts each slot under the heading it belongs to', () => {
    const headingOf = (slot: LLMSlot): string =>
      SLOT_GROUPS.find((g) => g.slots.includes(slot))!.heading;

    expect(headingOf('draft-problem')).toBe('Generation pipeline');
    expect(headingOf('repair')).toBe('Generation pipeline');
    expect(headingOf('review')).toBe('Practice room');
    expect(headingOf('review-escalated')).toBe('Practice room');
    expect(headingOf('dispute')).toBe('Practice room');
    expect(headingOf('brainstorm')).toBe('Creation');
  });
});
