import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTempWorkspace, runAce } from './e2e-utils.js';

describe('ace setup', () => {
  it('stores API keys in the temp home', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const result = runAce(['setup', '--openai-key', 'sk-test'], {
        cwd: root,
        env: { HOME: home, ACE_MOCK_LLM_MODE: 'feedback' },
      });

      expect(result.status).toBe(0);

      const configPath = path.join(home, '.ace', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, string>;

      expect(config.OPENAI_API_KEY).toBe('sk-test');
    } finally {
      cleanup();
    }
  });

  /**
   * Routing is per-slot (SLOT_ROUTES, editable per step in Settings) and
   * nothing reads `default_provider` — so setup must neither ask for one nor
   * report one, or the status dashboard states a routing fact that is false.
   * The flag stays accepted-and-ignored so existing scripts keep working.
   */
  it('neither writes nor reports a default provider, even when both keys validate', () => {
    const { root, home, cleanup } = createTempWorkspace();

    try {
      const result = runAce(
        [
          'setup',
          '--openai-key',
          'sk-test',
          '--anthropic-key',
          'sk-ant-test',
          '--default-provider',
          'openai',
        ],
        { cwd: root, env: { HOME: home, ACE_MOCK_LLM_MODE: 'feedback' } },
      );

      // No interactive select blocked the run…
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('Default provider');

      const configPath = path.join(home, '.ace', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, string>;
      expect(config.ANTHROPIC_API_KEY).toBe('sk-ant-test');
      expect(config.default_provider).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
