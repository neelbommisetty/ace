import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'cli', 'index.ts');
const tsxImportPath = pathToFileURL(
  path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
).href;

export interface RunAceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export function createTempWorkspace(): { root: string; home: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-workspace-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-home-'));

  const cleanup = () => {
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    if (fs.existsSync(home)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  return { root, home, cleanup };
}

export function linkNodeModules(root: string): void {
  const target = path.join(root, 'node_modules');
  const source = path.join(repoRoot, 'node_modules');

  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(source, target, linkType);
}

export function runAce(
  args: string[],
  options: RunAceOptions = {},
): { status: number | null; stdout: string; stderr: string } {
  const cwd = options.cwd ?? process.cwd();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ACE_E2E_MOCK_LLM: '1',
    OPENAI_API_KEY: 'sk-test',
  };

  if (options.env?.HOME) {
    baseEnv.HOME = options.env.HOME;
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...options.env,
  };

  const result = spawnSync(
    process.execPath,
    ['--import', tsxImportPath, cliPath, ...args],
    {
      cwd,
      env,
      encoding: 'utf-8',
      input: options.stdin,
    },
  );

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}
