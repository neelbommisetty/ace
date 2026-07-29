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

/**
 * Writes `content` and returns its hash.
 *
 * NEE-359: writes are NOT registered anywhere for echo suppression any more.
 * Suppression used to live here (a process-global `recentWrites` map the
 * watcher consulted), which meant a write by ANY client — or by the server
 * itself — silenced the `file-changed` broadcast for EVERY connected tab, not
 * just the one that issued it. A second tab then never learned the file had
 * moved, stayed "saved" on stale content, and its next keystroke PUT the
 * whole stale buffer over the first tab's work. The watcher now broadcasts
 * unconditionally; per-tab echo suppression is the client's own
 * `hash === savedHash` check, which is correctly per-tab by construction.
 *
 * NEE-358: written tmp + rename, the same way blobs.ts stores a blob. These
 * are the user's answers, autosaved every 600ms — a crash, a full disk, or an
 * `ace ui` killed mid-write during a bare writeFileSync leaves a truncated
 * solution at the real path with no copy anywhere else. rename(2) within the
 * same directory is atomic, so a reader sees either the old file or the new
 * one, never a half-written one.
 */
export function writeWorkspaceFile(root: string, rel: string, content: string): string {
  const abs = resolveWorkspacePath(root, rel);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  // Same directory as the destination: rename is only atomic within a
  // filesystem, and a tmpdir may well be on another one. The leading dot also
  // keeps the watcher from reporting the temp file as a question file.
  const tmp = path.join(dir, `.tmp-${path.basename(abs)}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return sha1(content);
}
