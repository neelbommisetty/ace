import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import { getQuestionsDir } from '../lib/paths.js';
import { isRecentWrite, sha1, toWorkspaceRelPath } from './files.js';
import type { Bus } from './sse.js';

const RECONCILE_DEBOUNCE_MS = 500;

export interface WatcherOptions {
  workspaceRoot: string;
  bus: Bus;
  /** Called (debounced) when question dirs appear/disappear; caller reconciles. */
  onQuestionsChanged: () => void;
}

export function startWatcher(opts: WatcherOptions): { close(): Promise<void> } {
  const { workspaceRoot, bus, onQuestionsChanged } = opts;
  const questionsDir = getQuestionsDir(workspaceRoot);
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const watcher = watch(questionsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (p: string) => p.includes('node_modules') || path.basename(p).startsWith('.'),
  });

  const onFileEvent = (absPath: string) => {
    if (closed) return;
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return; // vanished or unreadable — nothing to report
    }
    const hash = sha1(content);
    const relPath = toWorkspaceRelPath(workspaceRoot, absPath);
    if (isRecentWrite(relPath, hash)) return; // echo of our own PUT /api/file
    bus.emit('file-changed', { relPath, hash });
  };

  const onDirEvent = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      try {
        onQuestionsChanged();
      } catch {
        // reconcile failures must not kill the watcher
      }
      bus.emit('questions-changed', {});
    }, RECONCILE_DEBOUNCE_MS);
  };

  watcher.on('add', onFileEvent);
  watcher.on('change', onFileEvent);
  watcher.on('addDir', onDirEvent);
  watcher.on('unlinkDir', onDirEvent);
  watcher.on('error', () => {
    // transient fs errors (e.g. EPERM during dir removal) — keep watching
  });

  return {
    async close() {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
    },
  };
}
