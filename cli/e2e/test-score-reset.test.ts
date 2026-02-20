import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTempWorkspace, linkNodeModules, runAce } from './e2e-utils.js';

describe('ace test + score + reset', () => {
  it('updates scorecard and resets a question', () => {
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
        "import { describe, it, expect } from 'vitest';\n\ndescribe('two sum', () => {\n  it('passes', () => {\n    expect(1).toBe(1);\n  });\n});\n",
        'utf-8',
      );

      runAce(['test', 'two-sum'], { cwd: root, env: { HOME: home } });

      const scorecardPath = path.join(questionDir, 'scorecard.json');
      const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8')) as {
        attempts: Array<{ testsTotal: number; testsPassed: number }>;
      };

      expect(scorecard.attempts.length).toBeGreaterThan(0);
      expect(scorecard.attempts[scorecard.attempts.length - 1].testsTotal).toBeGreaterThan(0);

      const scoreResult = runAce(['score', 'two-sum'], { cwd: root, env: { HOME: home } });
      expect(scoreResult.stdout).toContain('Scorecard:');

      runAce(['reset', 'two-sum'], { cwd: root, env: { HOME: home }, stdin: 'y\n' });

      const solutionPath = path.join(questionDir, 'solution.ts');
      const solutionContent = fs.readFileSync(solutionPath, 'utf-8');
      expect(solutionContent).toContain('TODO: implement');

      const resetScorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8')) as {
        status: string;
      };
      expect(resetScorecard.status).toBe('untouched');
    } finally {
      cleanup();
    }
  });
});
