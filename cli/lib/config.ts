import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getGlobalAceDir } from './paths.js';

export interface AceConfig {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Overrides the vendor API host, e.g. a local proxy. Includes the /v1 path. */
  OPENAI_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  default_provider?: string;
  [key: string]: string | undefined;
}

/**
 * Loads ace config with precedence:
 * 1. ~/.ace/config.json
 * 2. ~/.ace/.env
 * 3. process.env
 */
export function loadAceConfig(): AceConfig {
  const config: AceConfig = {};
  const globalAceDir = getGlobalAceDir();

  // Load from ~/.ace/config.json
  const configPath = path.join(globalAceDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      Object.assign(config, parsed);
    } catch (err) {
      // Silently ignore parse errors
    }
  }

  // Load from ~/.ace/.env as fallback
  const envPath = path.join(globalAceDir, '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = dotenv.parse(fs.readFileSync(envPath));
    // Only add keys that aren't already set
    for (const [key, value] of Object.entries(envConfig)) {
      if (!config[key]) {
        config[key] = value;
      }
    }
  }

  // Fall back to process.env for keys not yet set
  if (!config.OPENAI_API_KEY && process.env.OPENAI_API_KEY) {
    config.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (!config.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY) {
    config.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (!config.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL) {
    config.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
  }
  if (!config.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL) {
    config.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  }

  return config;
}

/**
 * Saves config to ~/.ace/config.json (global).
 * Creates ~/.ace/ if it doesn't exist.
 */
export function saveGlobalAceConfig(partial: Partial<AceConfig>): void {
  const globalAceDir = getGlobalAceDir();

  // Ensure ~/.ace exists
  if (!fs.existsSync(globalAceDir)) {
    fs.mkdirSync(globalAceDir, { recursive: true, mode: 0o700 });
  }

  const configPath = path.join(globalAceDir, 'config.json');

  // Load existing config
  let existing: AceConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Ignore parse errors, will overwrite
    }
  }

  // Merge and save
  const merged = { ...existing, ...partial };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * The value a fallback source (~/.ace/.env or process.env) would supply for a
 * base-URL key even after config.json stops defining it. Clearing a base URL
 * only deletes the config.json entry, so a value here means the clear cannot
 * actually take effect — callers surface that instead of silently no-opping.
 */
export function baseUrlEnvFallback(key: 'OPENAI_BASE_URL' | 'ANTHROPIC_BASE_URL'): string | undefined {
  const envPath = path.join(getGlobalAceDir(), '.env');
  if (fs.existsSync(envPath)) {
    const envConfig = dotenv.parse(fs.readFileSync(envPath));
    if (envConfig[key]) return envConfig[key];
  }
  return process.env[key] || undefined;
}

/**
 * Normalizes a provider base URL: trims whitespace and trailing slashes.
 * Returns null unless the result is a valid http(s) URL. The URL should
 * include the /v1 path segment, matching the AI SDK's baseURL convention
 * (e.g. http://localhost:4242/v1).
 */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * Masks an API key for display (shows only last 4 characters).
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return '...' + key.slice(-4);
}
