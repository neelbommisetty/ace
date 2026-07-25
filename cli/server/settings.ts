import { loadAceConfig, maskApiKey, saveGlobalAceConfig, type AceConfig } from '../lib/config.js';
import {
  clearConfigCache,
  getDefaultProvider,
  isMockLlm,
  validateAnthropicKey,
  validateOpenAIKey,
  type LLMProvider,
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
 * Provider for server-initiated LLM calls. In mock mode there is always a
 * provider (llm.ts short-circuits every call); otherwise the configured
 * default. Never use requireProvider from server code — it process.exit()s.
 */
export function resolveProvider(): LLMProvider | null {
  if (isMockLlm()) return 'openai';
  return getDefaultProvider();
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
  return {
    openai: toProviderSettings(config.OPENAI_API_KEY, config.OPENAI_BASE_URL),
    anthropic: toProviderSettings(config.ANTHROPIC_API_KEY, config.ANTHROPIC_BASE_URL),
    defaultProvider: getDefaultProvider(),
    mockMode: isMockLlm(),
  };
}

export interface SettingsPatch {
  openaiKey?: string;
  anthropicKey?: string;
  /** string sets, null clears, absent leaves unchanged. */
  openaiBaseUrl?: string | null;
  anthropicBaseUrl?: string | null;
  defaultProvider?: 'openai' | 'anthropic';
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
    configKeys: { key: keyof AceConfig & string; baseUrl: keyof AceConfig & string },
  ) => {
    if (keyPatch === undefined && baseUrlPatch === undefined) return;
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

  if (Object.keys(updates).length > 0) {
    saveGlobalAceConfig(updates);
    clearConfigCache();
  }

  return getSettingsInfo();
}
