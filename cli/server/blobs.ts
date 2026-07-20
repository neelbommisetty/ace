import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha1 } from './files.js';

/** Content-addressed blob store at `<root>/.ace/blobs/<sha1>`. */

const HASH_RE = /^[0-9a-f]{40}$/;

function blobsDir(root: string): string {
  return path.join(root, '.ace', 'blobs');
}

/**
 * Stores content under its sha1; a no-op when the blob already exists.
 * Writes tmp + rename so a crash never leaves a partial blob at the final
 * path. Returns the hash.
 */
export function saveBlob(root: string, content: string): string {
  const hash = sha1(content);
  const dir = blobsDir(root);
  const dest = path.join(dir, hash);
  if (fs.existsSync(dest)) return hash;

  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${hash}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return hash;
}

/** Reads a blob by hash; null when the hash is malformed or the blob is absent. */
export function readBlob(root: string, hash: string): string | null {
  if (!HASH_RE.test(hash)) return null;
  try {
    return fs.readFileSync(path.join(blobsDir(root), hash), 'utf8');
  } catch {
    return null;
  }
}
