// getModel is module-private, so these tests observe it through the SDK
// factory mocks: what chatStream causes createOpenAI/createAnthropic to be
// called with. The `ai` entry points are mocked too — no model is ever run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ chat: vi.fn(() => ({ id: 'openai-model' })) })),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ id: 'anthropic-model' }))),
}));
// The error classes stay REAL (importOriginal): the Fable fallback branches
// call APICallError/NoObjectGeneratedError.isInstance on every failure path.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn(() => ({ textStream: (async function* () {})() })),
  generateObject: vi.fn(async () => ({ object: {} })),
  Output: { object: vi.fn((spec: unknown) => spec) },
}));

let tempHome = '';
const originalEnv = { ...process.env };

function writeConfig(config: Record<string, string>): void {
  const aceDir = path.join(tempHome, '.ace');
  fs.mkdirSync(aceDir, { recursive: true });
  fs.writeFileSync(path.join(aceDir, 'config.json'), JSON.stringify(config), 'utf-8');
}

/**
 * Fresh module graph per test: llm.ts caches its config (and reads
 * ACE_E2E_MOCK_LLM) at module scope, and vi.resetModules() re-runs the mock
 * factories, so the factory references must be re-imported alongside it.
 */
async function load() {
  vi.resetModules();
  const llm = await import('./llm.js');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  return { llm, createOpenAI: vi.mocked(createOpenAI), createAnthropic: vi.mocked(createAnthropic) };
}

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

beforeEach(() => {
  // resetModules() in load() re-imports, but the factory-created mock fns are
  // cached by vitest — call history must be cleared explicitly per test.
  vi.clearAllMocks();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
  delete process.env.ACE_E2E_MOCK_LLM;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  if (tempHome && fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('getModel baseURL passthrough', () => {
  it('passes a configured OPENAI_BASE_URL to createOpenAI', async () => {
    writeConfig({ OPENAI_API_KEY: 'k1', OPENAI_BASE_URL: 'http://localhost:4242/v1' });
    const { llm, createOpenAI } = await load();

    await llm.chatStream('draft-problem', MESSAGES);

    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'k1', baseURL: 'http://localhost:4242/v1' }),
    );
  });

  it('omits baseURL entirely when OPENAI_BASE_URL is unset', async () => {
    writeConfig({ OPENAI_API_KEY: 'k1' });
    const { llm, createOpenAI } = await load();

    await llm.chatStream('draft-problem', MESSAGES);

    expect(createOpenAI).toHaveBeenCalledTimes(1);
    expect('baseURL' in createOpenAI.mock.calls[0][0]!).toBe(false);
  });

  it('passes a configured ANTHROPIC_BASE_URL to createAnthropic', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k2', ANTHROPIC_BASE_URL: 'http://localhost:4242/v1' });
    const { llm, createAnthropic } = await load();

    await llm.chatStream('review', MESSAGES);

    expect(createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'k2', baseURL: 'http://localhost:4242/v1' }),
    );
  });

  it('omits baseURL entirely when ANTHROPIC_BASE_URL is unset', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k2' });
    const { llm, createAnthropic } = await load();

    await llm.chatStream('review', MESSAGES);

    expect(createAnthropic).toHaveBeenCalledTimes(1);
    expect('baseURL' in createAnthropic.mock.calls[0][0]!).toBe(false);
  });
});

describe('getModel fetch-tap threading (NEE-322)', () => {
  // chatObjectStream drains partialOutputStream and awaits output, so the
  // default streamText mock (textStream only) must be overridden per call.
  async function loadWithStreamResult() {
    const loaded = await load();
    const { streamText } = await import('ai');
    vi.mocked(streamText).mockReturnValue({
      partialOutputStream: (async function* () {})(),
      output: Promise.resolve({}),
    } as never);
    return loaded;
  }

  const SCHEMA = z.object({});

  it('passes a fetch to both factories only when onStreamActivity is provided', async () => {
    writeConfig({ OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' });
    const { llm, createOpenAI, createAnthropic } = await loadWithStreamResult();

    await llm.chatObjectStream('draft-problem', MESSAGES, SCHEMA, { onStreamActivity: () => {} });
    await llm.chatObjectStream('review', MESSAGES, SCHEMA, { onStreamActivity: () => {} });

    expect(typeof createOpenAI.mock.calls[0][0]!.fetch).toBe('function');
    expect(typeof createAnthropic.mock.calls[0][0]!.fetch).toBe('function');
  });

  it('omits fetch entirely when onStreamActivity is not provided — construction unchanged', async () => {
    writeConfig({ OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' });
    const { llm, createOpenAI, createAnthropic } = await loadWithStreamResult();

    await llm.chatObjectStream('draft-problem', MESSAGES, SCHEMA);
    await llm.chatObjectStream('review', MESSAGES, SCHEMA);

    expect('fetch' in createOpenAI.mock.calls[0][0]!).toBe(false);
    expect('fetch' in createAnthropic.mock.calls[0][0]!).toBe(false);
  });

  it('the threaded fetch fires the activity callback on raw chunks', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k2' });
    // Only ping frames, as the buffering proxy sends for a whole turn — no
    // partial object would ever materialise from these bytes.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('event: ping\n\n'));
                controller.close();
              },
            }),
          ),
      ),
    );
    const { llm, createAnthropic } = await loadWithStreamResult();

    const onStreamActivity = vi.fn();
    await llm.chatObjectStream('review', MESSAGES, SCHEMA, { onStreamActivity });
    const tapped = createAnthropic.mock.calls[0][0]!.fetch as typeof fetch;
    const response = await tapped('http://localhost:4242/v1/messages');
    await response.text();

    expect(onStreamActivity).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });
});

