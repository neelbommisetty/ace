import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uiTokenPath } from '../lib/ui-token.js';
import { parseArgs, resolveToken } from './ui.js';

describe('parseArgs', () => {
  it('defaults rotateToken to false', () => {
    expect(parseArgs([]).rotateToken).toBe(false);
  });

  it('sets rotateToken on --rotate-token', () => {
    expect(parseArgs(['--rotate-token']).rotateToken).toBe(true);
  });

  it('combines --rotate-token with the other flags', () => {
    const flags = parseArgs(['--port', '5000', '--rotate-token', '--no-open']);

    expect(flags).toEqual({ port: 5000, workspace: null, open: false, rotateToken: true });
  });
});

describe('resolveToken', () => {
  let tempHome = '';
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalEnvToken = process.env.ACE_UI_TOKEN;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ui-resolve-token-home-'));
    process.env.HOME = tempHome;
    delete process.env.USERPROFILE;
    delete process.env.ACE_UI_TOKEN;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    if (originalEnvToken !== undefined) {
      process.env.ACE_UI_TOKEN = originalEnvToken;
    } else {
      delete process.env.ACE_UI_TOKEN;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('ACE_UI_TOKEN overrides everything, even --rotate-token, and never touches the file', () => {
    process.env.ACE_UI_TOKEN = 'env-token';

    expect(resolveToken(false)).toBe('env-token');
    expect(resolveToken(true)).toBe('env-token');
    expect(fs.existsSync(uiTokenPath())).toBe(false);
  });

  it('persists and reuses a token across separate calls (simulated restarts)', () => {
    const first = resolveToken(false);
    const second = resolveToken(false);

    expect(second).toBe(first);
    expect(fs.readFileSync(uiTokenPath(), 'utf8').trim()).toBe(first);
  });

  it('--rotate-token invalidates the previously persisted token', () => {
    const original = resolveToken(false);
    const rotated = resolveToken(true);

    expect(rotated).not.toBe(original);
    // A later plain launch now reuses the rotated value, not the original.
    expect(resolveToken(false)).toBe(rotated);
  });
});
