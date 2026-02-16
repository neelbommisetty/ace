import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['questions/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
    setupFiles: ['vitest.setup.ts'],
  },
});
