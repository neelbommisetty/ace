import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
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
});
