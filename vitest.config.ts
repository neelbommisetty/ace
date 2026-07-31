import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// node_modules may be a SYMLINK into another checkout (git worktrees share
// the main repo's install). The ?raw .d.ts imports in
// ui/src/monaco-react-typings.ts resolve through it to the REAL path, which
// then sits outside this root and would be denied by vite's fs allow-list.
// Resolved defensively: a missing node_modules (config loaded pre-install)
// falls back to the plain path.
const nodeModulesRealPath = (() => {
  const nodeModules = path.resolve(import.meta.dirname, 'node_modules');
  try {
    return fs.realpathSync(nodeModules);
  } catch {
    return nodeModules;
  }
})();

export default defineConfig({
  resolve: {
    // Keep in sync with ui/vite.config.ts + ui/tsconfig.json (NEE-284): ui
    // tests run through this root config, which doesn't load the ui vite
    // config, so the alias must exist here too.
    alias: { '@shared': path.resolve(import.meta.dirname, 'shared') },
  },
  server: {
    fs: {
      // Specifying `allow` replaces vite's workspace-root default, so the
      // project root must be re-listed alongside the real node_modules path.
      // In a non-worktree checkout both entries are inside the root — a no-op.
      allow: [import.meta.dirname, nodeModulesRealPath],
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['cli/**/*.test.{ts,tsx}', 'ui/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
    setupFiles: ['vitest.setup.ts'],
  },
});
