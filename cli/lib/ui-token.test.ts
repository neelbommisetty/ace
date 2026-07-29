import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateUiToken, rotateUiToken, uiTokenPath } from './ui-token.js';

let tempHome = '';
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  // getGlobalAceDir() resolves through process.env.HOME — point it at a
  // fresh temp dir so tests never touch the real ~/.ace/ui-token.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ui-token-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('loadOrCreateUiToken', () => {
  it('creates ~/.ace/ui-token on first call, mode 0600, non-empty', () => {
    const token = loadOrCreateUiToken();

    expect(token).toBeTruthy();
    expect(uiTokenPath()).toBe(path.join(tempHome, '.ace', 'ui-token'));
    const stat = fs.statSync(uiTokenPath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(uiTokenPath(), 'utf8').trim()).toBe(token);
  });

  it('reuses the same token on a later call (persists across restarts)', () => {
    const first = loadOrCreateUiToken();
    const second = loadOrCreateUiToken();

    expect(second).toBe(first);
  });

  it('regenerates when the file exists but is empty/corrupt', () => {
    fs.mkdirSync(path.join(tempHome, '.ace'), { recursive: true });
    fs.writeFileSync(uiTokenPath(), '   \n', 'utf8');

    const token = loadOrCreateUiToken();

    expect(token).toBeTruthy();
    expect(fs.readFileSync(uiTokenPath(), 'utf8').trim()).toBe(token);
  });

  it('never leaves the temp write file behind', () => {
    loadOrCreateUiToken();

    const entries = fs.readdirSync(path.join(tempHome, '.ace'));
    expect(entries).toEqual(['ui-token']);
  });
});

describe('rotateUiToken', () => {
  it('replaces a previously persisted token with a new one', () => {
    const original = loadOrCreateUiToken();
    const rotated = rotateUiToken();

    expect(rotated).not.toBe(original);
    expect(fs.readFileSync(uiTokenPath(), 'utf8').trim()).toBe(rotated);
    // The old token no longer round-trips from disk.
    expect(loadOrCreateUiToken()).toBe(rotated);
  });

  it('is idempotent-safe to call on a completely fresh home (no prior file)', () => {
    const rotated = rotateUiToken();

    expect(rotated).toBeTruthy();
    expect(loadOrCreateUiToken()).toBe(rotated);
  });
});
