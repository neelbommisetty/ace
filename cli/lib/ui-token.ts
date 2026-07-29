import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getGlobalAceDir } from './paths.js';

const TOKEN_BASENAME = 'ui-token';

/**
 * Path to the persisted `ace ui` access token — lives alongside config.json
 * in the global ace dir, never inside a workspace (NEE-308).
 */
export function uiTokenPath(): string {
  return path.join(getGlobalAceDir(), TOKEN_BASENAME);
}

/** Atomic write (tmp + rename) at mode 0600, creating ~/.ace/ (0700) first. */
function writeTokenFile(value: string): void {
  const dir = getGlobalAceDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = uiTokenPath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Loads the persisted UI token, generating and persisting one on first
 * launch. A missing, unreadable, or blank file is treated identically —
 * regenerated in place rather than left to break every subsequent launch.
 */
export function loadOrCreateUiToken(): string {
  const file = uiTokenPath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // missing or unreadable — fall through to generate
  }
  const token = randomUUID();
  writeTokenFile(token);
  return token;
}

/**
 * Regenerates and persists a new token, invalidating every previously issued
 * URL/session (`ace ui --rotate-token`).
 */
export function rotateUiToken(): string {
  const token = randomUUID();
  writeTokenFile(token);
  return token;
}
