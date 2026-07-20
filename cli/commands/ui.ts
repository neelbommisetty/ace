import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { getQuestionsDir, resolveWorkspaceRoot } from '../lib/paths.js';
import { startAceServer, type AceServer } from '../server/index.js';

const DEFAULT_PORT = 4242;
const PORT_SCAN_RANGE = 10;

interface UiFlags {
  port: number;
  workspace: string | null;
  open: boolean;
}

function parseArgs(args: string[]): UiFlags {
  const flags: UiFlags = { port: DEFAULT_PORT, workspace: null, open: true };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      const value = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(value) || value < 1 || value > 65535) {
        throw new Error('--port requires a number between 1 and 65535');
      }
      flags.port = value;
    } else if (arg === '--workspace') {
      const value = args[++i];
      if (!value) throw new Error('--workspace requires a directory');
      flags.workspace = value;
    } else if (arg === '--no-open') {
      flags.open = false;
    }
  }

  return flags;
}

function findUiDir(): string | null {
  const candidates = [
    path.join(import.meta.dirname, '../ui'),
    path.join(import.meta.dirname, '../../dist/ui'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
  );
}

function openBrowser(url: string): void {
  let command: string;
  let commandArgs: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    commandArgs = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    commandArgs = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    commandArgs = [url];
  }

  try {
    const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // no opener available — the printed URL is enough
    });
    child.unref();
  } catch {
    // same: URL is printed, opening is best-effort
  }
}

export async function run(args: string[]): Promise<void> {
  const flags = parseArgs(args);
  const root = flags.workspace ? path.resolve(flags.workspace) : resolveWorkspaceRoot();
  const questionsDir = getQuestionsDir(root);

  if (!fs.existsSync(questionsDir) || !fs.statSync(questionsDir).isDirectory()) {
    console.error(chalk.red(`\nError: no questions/ directory found at ${root}`));
    console.error(chalk.dim('Run `ace init` there first, or point at one with --workspace <dir>.\n'));
    process.exitCode = 1;
    return;
  }

  const token = process.env.ACE_UI_TOKEN || randomUUID();
  const uiDir = findUiDir();
  if (!uiDir) {
    console.warn(chalk.yellow('ACE UI is not built — serving the API only. Run: npm run build'));
  }

  let server: AceServer | null = null;
  for (let port = flags.port; port <= flags.port + PORT_SCAN_RANGE; port++) {
    try {
      server = await startAceServer({ workspaceRoot: root, port, token, uiDir });
      break;
    } catch (err) {
      if (isAddrInUse(err)) continue;
      throw err;
    }
  }
  if (!server) {
    console.error(
      chalk.red(`Error: no free port between ${flags.port} and ${flags.port + PORT_SCAN_RANGE}`),
    );
    process.exitCode = 1;
    return;
  }

  const url = `${server.url}/?t=${token}`;
  console.log(`\n${chalk.bold.cyan('ace ui')} — The Room\n`);
  console.log(`  ${chalk.dim('Workspace:')} ${root}`);
  console.log(`  ${chalk.dim('URL:')}       ${chalk.green(url)}\n`);
  console.log(chalk.dim('  Press Ctrl+C to stop.\n'));

  if (flags.open) openBrowser(url);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.dim('\nShutting down...'));
    try {
      await server.close();
    } catch {
      // best-effort shutdown
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
