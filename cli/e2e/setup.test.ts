import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTempWorkspace, runAce } from './e2e-utils.js';

describe('ace setup', () => {
  it('stores API keys in the temp home', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const result = runAce(['setup', '--openai-key', 'sk-test', '--default-provider', 'openai'], {
        cwd: root,
        env: { HOME: home, ACE_MOCK_LLM_MODE: 'feedback' },
      });

      expect(result.status).toBe(0);

      const configPath = path.join(home, '.ace', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, string>;

      expect(config.OPENAI_API_KEY).toBe('sk-test');
      expect(config.default_provider).toBe('openai');
    } finally {
      cleanup();
    }
  });
});
