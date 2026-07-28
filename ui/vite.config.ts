import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    // Stable SPA import path for the shared wire types / category config
    // (NEE-284). Mirrored in ui/tsconfig.json `paths` and the root
    // vitest.config.ts so tsc and vitest resolve it identically.
    alias: { '@shared': path.resolve(here, '../shared') },
  },
  build: {
    // tsup nests its output under dist/cli now that shared/ is compiled too
    // (NEE-284); the SPA lands next to the compiled CLI so the built
    // `findUiDir` candidate `../ui` keeps resolving.
    outDir: path.resolve(here, '../dist/cli/ui'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000, // monaco is intentionally bundled
  },
  server: {
    port: 5173,
    proxy: {
      // `ACE_UI_TOKEN=dev npm run ace ui -- --no-open` then open :5173/?t=dev
      '/api': { target: 'http://127.0.0.1:4242' },
    },
  },
});
