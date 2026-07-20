import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Thrown when a requested path escapes the workspace questions directory. */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

const RECENT_WRITE_TTL_MS = 5000;

/**
 * Files recently written by the server, keyed by POSIX relPath. The watcher
 * consults this to suppress echo events for our own writes.
 */
export const recentWrites = new Map<string, { hash: string; at: number }>();

function pruneRecentWrites(now: number = Date.now()): void {
  for (const [key, entry] of recentWrites) {
    if (now - entry.at > RECENT_WRITE_TTL_MS) recentWrites.delete(key);
  }
}

export function sha1(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

/** Converts an absolute path into a POSIX relPath from the workspace root. */
export function toWorkspaceRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/**
 * Resolves a workspace-relative path (e.g. `questions/js-ts/foo/solution.ts`)
 * to an absolute path, rejecting anything outside `<root>/questions/`.
 */
export function resolveWorkspacePath(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new ScopeError('Path is required');
  }
  if (rel.includes('\\')) {
    throw new ScopeError('Path must use forward slashes');
  }
  if (path.isAbsolute(rel)) {
    throw new ScopeError('Path must be relative to the workspace root');
  }
  if (rel.split('/').some((segment) => segment === '..')) {
    throw new ScopeError('Path must not contain ".." segments');
  }

  const questionsDir = path.resolve(root, 'questions');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(questionsDir + path.sep)) {
    throw new ScopeError('Path must be inside the questions directory');
  }
  return abs;
}

export function readWorkspaceFile(
  root: string,
  rel: string,
): { content: string; hash: string } | null {
  const abs = resolveWorkspacePath(root, rel);
  let content: string;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  return { content, hash: sha1(content) };
}

export function writeWorkspaceFile(root: string, rel: string, content: string): string {
  const abs = resolveWorkspacePath(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');

  const hash = sha1(content);
  pruneRecentWrites();
  recentWrites.set(toWorkspaceRelPath(root, abs), { hash, at: Date.now() });
  return hash;
}

/** True when the watcher should suppress an event for this relPath+hash. */
export function isRecentWrite(relPath: string, hash: string): boolean {
  pruneRecentWrites();
  const entry = recentWrites.get(relPath);
  return entry !== undefined && entry.hash === hash;
}
