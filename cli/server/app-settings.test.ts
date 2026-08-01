// @vitest-environment node
//
// Route-level coverage for /api/settings — specifically the base-URL field
// validation the Settings UI depends on (bad type / empty / invalid URL → 400,
// null → clear). Provider validators are stubbed; no network is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, makeWorkspace, type WorkspaceHandle } from './test-support.js';
import type { SettingsInfo } from './types.js';
import { ALL_SLOTS, clearConfigCache, getModelId } from '../lib/llm.js';

vi.mock('../lib/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/llm.js')>();
  return {
    ...actual,
    validateOpenAIKey: vi.fn(async () => ({ valid: true })),
    validateAnthropicKey: vi.fn(async () => ({ valid: true })),
  };
});

let ws: WorkspaceHandle;
let tempHome = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  ws = makeWorkspace('app-settings');
});

afterEach(() => {
  process.env = { ...originalEnv };
  ws.cleanup();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function buildApp() {
  return makeApp({ getWorkspaceRoot: () => ws.root, getSession: () => ws.session }).fetch;
}

function putSettings(fetch: ReturnType<typeof buildApp>, body: unknown) {
  return fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/settings base-URL fields', () => {
  it('rejects a non-string value with 400', async () => {
    const res = await putSettings(buildApp(), { openaiBaseUrl: 123 });
    expect(res.status).toBe(400);
  });

  it('rejects an empty/whitespace string with 400', async () => {
    const res = await putSettings(buildApp(), { anthropicBaseUrl: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a scheme-less URL with 400', async () => {
    const res = await putSettings(buildApp(), { openaiBaseUrl: 'localhost:4242/v1' });
    expect(res.status).toBe(400);
  });

  it('normalizes and saves a valid URL, returning it in the settings info', async () => {
    const res = await putSettings(buildApp(), { openaiBaseUrl: 'http://localhost:4242/v1/' });
    expect(res.status).toBe(200);
    const info = (await res.json()) as SettingsInfo;
    expect(info.openai.baseUrl).toBe('http://localhost:4242/v1');
  });

  it('accepts null and clears a previously saved base URL', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { anthropicBaseUrl: 'http://localhost:4242/v1' });

    const res = await putSettings(fetch, { anthropicBaseUrl: null });

    expect(res.status).toBe(200);
    const info = (await res.json()) as SettingsInfo;
    expect(info.anthropic.baseUrl).toBeNull();
  });
});

// GET /api/settings routing table — the per-slot resolution exposed for
// cost/model transparency (NEE-303): AiPanel/DisputeModal/NewQuestion read
// this to state what a paid action will invoke *before* it runs, and
// Settings lists the whole table.
describe('GET /api/settings routing table', () => {
  it('is null when no slot can be resolved (keyless, non-mock)', async () => {
    const res = await buildApp()('/api/settings');
    const info = (await res.json()) as SettingsInfo;
    expect(info.models).toBeNull();
    expect(info.availableModels).toEqual([]);
  });

  it('resolves every slot once a key is saved, taking alternates where the default is keyless', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { anthropicKey: 'sk-ant-real' });

    const res = await fetch('/api/settings');
    const info = (await res.json()) as SettingsInfo;

    expect(info.models).not.toBeNull();
    const models = info.models!;
    expect(Object.keys(models)).toHaveLength(ALL_SLOTS.length);
    expect(models.review).toEqual({
      route: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        source: 'default',
        defaultModel: 'claude-sonnet-5',
      },
      override: null,
      warning: null,
    });
    // draft-problem defaults to openai, which has no key here.
    expect(models['draft-problem']).toEqual({
      route: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        source: 'provider-fallback',
        defaultModel: 'gpt-5.6-terra',
      },
      override: null,
      warning: null,
    });
    // Every persisted-model helper agrees with the exposed table.
    expect(models.probe.route?.model).toBe(getModelId('probe'));
    // Only the keyed provider's catalog is selectable.
    expect(info.availableModels.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(info.availableModels).toContainEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });

  it('leaves review-escalated unroutable for an openai-only install', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { openaiKey: 'sk-oai-real' });

    const info = (await (await fetch('/api/settings')).json()) as SettingsInfo;

    expect(info.models!['review-escalated'].route).toBeNull();
    expect(info.models!.review.route?.model).toBe('gpt-5.6-sol');
  });
});

