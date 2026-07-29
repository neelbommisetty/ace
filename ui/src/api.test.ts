import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * api.ts reads/writes the ace-ui auth token at module-eval time (the ?t=
 * boot handshake) and caches it in a module-level variable, so each test
 * needs a fresh module instance — same pattern App.test.tsx uses.
 */
async function importApi() {
  vi.resetModules();
  return import('./api');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('token bootstrap (NEE-308)', () => {
  it('writes a ?t= URL token into localStorage and strips it from the URL', async () => {
    window.history.pushState({}, '', '/?t=fresh-token&foo=bar');

    const { getToken } = await importApi();

    expect(getToken()).toBe('fresh-token');
    expect(localStorage.getItem('ace-token')).toBe('fresh-token');
    expect(window.location.search).toBe('?foo=bar');
  });

  it('reuses a token already in localStorage when the URL carries none — a bookmarked bare URL works', async () => {
    localStorage.setItem('ace-token', 'stored-token');

    const { getToken } = await importApi();

    expect(getToken()).toBe('stored-token');
  });

  it('getToken is null when neither the URL nor localStorage has a token', async () => {
    const { getToken } = await importApi();

    expect(getToken()).toBeNull();
  });
});

describe('getRelaunchUrl (NEE-308)', () => {
  it('is null when there is no known token', async () => {
    const { getRelaunchUrl } = await importApi();

    expect(getRelaunchUrl()).toBeNull();
  });

  it('builds the exact origin+pathname+?t= URL from the last-known token', async () => {
    localStorage.setItem('ace-token', 'abc-123');
    window.history.pushState({}, '', '/some/path');

    const { getRelaunchUrl } = await importApi();

    expect(getRelaunchUrl()).toBe(`${window.location.origin}/some/path?t=abc-123`);
  });
});

describe('401 retry-once against the stored token (NEE-308)', () => {
  it('succeeds silently when another tab already wrote a fresher token to localStorage', async () => {
    localStorage.setItem('ace-token', 'stale-token');
    const { getWorkspace, setUnauthorizedHandler } = await importApi();
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      if (auth === 'Bearer stale-token') return jsonResponse({ error: 'unauthorized' }, 401);
      if (auth === 'Bearer fresh-token') return jsonResponse({ root: '/w' });
      throw new Error(`unexpected auth header: ${auth}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Simulate a second tab completing a `?t=` handshake in the meantime.
    localStorage.setItem('ace-token', 'fresh-token');

    const result = await getWorkspace();

    expect(result).toEqual({ root: '/w' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('gives up and calls the unauthorized handler when localStorage still holds the same rejected token', async () => {
    localStorage.setItem('ace-token', 'stale-token');
    const { getWorkspace, setUnauthorizedHandler } = await importApi();
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspace()).rejects.toMatchObject({ status: 401 });
    // No retry: the stored token never changed, so a second attempt would be pointless.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('gives up when the retry against a fresher token also 401s', async () => {
    localStorage.setItem('ace-token', 'stale-token');
    const { getWorkspace, setUnauthorizedHandler } = await importApi();
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('ace-token', 'also-bad-token');

    await expect(getWorkspace()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
