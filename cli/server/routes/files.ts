import type { Hono } from 'hono';
import { saveBlob } from '../blobs.js';
import {
  readWorkspaceFile,
  resolveWorkspacePath,
  toWorkspaceRelPath,
  writeWorkspaceFile,
} from '../files.js';
import { readJsonBody } from '../route-helpers.js';
import type { RouteContext } from './context.js';

/** Records a 'save' snapshot when the written content is new for that file. */
function snapshotOnWrite(ctx: RouteContext, relPath: string, content: string, hash: string): void {
  // Everything below — including the initial getSession()/getQuestion()
  // lookup — is inside the try/catch: snapshot bookkeeping must never fail
  // the save itself (the file is already safely on disk), and a session
  // torn down mid-request (e.g. a reset racing this write) throws on the
  // very first db call just as easily as on a later one.
  try {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const { db } = ctx.requireSession();
    // relPath shape: questions/<category>/<slug>/<file...>
    const segments = relPath.split('/');
    if (segments.length < 4 || segments[0] !== 'questions') return;
    const question = db.getQuestion(segments[1], segments[2]);
    if (!question) return;
    const latest = db.getLatestSnapshot(question.id, relPath);
    if (latest && latest.hash === hash) return;
    saveBlob(workspaceRoot, content);
    db.addSnapshot({
      questionId: question.id,
      attemptId: db.getActiveAttempt(question.id)?.id ?? null,
      relPath,
      hash,
      trigger: 'save',
    });
  } catch (err) {
    console.error('[ace] snapshot-on-write failed:', err);
  }
}

export function registerFileRoutes(app: Hono, ctx: RouteContext): void {
  app.get('/api/file', (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const rel = c.req.query('path');
    if (!rel) return c.json({ error: 'path query param is required' }, 400);
    const abs = resolveWorkspacePath(workspaceRoot, rel); // throws ScopeError → 400
    const file = readWorkspaceFile(workspaceRoot, rel);
    if (!file) return c.json({ error: 'file not found' }, 404);
    return c.json({ path: toWorkspaceRelPath(workspaceRoot, abs), ...file });
  });

  app.put('/api/file', async (c) => {
    const workspaceRoot = ctx.requireWorkspaceRoot();
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const { path: rel, content } = body;
    if (typeof rel !== 'string' || typeof content !== 'string') {
      return c.json({ error: 'path and content must be strings' }, 400);
    }
    // Save-anchor check (NEE-164): a save queued in a tab anchored to one
    // workspace can arrive after a switch mounted another — most acutely the
    // pagehide keepalive flush fired by the very reload the switch triggers,
    // which lands only AFTER the swap. Landing it under the new root would
    // write one workspace's content into an unrelated workspace's tree, so a
    // stale anchor rejects instead of silently applying. Same-root writes
    // (including after a reset, which keeps the root) are unaffected.
    const expectedRoot = body.expectedRoot;
    if (typeof expectedRoot === 'string' && expectedRoot !== workspaceRoot) {
      return c.json(
        { error: `workspace changed: this save targeted ${expectedRoot}`, code: 'workspace-changed' },
        409,
      );
    }
    const abs = resolveWorkspacePath(workspaceRoot, rel); // throws ScopeError → 400
    // Optimistic concurrency (NEE-359): `savedHash` is the disk hash the
    // client believes it is editing on top of. If disk has moved since —
    // another tab saved, or the server appended follow-up probes / applied a
    // dispute fix — this PUT would silently discard that write, so reject it
    // and let the client surface its conflict banner instead. Omitting
    // `savedHash` keeps the old last-write-wins behavior (the explicit
    // "Keep mine" conflict resolution and non-UI callers), so the
    // precondition is opt-in.
    const savedHash = body.savedHash;
    if (typeof savedHash === 'string') {
      const current = readWorkspaceFile(workspaceRoot, rel);
      // A missing file has no writer to lose — recreate it rather than 409.
      if (current !== null && current.hash !== savedHash) {
        return c.json(
          {
            error: 'file changed on disk since you last loaded it',
            code: 'stale-write',
            hash: current.hash,
          },
          409,
        );
      }
    }
    const hash = writeWorkspaceFile(workspaceRoot, rel, content);
    snapshotOnWrite(ctx, toWorkspaceRelPath(workspaceRoot, abs), content, hash);
    return c.json({ hash });
  });
}