// PUT /api/settings models — per-slot overrides, persisted as
// `model_overrides` in ~/.ace/config.json alongside the keys.
describe('PUT /api/settings model overrides', () => {
  function configPath(): string {
    return path.join(tempHome, '.ace', 'config.json');
  }

  it('saves an override, reflects it in the routing table, and round-trips to config.json', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { anthropicKey: 'sk-ant-real' });

    const res = await putSettings(fetch, { models: { review: 'claude-opus-5' } });

    expect(res.status).toBe(200);
    const info = (await res.json()) as SettingsInfo;
    expect(info.models!.review).toEqual({
      route: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        source: 'override',
        defaultModel: 'claude-sonnet-5',
      },
      override: 'claude-opus-5',
      warning: null,
    });
    const saved = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
    expect(saved.model_overrides).toEqual({ review: 'claude-opus-5' });
  });

  it('clears an override back to the default on null', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { anthropicKey: 'sk-ant-real' });
    await putSettings(fetch, { models: { review: 'claude-opus-5' } });

    const res = await putSettings(fetch, { models: { review: null } });

    const info = (await res.json()) as SettingsInfo;
    expect(info.models!.review.route?.model).toBe('claude-sonnet-5');
    expect(info.models!.review.route?.source).toBe('default');
    expect(info.models!.review.override).toBeNull();
    const saved = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
    expect(saved.model_overrides).toEqual({});
  });

  it('400s an unknown slot, a bad value shape, an unknown model, and a keyless provider — each naming what failed', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { anthropicKey: 'sk-ant-real' });

    const unknownSlot = await putSettings(fetch, { models: { 'not-a-slot': 'claude-opus-5' } });
    expect(unknownSlot.status).toBe(400);
    expect(((await unknownSlot.json()) as { error: string }).error).toContain('not-a-slot');

    const badShape = await putSettings(fetch, { models: { review: 42 } });
    expect(badShape.status).toBe(400);

    const unknownModel = await putSettings(fetch, { models: { review: 'gpt-9-imaginary' } });
    expect(unknownModel.status).toBe(400);
    expect(((await unknownModel.json()) as { error: string }).error).toContain('review');

    const keylessProvider = await putSettings(fetch, { models: { review: 'gpt-5.6-sol' } });
    expect(keylessProvider.status).toBe(400);
    expect(((await keylessProvider.json()) as { error: string }).error).toContain('openai');

    // Nothing was written by any of the rejected patches.
    const saved = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
    expect(saved.model_overrides).toBeUndefined();
  });

  it('surfaces a warning instead of a silent downgrade when a saved override stops being runnable', async () => {
    const fetch = buildApp();
    await putSettings(fetch, { anthropicKey: 'sk-ant-real', openaiKey: 'sk-oai-real' });
    await putSettings(fetch, { models: { review: 'gpt-5.6-sol' } });

    // Drop the openai key straight out of the config, as a hand-edit would.
    const config = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
    delete config.OPENAI_API_KEY;
    fs.writeFileSync(configPath(), JSON.stringify(config), 'utf-8');
    clearConfigCache();

    const info = (await (await fetch('/api/settings')).json()) as SettingsInfo;

    expect(info.models!.review.route?.model).toBe('claude-sonnet-5');
    expect(info.models!.review.warning).toContain('no openai API key');
    // The dead override is still reported, so Settings can offer to clear it
    // (its `source` is 'default', so an override-gated control would not).
    expect(info.models!.review.override).toBe('gpt-5.6-sol');
  });
});
