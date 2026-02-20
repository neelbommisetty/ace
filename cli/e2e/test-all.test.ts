import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTempWorkspace, linkNodeModules, runAce } from './e2e-utils.js';

describe('ace test --all', () => {
  it('runs all tests in the workspace', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const initResult = runAce(['init', '--skip-install'], { cwd: root, env: { HOME: home } });
      expect(initResult.status).toBe(0);

      const generateResult = runAce(['generate', '--category', 'js-ts', '--difficulty', 'easy', '--topic', 'two sum'], {
        cwd: root,
        env: { HOME: home, ACE_MOCK_LLM_MODE: 'generate' },
      });
      expect(generateResult.status).toBe(0);

      linkNodeModules(root);

      const questionDir = path.join(root, 'questions', 'js-ts', 'two-sum');
      const testFilePath = path.join(questionDir, 'solution.test.ts');

      fs.writeFileSync(
        testFilePath,
        "import { describe, it, expect } from 'vitest';\n\ndescribe('two sum', () => {\n  it('passes', () => {\n    expect(true).toBe(true);\n  });\n});\n",
        'utf-8',
      );

      const result = runAce(['test', '--all'], { cwd: root, env: { HOME: home } });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Running all tests');
    } finally {
      cleanup();
    }
  });
});
