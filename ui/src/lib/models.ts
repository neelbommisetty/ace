import type { LLMSlot, ResolvedModel, SettingsInfo, SlotInfo, SlotRouteInfo } from '../types';

/**
 * True once settings have loaded, mock mode is off, and neither provider has
 * a key — the state in which no paid action may offer an enabled button
 * (NEE-303). Mirrors NewQuestion's original `formDisabled` gate so every
 * paid-action entry point agrees on what "keyless" means.
 */
export function isKeyless(settings: SettingsInfo | null): boolean {
  return (
    settings != null &&
    !settings.mockMode &&
    !settings.openai.configured &&
    !settings.anthropic.configured
  );
}

/** The slot's resolved route, or null while settings are loading/unavailable, keyless, or that slot has none. */
export function resolvedModelFor(
  settings: SettingsInfo | null,
  slot: LLMSlot,
): SlotRouteInfo | null {
  return settings?.models?.[slot]?.route ?? null;
}

/** The slot's whole Settings row — route plus the saved override and its warning. */
export function slotInfoFor(settings: SettingsInfo | null, slot: LLMSlot): SlotInfo | null {
  return settings?.models?.[slot] ?? null;
}

/** 'anthropic/claude-opus-5' — the exact provider/model label shown before invoking a paid action. */
export function modelLabel(model: ResolvedModel): string {
  return `${model.provider}/${model.model}`;
}

/** Display labels for the Settings "Models" section — one per routable step. */
export const SLOT_LABELS: Record<LLMSlot, string> = {
  'draft-problem': 'Draft the problem',
  'author-solution': 'Author the solution',
  'author-tests': 'Author the tests',
  'author-packet': 'Author the interviewer packet',
  'edge-audit': 'Edge audit',
  calibrate: 'Time & complexity check',
  repair: 'Repair & rework',
  review: 'Request review',
  'review-escalated': 'Re-review (escalated)',
  'review-extract': 'Score extraction',
  probe: 'Follow-up probes',
  dispute: 'Dispute a failing test',
  brainstorm: 'Brainstorm',
};

/** The Settings "Models" headings, in display order. */
const GROUP_ORDER = ['Generation pipeline', 'Practice room', 'Creation'] as const;
type GroupHeading = (typeof GROUP_ORDER)[number];

/**
 * Which heading each slot renders under, in display order within its group.
 *
 * Keyed as Record<LLMSlot, …> on purpose (the repo's QuestionType/AUDIT_LABEL
 * tripwire pattern): widening `LLMSlot` breaks the build HERE instead of
 * silently dropping the new slot out of Settings, where it would be
 * permanently unviewable and unedittable even though the server happily
 * accepts an override for it. Declaration order is display order — string
 * keys iterate in insertion order — so a slot lands in the right group no
 * matter where in this table it is added.
 */
const SLOT_GROUP: Record<LLMSlot, GroupHeading> = {
  'draft-problem': 'Generation pipeline',
  'author-solution': 'Generation pipeline',
  'author-tests': 'Generation pipeline',
  'author-packet': 'Generation pipeline',
  'edge-audit': 'Generation pipeline',
  calibrate: 'Generation pipeline',
  repair: 'Generation pipeline',
  review: 'Practice room',
  'review-escalated': 'Practice room',
  'review-extract': 'Practice room',
  probe: 'Practice room',
  dispute: 'Practice room',
  brainstorm: 'Creation',
};

/** Display order: the generation pipeline in run order, then the practice room, then creation. */
export const SLOT_ORDER: LLMSlot[] = GROUP_ORDER.flatMap((heading) =>
  (Object.keys(SLOT_GROUP) as LLMSlot[]).filter((slot) => SLOT_GROUP[slot] === heading),
);

/** SLOT_ORDER split into the headings the Settings "Models" section groups under. */
export const SLOT_GROUPS: Array<{ heading: GroupHeading; slots: LLMSlot[] }> = GROUP_ORDER.map(
  (heading) => ({
    heading,
    slots: SLOT_ORDER.filter((slot) => SLOT_GROUP[slot] === heading),
  }),
);
