import { defineConfig } from 'tsup';

export default defineConfig({
  // shared/ joins the entry globs (NEE-284); note this makes esbuild's
  // outbase the repo root, so output nests as dist/cli/** + dist/shared/**
  // (bin + postbuild + the vite outDir point at dist/cli accordingly).
  entry: ['cli/**/*.ts', 'shared/**/*.ts', '!cli/**/*.test.ts', '!cli/e2e/**'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  bundle: false,
  splitting: false,
  sourcemap: false,
  dts: false,
});
