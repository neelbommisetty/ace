import type { LLMPurpose, ResolvedModel, SettingsInfo } from '../types';

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

/** The purpose's resolved model, or null while settings are loading/unavailable or keyless. */
export function resolvedModelFor(
  settings: SettingsInfo | null,
  purpose: LLMPurpose,
): ResolvedModel | null {
  return settings?.models?.[purpose] ?? null;
}

/** 'anthropic/claude-opus-5' — the exact provider/model label shown before invoking a paid action. */
export function modelLabel(model: ResolvedModel): string {
  return `${model.provider}/${model.model}`;
}

/** Display order + labels for the Settings "Models" section (NEE-303). */
export const PURPOSE_LABELS: Record<LLMPurpose, string> = {
  generate: 'Generate a question',
  brainstorm: 'Brainstorm',
  review: 'Request review',
  'edge-audit': 'Edge audit',
  dispute: 'Dispute a failing test',
  probe: 'Follow-up probes',
  'review-extract': 'Score extraction',
};

export const PURPOSE_ORDER: LLMPurpose[] = [
  'generate',
  'brainstorm',
  'review',
  'edge-audit',
  'dispute',
  'probe',
  'review-extract',
];
