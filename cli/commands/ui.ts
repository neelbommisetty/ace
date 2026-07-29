import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { isWorkspaceInitialized, resolveWorkspaceRoot } from '../lib/paths.js';
import { loadOrCreateUiToken, rotateUiToken, uiTokenPath } from '../lib/ui-token.js';
import { startAceServer, type AceServer } from '../server/index.js';
import { recordRecentWorkspace } from '../server/workspace-registry.js';

const DEFAULT_PORT = 4242;
const PORT_SCAN_RANGE = 10;

export interface UiFlags {
  port: number;
  workspace: string | null;
  open: boolean;
  rotateToken: boolean;
}

/** Exported for unit tests (NEE-308) — parseArgs itself has no I/O. */
export function parseArgs(args: string[]): UiFlags {
  const flags: UiFlags = { port: DEFAULT_PORT, workspace: null, open: true, rotateToken: false };

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
    } else if (arg === '--rotate-token') {
      flags.rotateToken = true;
    }
  }

  return flags;
}

/**
 * ACE_UI_TOKEN always wins (e.g. CI/scripted launches); otherwise the token
 * persists across restarts at ~/.ace/ui-token (NEE-308) so a plain restart
 * never invalidates tabs already open on the previously printed URL.
 * --rotate-token deliberately mints + persists a fresh one instead. Exported
 * for unit tests — the only I/O is the already independently-tested
 * ui-token.ts pair.
 */
export function resolveToken(rotateToken: boolean): string {
  return process.env.ACE_UI_TOKEN || (rotateToken ? rotateUiToken() : loadOrCreateUiToken());
}

function findUiDir(): string | null {
  const candidates = [
    // Built layout: dist/cli/commands/ui.js -> dist/cli/ui (the vite outDir).
    path.join(import.meta.dirname, '../ui'),
    // Dev (tsx cli/index.ts): cli/commands/ui.ts -> <repo>/dist/cli/ui.
    path.join(import.meta.dirname, '../../dist/cli/ui'),
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

  let root: string | null;
  if (flags.workspace) {
    // An explicit --workspace pointing at a non-workspace is a typo, not a
    // request for the picker — fail loudly instead of silently ignoring
    // what the user asked for.
    root = path.resolve(flags.workspace);
    if (!isWorkspaceInitialized(root)) {
      console.error(chalk.red(`\nError: no questions/ directory found at ${root}`));
      console.error(chalk.dim('Run `ace init` there first, or point --workspace at an initialized one.\n'));
      process.exitCode = 1;
      return;
    }
  } else {
    // Auto-detect miss is NOT an error (NEE-164): boot unmounted and let the
    // browser picker mount a workspace from recents or a typed path.
    const detected = resolveWorkspaceRoot();
    root = isWorkspaceInitialized(detected) ? detected : null;
  }

  const token = resolveToken(flags.rotateToken);
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

  // Boot with a root counts as a successful mount for the picker's recents,
  // exactly like every later switch.
  if (root != null) recordRecentWorkspace(root);

  const url = `${server.url}/?t=${token}`;
  console.log(`\n${chalk.bold.cyan('ace ui')} — The Room\n`);
  if (root != null) {
    console.log(`  ${chalk.dim('Workspace:')} ${root}`);
  } else {
    console.log(`  ${chalk.dim('Workspace:')} ${chalk.yellow('none mounted')} — no questions/ found here; pick one in the browser`);
  }
  console.log(`  ${chalk.dim('URL:')}       ${chalk.green(url)}\n`);
  if (!process.env.ACE_UI_TOKEN) {
    console.log(
      chalk.dim(
        `  Token:      persisted at ${uiTokenPath()} — reused across restarts; pass --rotate-token to invalidate open sessions.\n`,
      ),
    );
  }
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
