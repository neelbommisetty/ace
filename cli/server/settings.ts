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

function toProviderSettings(key: string | undefined): ProviderSettings {
  return key
    ? { configured: true, masked: maskApiKey(key) }
    : { configured: false, masked: null };
}

export function getSettingsInfo(): SettingsInfo {
  const config = loadAceConfig();
  return {
    openai: toProviderSettings(config.OPENAI_API_KEY),
    anthropic: toProviderSettings(config.ANTHROPIC_API_KEY),
    defaultProvider: getDefaultProvider(),
    mockMode: isMockLlm(),
  };
}

export interface SettingsPatch {
  openaiKey?: string;
  anthropicKey?: string;
  defaultProvider?: 'openai' | 'anthropic';
}

/**
 * Validates any NEW key against its provider before saving anything; an
 * invalid key throws SettingsValidationError and saves nothing. Keys are
 * write-only — the caller only ever gets masked values back.
 */
export async function updateSettings(patch: SettingsPatch): Promise<SettingsInfo> {
  const updates: Partial<AceConfig> = {};

  if (patch.openaiKey !== undefined) {
    const result = await validateOpenAIKey(patch.openaiKey);
    if (!result.valid) {
      throw new SettingsValidationError(
        `OpenAI key validation failed: ${result.error ?? 'unknown error'}`,
      );
    }
    updates.OPENAI_API_KEY = patch.openaiKey;
  }

  if (patch.anthropicKey !== undefined) {
    const result = await validateAnthropicKey(patch.anthropicKey);
    if (!result.valid) {
      throw new SettingsValidationError(
        `Anthropic key validation failed: ${result.error ?? 'unknown error'}`,
      );
    }
    updates.ANTHROPIC_API_KEY = patch.anthropicKey;
  }

  if (patch.defaultProvider !== undefined) {
    updates.default_provider = patch.defaultProvider;
  }

  if (Object.keys(updates).length > 0) {
    saveGlobalAceConfig(updates);
    clearConfigCache();
  }

  return getSettingsInfo();
}
