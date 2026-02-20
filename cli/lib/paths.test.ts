import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGlobalAceDir,
  getHomeDir,
  getQuestionsDir,
  isWorkspaceInitialized,
  resolveWorkspaceRoot,
} from './paths.js';

let tempRoot = '';
const originalEnv = { ...process.env };

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

beforeEach(() => {
  tempRoot = makeTempDir('ace-workspace-');
});

afterEach(() => {
  process.env = { ...originalEnv };
  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('resolveWorkspaceRoot', () => {
  it('returns the nearest ancestor that contains questions/', () => {
    const workspace = path.join(tempRoot, 'project');
    const nested = path.join(workspace, 'src', 'features');
    fs.mkdirSync(path.join(workspace, 'questions'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    const resolved = resolveWorkspaceRoot(nested);

    expect(resolved).toBe(workspace);
  });

  it('returns the starting directory when no questions/ exists', () => {
    const start = path.join(tempRoot, 'empty');
    fs.mkdirSync(start, { recursive: true });

    const resolved = resolveWorkspaceRoot(start);

    expect(resolved).toBe(path.resolve(start));
  });
});

describe('questions paths', () => {
  it('builds questions dir path and detects initialization', () => {
    const workspace = path.join(tempRoot, 'project');
    fs.mkdirSync(workspace, { recursive: true });

    const questionsDir = getQuestionsDir(workspace);
    expect(questionsDir).toBe(path.join(workspace, 'questions'));
    expect(isWorkspaceInitialized(workspace)).toBe(false);

    fs.mkdirSync(questionsDir, { recursive: true });
    expect(isWorkspaceInitialized(workspace)).toBe(true);
  });
});

describe('home and global ace paths', () => {
  it('uses HOME when available', () => {
    const home = makeTempDir('ace-home-');
    process.env.HOME = home;
    delete process.env.USERPROFILE;

    expect(getHomeDir()).toBe(home);
    expect(getGlobalAceDir()).toBe(path.join(home, '.ace'));
  });
});
