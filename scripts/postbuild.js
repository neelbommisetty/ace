/**
 * Postbuild script — runs after tsup compiles TypeScript.
 *
 * 1. Copies non-TS assets (templates, prompts) into dist/ so runtime
 *    fs.readFileSync calls using import.meta.dirname-relative paths still work.
 * 2. Prepends a Node.js shebang to the CLI entry point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// -------------------------------------------------------------------
// 1. Copy asset directories
// -------------------------------------------------------------------

// tsup output nests as dist/cli/** + dist/shared/** (NEE-284), so assets go
// next to the compiled files whose import.meta.dirname-relative reads expect
// them (`../templates` / `../prompts` from dist/cli/lib and dist/cli/server).
const ASSET_DIRS = [
  { src: 'cli/templates', dest: 'dist/cli/templates' },
  { src: 'cli/prompts', dest: 'dist/cli/prompts' },
];

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

for (const { src, dest } of ASSET_DIRS) {
  const srcAbs = path.join(ROOT, src);
  const destAbs = path.join(ROOT, dest);
  if (fs.existsSync(srcAbs)) {
    copyDirSync(srcAbs, destAbs);
    console.log(`  copied ${src} -> ${dest}`);
  }
}

// -------------------------------------------------------------------
// 2. Prepend shebang to CLI entry point
// -------------------------------------------------------------------

const ENTRY = path.join(ROOT, 'dist/cli/index.js');
if (fs.existsSync(ENTRY)) {
  const content = fs.readFileSync(ENTRY, 'utf-8');
  if (!content.startsWith('#!')) {
    fs.writeFileSync(ENTRY, `#!/usr/bin/env node\n${content}`);
    console.log('  added shebang to dist/cli/index.js');
  }
}

console.log('postbuild done.');
