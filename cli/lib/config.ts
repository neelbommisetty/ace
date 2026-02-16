import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getGlobalAceDir } from './paths.js';

export interface AceConfig {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
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
 * Masks an API key for display (shows only last 4 characters).
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return '...' + key.slice(-4);
}
