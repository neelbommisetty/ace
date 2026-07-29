import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ScopeError,
  readWorkspaceFile,
  resolveWorkspacePath,
  sha1,
  writeWorkspaceFile,
} from './files.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-files-'));
  fs.mkdirSync(path.join(root, 'questions', 'js-ts', 'debounce'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveWorkspacePath', () => {
  it('resolves a valid nested path inside questions/', () => {
    const abs = resolveWorkspacePath(root, 'questions/js-ts/debounce/solution.ts');
    expect(abs).toBe(path.join(root, 'questions', 'js-ts', 'debounce', 'solution.ts'));
  });

  it('rejects paths with ".." segments', () => {
    expect(() => resolveWorkspacePath(root, '../x')).toThrow(ScopeError);
  });

  it('rejects traversal that starts inside questions/', () => {
    expect(() => resolveWorkspacePath(root, 'questions/../../etc/passwd')).toThrow(ScopeError);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWorkspacePath(root, '/etc/passwd')).toThrow(ScopeError);
  });

  it('rejects backslashes', () => {
    expect(() => resolveWorkspacePath(root, 'questions\\js-ts\\debounce\\solution.ts')).toThrow(
      ScopeError,
    );
  });

  it('rejects empty paths', () => {
    expect(() => resolveWorkspacePath(root, '')).toThrow(ScopeError);
  });

  it('rejects paths outside questions/ even without ".."', () => {
    expect(() => resolveWorkspacePath(root, 'package.json')).toThrow(ScopeError);
  });

  it('rejects the questions dir itself', () => {
    expect(() => resolveWorkspacePath(root, 'questions')).toThrow(ScopeError);
  });
});

describe('readWorkspaceFile / writeWorkspaceFile', () => {
  it('round-trips content and hash through write and read', () => {
    const rel = 'questions/js-ts/debounce/solution.ts';
    const content = 'export const debounce = () => {};\n';

    const hash = writeWorkspaceFile(root, rel, content);
    expect(hash).toBe(sha1(content));

    const file = readWorkspaceFile(root, rel);
    expect(file).not.toBeNull();
    expect(file!.content).toBe(content);
    expect(file!.hash).toBe(hash);
  });

  it('creates missing parent directories on write', () => {
    const rel = 'questions/js-ts/new-question/solution.ts';
    writeWorkspaceFile(root, rel, 'x');
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe('x');
  });

  it('returns null for a missing file', () => {
    expect(readWorkspaceFile(root, 'questions/js-ts/debounce/nope.ts')).toBeNull();
  });

  it('returns null for a directory path', () => {
    expect(readWorkspaceFile(root, 'questions/js-ts/debounce')).toBeNull();
  });
});
