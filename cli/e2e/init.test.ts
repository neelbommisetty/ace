import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { STARTER_PACK } from '../lib/starter-pack.js';
import { createTempWorkspace, runAce } from './e2e-utils.js';

// Question generation is no longer a CLI command — it lives in the app's
// generation engine (cli/server/generation.ts, covered by generation.test.ts
// and app-generation.test.ts). This file is scoped to what `ace init` itself
// puts on disk.
describe('ace init', () => {
  it('initializes a workspace with the questions tree and test config', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const initResult = runAce(['init', '--skip-install'], {
        cwd: root,
        env: { HOME: home },
      });

      expect(initResult.status).toBe(0);

      const expectedPaths = [
        'questions',
        'package.json',
        'tsconfig.json',
        'vitest.config.ts',
        'vitest.setup.ts',
      ];

      for (const relPath of expectedPaths) {
        expect(fs.existsSync(path.join(root, relPath))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  // NEE-301: a fresh workspace must be practisable immediately — no API key,
  // no generation. The starter pack is what makes that true.
  it('copies the starter questions in by default', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const initResult = runAce(['init', '--skip-install'], {
        cwd: root,
        env: { HOME: home },
      });

      expect(initResult.status).toBe(0);

      for (const question of STARTER_PACK) {
        const dir = path.join(root, 'questions', question.category, question.slug);
        expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
      }
      // And the next steps point at the app, not at a paid generation.
      expect(initResult.stdout).toContain('ace ui');
      expect(initResult.stdout).not.toContain('ace generate');
    } finally {
      cleanup();
    }
  });

  it('--no-samples reproduces the empty questions/ tree', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const initResult = runAce(['init', '--skip-install', '--no-samples'], {
        cwd: root,
        env: { HOME: home },
      });

      expect(initResult.status).toBe(0);
      expect(fs.existsSync(path.join(root, 'questions'))).toBe(true);
      expect(fs.readdirSync(path.join(root, 'questions'))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
