import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRecentWorkspaces, recordRecentWorkspace, type RecentWorkspace } from './workspace-registry.js';

let tempHome = '';
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function registryFile(): string {
  return path.join(tempHome, '.ace', 'workspaces.json');
}

/** A directory that passes isWorkspaceInitialized (has a questions/ child). */
function makeWorkspace(name: string): string {
  const root = path.join(tempHome, name);
  fs.mkdirSync(path.join(root, 'questions'), { recursive: true });
  return root;
}

function readRawFile(): RecentWorkspace[] {
  return JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as RecentWorkspace[];
}

beforeEach(() => {
  // getGlobalAceDir() resolves through process.env.HOME — point it at a
  // fresh temp dir so tests never touch the real ~/.ace registry.
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-registry-home-'));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('readRecentWorkspaces', () => {
  it('returns [] when the registry file does not exist', () => {
    expect(readRecentWorkspaces()).toEqual([]);
  });

  it('returns [] for a corrupt (non-JSON) file', () => {
    fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
    fs.writeFileSync(registryFile(), 'not json {', 'utf8');
    expect(readRecentWorkspaces()).toEqual([]);
  });

  it('returns [] for valid JSON that is not an array, and drops shape-invalid entries', () => {
    fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify({ nope: true }), 'utf8');
    expect(readRecentWorkspaces()).toEqual([]);

    const good = makeWorkspace('good');
    fs.writeFileSync(
      registryFile(),
      JSON.stringify([
        { root: good, lastOpenedAt: '2026-07-28T00:00:00.000Z' },
        { root: 42, lastOpenedAt: 'x' },
        'just a string',
        null,
      ]),
      'utf8',
    );
    expect(readRecentWorkspaces().map((r) => r.root)).toEqual([good]);
  });

  it('filters out roots that vanished or lost their questions/ dir — at read time, not from the file', () => {
    const alive = makeWorkspace('alive');
    const gone = makeWorkspace('gone');
    const uninitialized = path.join(tempHome, 'uninitialized');
    fs.mkdirSync(uninitialized, { recursive: true }); // exists, but no questions/

    recordRecentWorkspace(uninitialized);
    recordRecentWorkspace(gone);
    recordRecentWorkspace(alive);
    fs.rmSync(gone, { recursive: true, force: true });

    expect(readRecentWorkspaces().map((r) => r.root)).toEqual([alive]);
    // The raw file still remembers all three — a temporarily unavailable
    // workspace is hidden, not forgotten.
    expect(readRawFile().map((r) => r.root)).toEqual([alive, gone, uninitialized]);
  });
});

describe('recordRecentWorkspace', () => {
  it('creates ~/.ace and the registry file on first record', () => {
    const ws = makeWorkspace('first');
    recordRecentWorkspace(ws);
    const entries = readRecentWorkspaces();
    expect(entries).toHaveLength(1);
    expect(entries[0].root).toBe(ws);
    expect(Number.isNaN(Date.parse(entries[0].lastOpenedAt))).toBe(false);
  });

  it('upserts a re-recorded root to the front with a fresh timestamp instead of duplicating it', () => {
    const a = makeWorkspace('a');
    const b = makeWorkspace('b');
    recordRecentWorkspace(a);
    recordRecentWorkspace(b);
    const firstStamp = readRawFile().find((r) => r.root === a)!.lastOpenedAt;

    recordRecentWorkspace(a);
    const entries = readRawFile();
    expect(entries.map((r) => r.root)).toEqual([a, b]);
    expect(entries[0].lastOpenedAt >= firstStamp).toBe(true);
  });

  it('caps the file at 20 entries, dropping the oldest', () => {
    const roots = Array.from({ length: 22 }, (_, i) => makeWorkspace(`ws-${String(i).padStart(2, '0')}`));
    for (const root of roots) recordRecentWorkspace(root);
    const entries = readRawFile();
    expect(entries).toHaveLength(20);
    expect(entries[0].root).toBe(roots[21]);
    // The two oldest fell off the end.
    expect(entries.map((r) => r.root)).not.toContain(roots[0]);
    expect(entries.map((r) => r.root)).not.toContain(roots[1]);
  });

  it('recovers from a corrupt file by rewriting it with just the new entry', () => {
    fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
    fs.writeFileSync(registryFile(), '[[[', 'utf8');
    const ws = makeWorkspace('phoenix');
    recordRecentWorkspace(ws);
    expect(readRecentWorkspaces().map((r) => r.root)).toEqual([ws]);
  });
});
