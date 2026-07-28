import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Keep in sync with ui/vite.config.ts + ui/tsconfig.json (NEE-284): ui
    // tests run through this root config, which doesn't load the ui vite
    // config, so the alias must exist here too.
    alias: { '@shared': path.resolve(import.meta.dirname, 'shared') },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['cli/**/*.test.{ts,tsx}', 'ui/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
    setupFiles: ['vitest.setup.ts'],
  },
});
