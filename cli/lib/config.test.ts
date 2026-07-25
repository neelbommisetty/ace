import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAceConfig, maskApiKey, normalizeBaseUrl, saveGlobalAceConfig } from './config.js';

let tempHome = '';
const originalEnv = { ...process.env };

function setTempHome(): void {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
}

function writeGlobalFile(fileName: string, content: string): string {
  const aceDir = path.join(tempHome, '.ace');
  fs.mkdirSync(aceDir, { recursive: true });
  const target = path.join(aceDir, fileName);
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

beforeEach(() => {
  setTempHome();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
  if (tempHome && fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

describe('loadAceConfig', () => {
  it('prefers config.json over .env and process.env', () => {
    writeGlobalFile('config.json', JSON.stringify({ OPENAI_API_KEY: 'json-key', default_provider: 'openai' }));
    writeGlobalFile('.env', 'OPENAI_API_KEY=envfile-key\nANTHROPIC_API_KEY=anthro-file\n');
    process.env.OPENAI_API_KEY = 'env-var';
    process.env.ANTHROPIC_API_KEY = 'anthro-env';

    const config = loadAceConfig();

    expect(config.OPENAI_API_KEY).toBe('json-key');
    expect(config.ANTHROPIC_API_KEY).toBe('anthro-file');
    expect(config.default_provider).toBe('openai');
  });

  it('falls back to process.env when files are missing', () => {
    process.env.OPENAI_API_KEY = 'env-openai';
    process.env.ANTHROPIC_API_KEY = 'env-anthro';

    const config = loadAceConfig();

    expect(config.OPENAI_API_KEY).toBe('env-openai');
    expect(config.ANTHROPIC_API_KEY).toBe('env-anthro');
  });

  it('ignores invalid config.json and keeps .env values', () => {
    writeGlobalFile('config.json', '{not-json');
    writeGlobalFile('.env', 'OPENAI_API_KEY=envfile-key\n');

    const config = loadAceConfig();

    expect(config.OPENAI_API_KEY).toBe('envfile-key');
  });

  it('resolves base URLs with the same precedence as keys', () => {
    writeGlobalFile('config.json', JSON.stringify({ OPENAI_BASE_URL: 'http://json:1/v1' }));
    process.env.OPENAI_BASE_URL = 'http://env:1/v1';
    process.env.ANTHROPIC_BASE_URL = 'http://env:2/v1';

    const config = loadAceConfig();

    expect(config.OPENAI_BASE_URL).toBe('http://json:1/v1');
    expect(config.ANTHROPIC_BASE_URL).toBe('http://env:2/v1');
  });
});

describe('saveGlobalAceConfig', () => {
  it('merges with existing config and persists to disk', () => {
    writeGlobalFile('config.json', JSON.stringify({ OPENAI_API_KEY: 'existing', default_provider: 'openai' }));

    saveGlobalAceConfig({ ANTHROPIC_API_KEY: 'new-key' });

    const saved = JSON.parse(fs.readFileSync(path.join(tempHome, '.ace', 'config.json'), 'utf-8'));
    expect(saved).toEqual({
      OPENAI_API_KEY: 'existing',
      default_provider: 'openai',
      ANTHROPIC_API_KEY: 'new-key',
    });
  });

  it('removes a key from config.json when saved as explicit undefined', () => {
    writeGlobalFile(
      'config.json',
      JSON.stringify({ OPENAI_API_KEY: 'existing', OPENAI_BASE_URL: 'http://localhost:4242/v1' }),
    );

    saveGlobalAceConfig({ OPENAI_BASE_URL: undefined });

    const saved = JSON.parse(fs.readFileSync(path.join(tempHome, '.ace', 'config.json'), 'utf-8'));
    expect(saved).toEqual({ OPENAI_API_KEY: 'existing' });
  });
});

describe('normalizeBaseUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl('  http://localhost:4242/v1/  ')).toBe('http://localhost:4242/v1');
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
  });

  it('accepts plain http(s) URLs unchanged', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('rejects non-http schemes, scheme-less input, and malformed URLs', () => {
    expect(normalizeBaseUrl('localhost:4242/v1')).toBeNull();
    expect(normalizeBaseUrl('ftp://example.com/v1')).toBeNull();
    expect(normalizeBaseUrl('http://')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
  });
});

describe('maskApiKey', () => {
  it('masks short keys entirely', () => {
    expect(maskApiKey('short')).toBe('***');
  });

  it('shows only the last 4 characters for longer keys', () => {
    expect(maskApiKey('sk-1234567890')).toBe('...7890');
  });
});
