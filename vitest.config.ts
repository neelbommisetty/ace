import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['cli/**/*.test.{ts,tsx}', 'ui/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
    setupFiles: ['vitest.setup.ts'],
  },
});
