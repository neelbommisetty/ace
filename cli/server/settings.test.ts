import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettingsInfo, SettingsValidationError, updateSettings } from './settings.js';
import { getDefaultProvider, getModelMap, isMockLlm, validateAnthropicKey, validateOpenAIKey } from '../lib/llm.js';

vi.mock('../lib/llm.js', () => ({
  clearConfigCache: vi.fn(),
  getDefaultProvider: vi.fn(() => null),
  getModelMap: vi.fn(() => ({})),
  isMockLlm: vi.fn(() => false),
  validateAnthropicKey: vi.fn(),
  validateOpenAIKey: vi.fn(),
}));

const mockValidateOpenAI = vi.mocked(validateOpenAIKey);
const mockValidateAnthropic = vi.mocked(validateAnthropicKey);
const mockGetDefaultProvider = vi.mocked(getDefaultProvider);
const mockGetModelMap = vi.mocked(getModelMap);
const mockIsMockLlm = vi.mocked(isMockLlm);

let tempHome = '';
const originalEnv = { ...process.env };

function configPath(): string {
  return path.join(tempHome, '.ace', 'config.json');
}

function writeConfig(config: Record<string, string>): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config), 'utf-8');
}

function readConfig(): Record<string, string> {
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

describe('getSettingsInfo models (NEE-303)', () => {
  it('is null when no provider resolves (keyless, non-mock)', () => {
    mockIsMockLlm.mockReturnValue(false);
    mockGetDefaultProvider.mockReturnValue(null);

    expect(getSettingsInfo().models).toBeNull();
    expect(mockGetModelMap).not.toHaveBeenCalled();
  });

  it("wraps getModelMap's ids with the resolved provider for every purpose", () => {
    mockIsMockLlm.mockReturnValue(false);
    mockGetDefaultProvider.mockReturnValue('anthropic');
    mockGetModelMap.mockReturnValue({
      generate: 'claude-opus-5',
      'edge-audit': 'claude-sonnet-5',
      review: 'claude-opus-5',
      'review-extract': 'claude-haiku-4-5',
      brainstorm: 'claude-sonnet-5',
      dispute: 'claude-opus-5',
      probe: 'claude-sonnet-5',
    });

    const { models } = getSettingsInfo();

    expect(mockGetModelMap).toHaveBeenCalledWith('anthropic');
    expect(models).toEqual({
      generate: { provider: 'anthropic', model: 'claude-opus-5' },
      'edge-audit': { provider: 'anthropic', model: 'claude-sonnet-5' },
      review: { provider: 'anthropic', model: 'claude-opus-5' },
      'review-extract': { provider: 'anthropic', model: 'claude-haiku-4-5' },
      brainstorm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      dispute: { provider: 'anthropic', model: 'claude-opus-5' },
      probe: { provider: 'anthropic', model: 'claude-sonnet-5' },
    });
  });

  it('resolves to openai in mock mode even with getDefaultProvider() null', () => {
    mockIsMockLlm.mockReturnValue(true);
    mockGetDefaultProvider.mockReturnValue(null);
    mockGetModelMap.mockReturnValue({
      generate: 'mock-top',
      'edge-audit': 'mock-mid',
      review: 'mock-top',
      'review-extract': 'mock-basic',
      brainstorm: 'mock-mid',
      dispute: 'mock-top',
      probe: 'mock-mid',
    });

    const { models } = getSettingsInfo();

    expect(mockGetModelMap).toHaveBeenCalledWith('openai');
    expect(models?.review).toEqual({ provider: 'openai', model: 'mock-top' });
  });
});
