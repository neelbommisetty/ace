import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['cli/**/*.ts', '!cli/**/*.test.ts', '!cli/e2e/**'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  bundle: false,
  splitting: false,
  sourcemap: false,
  dts: false,
});
