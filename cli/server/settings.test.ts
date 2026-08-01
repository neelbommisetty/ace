import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettingsInfo, SettingsValidationError, updateSettings } from './settings.js';
import {
  ALL_SLOTS,
  getAvailableModels,
  getDefaultProvider,
  getSlotRoutes,
  isMockLlm,
  validateAnthropicKey,
  validateOpenAIKey,
  type LLMSlot,
  type ResolvedRoute,
  type SlotResolution,
} from '../lib/llm.js';

// Only the environment-reading half is faked; the pure table lookups
// (ALL_SLOTS, getSlotDefault, getModelProvider) stay real, so a slot added to
// SLOT_ROUTES shows up here instead of needing a second hand-kept list.
vi.mock('../lib/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm.js')>();
  return {
    ...actual,
    clearConfigCache: vi.fn(),
    getDefaultProvider: vi.fn(() => null),
    getSlotRoutes: vi.fn(() => ({})),
    getAvailableModels: vi.fn(() => []),
    isMockLlm: vi.fn(() => false),
    validateAnthropicKey: vi.fn(),
    validateOpenAIKey: vi.fn(),
  };
});

const mockValidateOpenAI = vi.mocked(validateOpenAIKey);
const mockValidateAnthropic = vi.mocked(validateAnthropicKey);
const mockGetDefaultProvider = vi.mocked(getDefaultProvider);
const mockGetSlotRoutes = vi.mocked(getSlotRoutes);
const mockGetAvailableModels = vi.mocked(getAvailableModels);
const mockIsMockLlm = vi.mocked(isMockLlm);

/** A full slot->resolution map: `base` everywhere, with the named slots replaced. */
function routes(
  base: ResolvedRoute | null,
  overrides: Partial<Record<LLMSlot, ResolvedRoute | null>> = {},
): Record<LLMSlot, SlotResolution> {
  const map = {} as Record<LLMSlot, SlotResolution>;
  for (const slot of ALL_SLOTS) {
    const route = slot in overrides ? overrides[slot]! : base;
    map[slot] = { route, override: null, warning: route?.warning ?? null };
  }
  return map;
}

let tempHome = '';
const originalEnv = { ...process.env };

function configPath(): string {
  return path.join(tempHome, '.ace', 'config.json');
}

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config), 'utf-8');
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  vi.clearAllMocks();
  mockValidateOpenAI.mockResolvedValue({ valid: true });
  mockValidateAnthropic.mockResolvedValue({ valid: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
  if (tempHome && fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('updateSettings base URLs', () => {
  it('re-validates the existing key against the new host on a base-URL-only patch', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'sk-local-claude-abc' });

    const info = await updateSettings({ anthropicBaseUrl: 'http://localhost:4242/v1' });

    expect(mockValidateAnthropic).toHaveBeenCalledWith('sk-local-claude-abc', 'http://localhost:4242/v1');
    expect(readConfig()).toEqual({
      ANTHROPIC_API_KEY: 'sk-local-claude-abc',
      ANTHROPIC_BASE_URL: 'http://localhost:4242/v1',
    });
    expect(info.anthropic.baseUrl).toBe('http://localhost:4242/v1');
  });

  it('validates a new key against the already-configured base URL', async () => {
    writeConfig({ OPENAI_BASE_URL: 'http://localhost:4242/v1' });

    await updateSettings({ openaiKey: 'sk-local-codex-xyz' });

    expect(mockValidateOpenAI).toHaveBeenCalledWith('sk-local-codex-xyz', 'http://localhost:4242/v1');
    expect(readConfig().OPENAI_API_KEY).toBe('sk-local-codex-xyz');
  });

  it('saves nothing when validation against the new host fails', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'real-key' });
    mockValidateAnthropic.mockResolvedValue({ valid: false, error: '401 Unauthorized' });

    await expect(updateSettings({ anthropicBaseUrl: 'http://localhost:4242/v1' })).rejects.toThrow(
      SettingsValidationError,
    );
    expect(readConfig()).toEqual({ ANTHROPIC_API_KEY: 'real-key' });
  });

  it('clears the base URL (validating against the vendor default) on null', async () => {
    writeConfig({ OPENAI_API_KEY: 'real-key', OPENAI_BASE_URL: 'http://localhost:4242/v1' });

    const info = await updateSettings({ openaiBaseUrl: null });

    expect(mockValidateOpenAI).toHaveBeenCalledWith('real-key', undefined);
    expect(readConfig()).toEqual({ OPENAI_API_KEY: 'real-key' });
    expect(info.openai.baseUrl).toBeNull();
  });

  it('saves a base URL without validation when no key exists yet', async () => {
    writeConfig({});

    const info = await updateSettings({ openaiBaseUrl: 'http://localhost:4242/v1' });

    expect(mockValidateOpenAI).not.toHaveBeenCalled();
    expect(readConfig()).toEqual({ OPENAI_BASE_URL: 'http://localhost:4242/v1' });
    expect(info.openai.configured).toBe(false);
    expect(info.openai.baseUrl).toBe('http://localhost:4242/v1');
  });

  it('rejects clearing a base URL that an env source would resurrect', async () => {
    writeConfig({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://localhost:4242/v1' });
    process.env.OPENAI_BASE_URL = 'http://localhost:4242/v1';

    await expect(updateSettings({ openaiBaseUrl: null })).rejects.toThrow(SettingsValidationError);
    expect(readConfig()).toEqual({
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'http://localhost:4242/v1',
    });
  });

  it('validates a combined key + base URL patch as a pair', async () => {
    writeConfig({});

    await updateSettings({ openaiKey: 'new-key', openaiBaseUrl: 'http://localhost:4242/v1' });

    expect(mockValidateOpenAI).toHaveBeenCalledWith('new-key', 'http://localhost:4242/v1');
    expect(readConfig()).toEqual({
      OPENAI_API_KEY: 'new-key',
      OPENAI_BASE_URL: 'http://localhost:4242/v1',
    });
  });
});

