import {
  baseUrlEnvFallback,
  loadAceConfig,
  maskApiKey,
  saveGlobalAceConfig,
  type AceConfig,
} from '../lib/config.js';
import {
  clearConfigCache,
  getAvailableModels,
  getDefaultProvider,
  getModelProvider,
  getSlotDefault,
  getSlotRoutes,
  hasAnyProvider,
  isMockLlm,
  validateAnthropicKey,
  validateOpenAIKey,
  type LLMProvider,
  type LLMSlot,
} from '../lib/llm.js';
import type { ProviderSettings, SettingsInfo } from './types.js';

/** Thrown when a submitted API key fails provider-side validation. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

/**
 * Whether server-initiated LLM calls can run at all. Which model each step
 * uses is per-slot routing's job (`resolveSlot`); this is only the keyless
 * gate. Returns false rather than exiting: a keyless workspace is a normal
 * state the routes answer with a 503, never a reason to kill the server.
 */
export function hasProvider(): boolean {
  return hasAnyProvider();
}

function toProviderSettings(key: string | undefined, baseUrl: string | undefined): ProviderSettings {
  return {
    configured: Boolean(key),
    masked: key ? maskApiKey(key) : null,
    // Not a secret, unlike the key — returned verbatim so the UI can prefill it.
    baseUrl: baseUrl ?? null,
  };
}

export function getSettingsInfo(): SettingsInfo {
  const config = loadAceConfig();
  // Exactly what a real call would resolve, per slot — including mock mode,
  // where every call short-circuits but the route is still the honest one.
  const routes = getSlotRoutes();
  const models = {} as NonNullable<SettingsInfo['models']>;
  let anyRoute = false;
  for (const slot of Object.keys(routes) as LLMSlot[]) {
    const { route, override, warning } = routes[slot];
    if (route != null) anyRoute = true;
    models[slot] = {
      // `warning` and `override` are dropped from the route itself — they are
      // the row's, not the route's, and a slot with NO route still carries
      // both (a rejected override must never be silent, and it must stay
      // clearable).
      route: route == null ? null : { provider: route.provider, model: route.model, source: route.source, defaultModel: getSlotDefault(slot) },
      override,
      warning,
    };
  }
  return {
    openai: toProviderSettings(config.OPENAI_API_KEY, config.OPENAI_BASE_URL),
    anthropic: toProviderSettings(config.ANTHROPIC_API_KEY, config.ANTHROPIC_BASE_URL),
    defaultProvider: getDefaultProvider(),
    mockMode: isMockLlm(),
    // No slot resolving at all is the keyless state the UI gates paid
    // actions on; a single null ENTRY only means that one slot has no route.
    models: anyRoute ? models : null,
    availableModels: getAvailableModels(),
  };
}

export interface SettingsPatch {
  openaiKey?: string;
  anthropicKey?: string;
  /** string sets, null clears, absent leaves unchanged. */
  openaiBaseUrl?: string | null;
  anthropicBaseUrl?: string | null;
  /** @deprecated Routing is per-slot now; saved but never read. */
  defaultProvider?: 'openai' | 'anthropic';
  /** Per-slot model override: a model id sets, null clears, absent leaves unchanged. */
  models?: Partial<Record<LLMSlot, string | null>>;
}

/**
 * Validates the effective (key, base URL) pair for a provider whenever either
 * changes — a base-URL change alone must re-validate the existing key against
 * the new host. Any failure throws SettingsValidationError and saves nothing.
 * Keys are write-only — the caller only ever gets masked values back.
 */
export async function updateSettings(patch: SettingsPatch): Promise<SettingsInfo> {
  const config = loadAceConfig();
  const updates: Partial<AceConfig> = {};

  const applyProvider = async (
    label: string,
    validate: (key: string, baseUrl?: string) => Promise<{ valid: boolean; error?: string }>,
    keyPatch: string | undefined,
    baseUrlPatch: string | null | undefined,
    current: { key: string | undefined; baseUrl: string | undefined },
    configKeys: {
      key: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY';
      baseUrl: 'OPENAI_BASE_URL' | 'ANTHROPIC_BASE_URL';
    },
  ) => {
    if (keyPatch === undefined && baseUrlPatch === undefined) return;
    // Clearing only deletes the config.json entry; a ~/.ace/.env or process.env
    // value would silently resurface through the fallback chain, so reject the
    // clear instead of reporting success the runtime won't honor.
    if (baseUrlPatch === null) {
      const fallback = baseUrlEnvFallback(configKeys.baseUrl);
      if (fallback) {
        throw new SettingsValidationError(
          `${label} base URL is also set to ${fallback} via ~/.ace/.env or the ` +
            `${configKeys.baseUrl} environment variable; clearing it here would have no effect. ` +
            'Remove it from that source instead.',
        );
      }
    }
    const effectiveKey = keyPatch ?? current.key;
    const effectiveBaseUrl = baseUrlPatch === undefined ? current.baseUrl : baseUrlPatch ?? undefined;
    // A base URL saved before any key exists can't be validated yet; the
    // eventual key save validates the pair.
    if (effectiveKey) {
      const result = await validate(effectiveKey, effectiveBaseUrl);
      if (!result.valid) {
        throw new SettingsValidationError(
          `${label} key validation failed: ${result.error ?? 'unknown error'}`,
        );
      }
    }
    if (keyPatch !== undefined) updates[configKeys.key] = keyPatch;
    // Explicit undefined removes the key from config.json on save.
    if (baseUrlPatch !== undefined) updates[configKeys.baseUrl] = baseUrlPatch ?? undefined;
  };

  await applyProvider(
    'OpenAI',
    validateOpenAIKey,
    patch.openaiKey,
    patch.openaiBaseUrl,
    { key: config.OPENAI_API_KEY, baseUrl: config.OPENAI_BASE_URL },
    { key: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  );
  await applyProvider(
    'Anthropic',
    validateAnthropicKey,
    patch.anthropicKey,
    patch.anthropicBaseUrl,
    { key: config.ANTHROPIC_API_KEY, baseUrl: config.ANTHROPIC_BASE_URL },
    { key: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
  );

  if (patch.defaultProvider !== undefined) {
    updates.default_provider = patch.defaultProvider;
  }

  if (patch.models !== undefined) {
    // Validated against the EFFECTIVE config — a key saved in this same
    // patch counts, and llm.ts's cached config is still the pre-save one.
    const effectiveKey = (provider: LLMProvider): string | undefined => {
      const field = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
      const patched = updates[field];
      return (typeof patched === 'string' ? patched : undefined) ?? config[field];
    };
    const overrides: Record<string, string> = { ...(config.model_overrides ?? {}) };
    for (const [slot, model] of Object.entries(patch.models) as Array<[LLMSlot, string | null]>) {
      if (model === null) {
        delete overrides[slot];
        continue;
      }
      const provider = getModelProvider(model);
      if (!provider) {
        throw new SettingsValidationError(`${slot}: "${model}" is not a model ace can route to`);
      }
      // Mock mode has every provider by construction (no call is ever made).
      if (!isMockLlm() && !effectiveKey(provider)) {
        throw new SettingsValidationError(
          `${slot}: no ${provider} API key is configured — add one before selecting "${model}"`,
        );
      }
      overrides[slot] = model;
    }
    updates.model_overrides = overrides;
  }

  if (Object.keys(updates).length > 0) {
    saveGlobalAceConfig(updates);
    clearConfigCache();
  }

  return getSettingsInfo();
}