// chatStream never had a fetch tap at all before NEE-361 — mirrors the
// chatObjectStream threading above exactly, per the ticket's "same contract"
// instruction. The default `ai` mock's textStream (empty async generator) is
// enough here; no loadWithStreamResult override needed.
describe('chatStream fetch-tap threading (NEE-361)', () => {
  it('passes a fetch to both factories only when onStreamActivity is provided', async () => {
    writeConfig({ OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' });
    const { llm, createOpenAI, createAnthropic } = await load();

    await llm.chatStream('draft-problem', MESSAGES, { onStreamActivity: () => {} });
    await llm.chatStream('review', MESSAGES, { onStreamActivity: () => {} });

    expect(typeof createOpenAI.mock.calls[0][0]!.fetch).toBe('function');
    expect(typeof createAnthropic.mock.calls[0][0]!.fetch).toBe('function');
  });

  it('omits fetch entirely when onStreamActivity is not provided — construction unchanged', async () => {
    writeConfig({ OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' });
    const { llm, createOpenAI, createAnthropic } = await load();

    await llm.chatStream('draft-problem', MESSAGES);
    await llm.chatStream('review', MESSAGES);

    expect('fetch' in createOpenAI.mock.calls[0][0]!).toBe(false);
    expect('fetch' in createAnthropic.mock.calls[0][0]!).toBe(false);
  });

  it('the threaded fetch fires the activity callback on raw chunks, even with no text output', async () => {
    writeConfig({ ANTHROPIC_API_KEY: 'k2' });
    // Only ping frames, exactly like the buffering-proxy scenario NEE-361
    // fixes — no text chunk would ever come out of this response body.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('event: ping\n\n'));
                controller.close();
              },
            }),
          ),
      ),
    );
    const { llm, createAnthropic } = await load();

    const onStreamActivity = vi.fn();
    await llm.chatStream('review', MESSAGES, { onStreamActivity });
    const tapped = createAnthropic.mock.calls[0][0]!.fetch as typeof fetch;
    const response = await tapped('http://localhost:4280/v1/messages');
    await response.text();

    expect(onStreamActivity).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });
});

describe('key validation probe URLs', () => {
  it('probes {base}/models, stripping trailing slashes env values may carry', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { llm } = await load();

    await llm.validateOpenAIKey('k', 'http://localhost:4242/v1/');
    await llm.validateAnthropicKey('k', 'http://localhost:4242/v1');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4242/v1/models');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:4242/v1/models');
  });

  it('probes the vendor hosts when no base URL is configured', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { llm } = await load();

    await llm.validateOpenAIKey('k');
    await llm.validateAnthropicKey('k');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models');
  });

  // @ai-sdk/anthropic appends /v1 to a bare host at call time; validation has
  // to agree or it rejects a base URL that generation would happily use.
  it('appends /v1 to a bare host for Anthropic, but not for OpenAI', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { llm } = await load();

    await llm.validateAnthropicKey('k', 'http://localhost:4242');
    await llm.validateAnthropicKey('k', 'http://localhost:4242/');
    await llm.validateAnthropicKey('k', 'http://localhost:4242/anthropic');
    await llm.validateOpenAIKey('k', 'http://localhost:4242');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4242/v1/models');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:4242/v1/models');
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:4242/anthropic/models');
    expect(fetchMock.mock.calls[3][0]).toBe('http://localhost:4242/models');
  });
});

describe('key validation error messages', () => {
  it('names the probed host, including when HTTP/2 leaves statusText empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401, statusText: '' })),
    );
    const { llm } = await load();

    expect(await llm.validateOpenAIKey('k')).toEqual({
      valid: false,
      error: '401 from https://api.openai.com/v1',
    });
    expect(await llm.validateAnthropicKey('k', 'http://localhost:4242/v1')).toEqual({
      valid: false,
      error: 'Invalid API key (401) from http://localhost:4242/v1',
    });
  });

  it('keeps the reason phrase when the server sends one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404, statusText: 'Not Found' })),
    );
    const { llm } = await load();

    expect(await llm.validateOpenAIKey('k', 'http://localhost:4242/v1')).toEqual({
      valid: false,
      error: '404 Not Found from http://localhost:4242/v1',
    });
  });
});

// NEE-360: a bare 2xx used to be accepted outright — ace's own SPA
// catch-all (cli/server/routes/static.ts) serves index.html with a 200 for
// ANY extension-less GET, so pointing a base URL at ace's own port (or any
// misconfigured proxy) would green-check the key and every subsequent paid
// call would then die with a bare 404.
describe('key validation false-pass hardening (NEE-360)', () => {
  it('rejects an HTML 200 body as an actionable error, not a valid key', async () => {
    const html = '<!doctype html>\n<html><body>The Room</body></html>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })));
    const { llm } = await load();

    const openai = await llm.validateOpenAIKey('k', 'http://localhost:4280/v1');
    const anthropic = await llm.validateAnthropicKey('k', 'http://localhost:4280/v1');

    expect(openai.valid).toBe(false);
    expect(openai.error).toMatch(/HTML page/i);
    expect(anthropic.valid).toBe(false);
    expect(anthropic.error).toMatch(/HTML page/i);
  });

  it('rejects JSON that is not a models-list body (no "data" array)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { llm } = await load();

    const result = await llm.validateAnthropicKey('k', 'http://localhost:4280/v1');

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not a models-list response/i);
  });

  it('accepts a genuine models-list body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })),
    );
    const { llm } = await load();

    expect(await llm.validateOpenAIKey('k')).toEqual({ valid: true });
    expect(await llm.validateAnthropicKey('k')).toEqual({ valid: true });
  });
});
