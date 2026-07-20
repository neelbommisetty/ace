import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: path.resolve(here, '../dist/ui'),
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
