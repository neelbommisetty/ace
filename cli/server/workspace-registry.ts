import fs from 'node:fs';
import path from 'node:path';
import { getGlobalAceDir, isWorkspaceInitialized } from '../lib/paths.js';
import type { RecentWorkspace } from '../../shared/wire-types.js';

// The wire shape lives in shared/wire-types.ts (NEE-284); re-exported here so
// registry consumers keep importing it from this module.
export type { RecentWorkspace };

const REGISTRY_BASENAME = 'workspaces.json';
const MAX_RECENTS = 20;

function registryPath(): string {
  return path.join(getGlobalAceDir(), REGISTRY_BASENAME);
}

/** Raw file contents with shape-invalid entries dropped; [] on a missing or corrupt file. */
function readRegistryRaw(): RecentWorkspace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is RecentWorkspace =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as RecentWorkspace).root === 'string' &&
      typeof (entry as RecentWorkspace).lastOpenedAt === 'string',
  );
}

/**
 * Recents for the picker, newest-first. Existence (root present AND its
 * questions/ dir intact) is checked at READ time, not pruned at write time —
 * a workspace on an unmounted disk drops out of the list while unavailable
 * instead of being forgotten forever.
 */
export function readRecentWorkspaces(): RecentWorkspace[] {
  return readRegistryRaw().filter((entry) => isWorkspaceInitialized(entry.root));
}

/**
 * Upserts `root` to the front with a fresh timestamp, capping the file at 20
 * entries. Called on every successful mount: boot with a root, and every
 * switch. The write is atomic (tmp file + rename, mkdir -p first) so a crash
 * mid-write can't corrupt the registry, and best-effort overall: a mount
 * must never fail because ~/.ace is unwritable, so fs errors are logged and
 * swallowed.
 */
export function recordRecentWorkspace(root: string): void {
  try {
    const next = [
      { root, lastOpenedAt: new Date().toISOString() },
      ...readRegistryRaw().filter((entry) => entry.root !== root),
    ].slice(0, MAX_RECENTS);
    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[ace] failed to record recent workspace:', err);
  }
}
