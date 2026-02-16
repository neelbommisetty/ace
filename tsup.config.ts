import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['cli/**/*.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  bundle: false,
  splitting: false,
  sourcemap: false,
  dts: false,
});
