import fs from 'node:fs';

/**
 * Reads a UTF-8 file, swallowing ENOENT (and any other read failure) into
 * `fallback` instead of throwing. Consolidates what used to be three
 * differently-spelled copies of "read a file, tolerate it being missing"
 * across cli/server (NEE-291).
 */
export function readFileOr(absPath: string, fallback = ''): string {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return fallback;
  }
}