describe('getSettingsInfo models', () => {
  it('is null when no slot resolves at all (keyless, non-mock)', () => {
    mockIsMockLlm.mockReturnValue(false);
    mockGetSlotRoutes.mockReturnValue(routes(null));

    expect(getSettingsInfo().models).toBeNull();
  });

  it('adds each slot its hardcoded default, and keeps a single unroutable slot as null', () => {
    mockIsMockLlm.mockReturnValue(false);
    mockGetDefaultProvider.mockReturnValue('anthropic');
    mockGetSlotRoutes.mockReturnValue(
      routes(
        { provider: 'anthropic', model: 'claude-sonnet-5', source: 'default', warning: null },
        {
          // An openai-only install has no escalation tier at all.
          'review-escalated': null,
          repair: {
            provider: 'openai',
            model: 'gpt-5.6-sol',
            source: 'provider-fallback',
            warning: null,
          },
        },
      ),
    );

    const { models } = getSettingsInfo();

    expect(models?.review).toEqual({
      route: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        source: 'default',
        // The default is the slot's own, not the model that resolved.
        defaultModel: 'claude-sonnet-5',
      },
      override: null,
      warning: null,
    });
    expect(models?.repair).toEqual({
      route: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        source: 'provider-fallback',
        defaultModel: 'claude-fable-5',
      },
      override: null,
      warning: null,
    });
    expect(models?.['review-escalated'].route).toBeNull();
    expect(Object.keys(models!)).toHaveLength(ALL_SLOTS.length);
  });

  it('passes the selectable-model list straight through', () => {
    mockGetSlotRoutes.mockReturnValue(routes(null));
    mockGetAvailableModels.mockReturnValue([{ provider: 'openai', model: 'gpt-5.6-sol' }]);

    expect(getSettingsInfo().availableModels).toEqual([
      { provider: 'openai', model: 'gpt-5.6-sol' },
    ]);
  });
});

describe('updateSettings model overrides', () => {
  it('merges an override into config.json and clears one back to the default with null', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k', model_overrides: { review: 'claude-opus-5' } });

    await updateSettings({ models: { probe: 'claude-haiku-4-5' } });
    expect(readConfig().model_overrides).toEqual({
      review: 'claude-opus-5',
      probe: 'claude-haiku-4-5',
    });

    await updateSettings({ models: { review: null } });
    expect(readConfig().model_overrides).toEqual({ probe: 'claude-haiku-4-5' });
  });

  it('rejects an unknown model, naming the slot, and saves nothing', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k' });

    await expect(updateSettings({ models: { review: 'gpt-9-imaginary' } })).rejects.toThrow(
      /review/,
    );
    expect(readConfig().model_overrides).toBeUndefined();
  });

  it('rejects a model whose provider has no key', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k' });

    await expect(updateSettings({ models: { review: 'gpt-5.6-sol' } })).rejects.toThrow(
      /no openai API key/,
    );
  });

  it('accepts a model whose key lands in the SAME patch', async () => {
    writeConfig({});

    await updateSettings({ openaiKey: 'sk-new', models: { review: 'gpt-5.6-sol' } });

    expect(readConfig().model_overrides).toEqual({ review: 'gpt-5.6-sol' });
  });
});
