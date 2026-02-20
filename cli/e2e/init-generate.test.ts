import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTempWorkspace, runAce } from './e2e-utils.js';

describe('ace init + generate', () => {
  it('initializes a workspace and scaffolds a question', () => {
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

      const generateResult = runAce(
        ['generate', '--category', 'js-ts', '--difficulty', 'easy', '--topic', 'two sum'],
        {
          cwd: root,
          env: { HOME: home, ACE_MOCK_LLM_MODE: 'generate' },
        },
      );

      expect(generateResult.status).toBe(0);

      const questionDir = path.join(root, 'questions', 'js-ts', 'two-sum');
      const questionFiles = ['README.md', 'scorecard.json', 'solution.ts', 'solution.test.ts'];

      for (const file of questionFiles) {
        expect(fs.existsSync(path.join(questionDir, file))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });
});
