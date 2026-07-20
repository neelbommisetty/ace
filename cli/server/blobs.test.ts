import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBlob, saveBlob } from './blobs.js';
import { sha1 } from './files.js';

let tempRoot = '';

function blobsDir(): string {
  return path.join(tempRoot, '.ace', 'blobs');
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-blobs-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('saveBlob', () => {
  it('stores content under its sha1 and round-trips through readBlob', () => {
    const content = 'export const answer = 42;\n';
    const hash = saveBlob(tempRoot, content);

    expect(hash).toBe(sha1(content));
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(blobsDir(), hash), 'utf8')).toBe(content);
    expect(readBlob(tempRoot, hash)).toBe(content);
  });

  it('creates the blobs directory on first use', () => {
    expect(fs.existsSync(blobsDir())).toBe(false);
    saveBlob(tempRoot, 'first');
    expect(fs.statSync(blobsDir()).isDirectory()).toBe(true);
  });

  it('dedupes identical content without rewriting the existing blob', () => {
    const hash = saveBlob(tempRoot, 'same content');
    const blobPath = path.join(blobsDir(), hash);
    const past = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(blobPath, past, past);

    expect(saveBlob(tempRoot, 'same content')).toBe(hash);
    expect(fs.readdirSync(blobsDir())).toEqual([hash]);
    // untouched mtime proves the second save skipped the write entirely
    expect(fs.statSync(blobPath).mtime.getTime()).toBe(past.getTime());
  });

  it('stores distinct content as distinct blobs', () => {
    const a = saveBlob(tempRoot, 'content a');
    const b = saveBlob(tempRoot, 'content b');
    expect(a).not.toBe(b);
    expect(fs.readdirSync(blobsDir()).sort()).toEqual([a, b].sort());
    expect(readBlob(tempRoot, a)).toBe('content a');
    expect(readBlob(tempRoot, b)).toBe('content b');
  });

  it('leaves no tmp files behind (write is tmp + rename)', () => {
    for (let i = 0; i < 20; i++) saveBlob(tempRoot, `blob number ${i}`);
    const entries = fs.readdirSync(blobsDir());
    expect(entries).toHaveLength(20);
    expect(entries.every((name) => /^[0-9a-f]{40}$/.test(name))).toBe(true);
  });

  it('handles empty and multi-byte content', () => {
    const empty = saveBlob(tempRoot, '');
    expect(readBlob(tempRoot, empty)).toBe('');
    const emoji = 'const s = "héllo 🚀";\n';
    expect(readBlob(tempRoot, saveBlob(tempRoot, emoji))).toBe(emoji);
  });
});

describe('readBlob', () => {
  it('returns null for a well-formed hash with no blob', () => {
    expect(readBlob(tempRoot, 'a'.repeat(40))).toBeNull();
  });

  it('rejects malformed hashes', () => {
    saveBlob(tempRoot, 'x');
    for (const bad of [
      '',
      'a'.repeat(39),
      'a'.repeat(41),
      'A'.repeat(40), // uppercase hex is not canonical
      'g'.repeat(40), // non-hex
      `${'a'.repeat(39)} `, // trailing space
      `${'a'.repeat(39)}\n`,
    ]) {
      expect(readBlob(tempRoot, bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects traversal attempts instead of touching the filesystem', () => {
    const secretAbs = path.join(tempRoot, '.ace', 'secret.txt');
    fs.mkdirSync(path.dirname(secretAbs), { recursive: true });
    fs.writeFileSync(secretAbs, 'do not leak', 'utf8');

    for (const evil of [
      '../secret.txt',
      '../../.ace/secret.txt',
      '..%2Fsecret.txt',
      'blobs/../secret.txt',
      `/etc/passwd`,
      `${'a'.repeat(40)}/../secret.txt`,
      '..\\secret.txt',
    ]) {
      expect(readBlob(tempRoot, evil), JSON.stringify(evil)).toBeNull();
    }
  });
});
