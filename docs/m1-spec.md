# ACE next — M1 "The Room" build spec

M1 delivers `ace ui`: a local web app (Hono server + prebuilt React SPA) that replaces
the CLI's daily practice loop. Zero AI features in M1. Shared types live in
`cli/server/types.ts` — **import from there, never redefine shapes.**

## File ownership (parallel build — do not touch files outside your area)

- **server-core**: `cli/server/db.ts`, `cli/server/ids.ts`, `cli/server/migrations.ts`,
  `cli/server/reconciler.ts`, `cli/server/importer.ts`, plus their `*.test.ts`.
- **server-app**: `cli/server/app.ts`, `cli/server/sse.ts`, `cli/server/watcher.ts`,
  `cli/server/runner.ts`, `cli/server/files.ts`, `cli/server/index.ts`,
  `cli/commands/ui.ts`, plus `*.test.ts`; may edit `cli/index.ts` (add `ui` command + help line).
- **spa**: everything under `ui/src/`; may edit `ui/index.html`.

Existing CLI commands and `cli/lib/**` stay untouched (reuse via import:
`CATEGORIES`, `isDesignCategory` from `../lib/categories.js`; note ESM `.js` suffixes).

## Runtime layout

- Workspace root: directory containing `questions/`. DB at `<root>/.ace/ace.db`
  (WAL). Temp at `<root>/.ace/tmp/`. `.ace/` is created on boot.
- Question dir: `questions/<category>/<slug>/` with `README.md`, solution/test files
  per `CATEGORIES[category].solutionFiles/testFiles`, or `notes.md` for design categories.
  Files stay the source of truth for content; the DB stores events/records only.

## Server (`cli/server/index.ts`)

`export async function startAceServer(opts: { workspaceRoot: string; port: number; token: string; uiDir: string | null }): Promise<{ url: string; port: number; close(): Promise<void> }>`

- Bind `127.0.0.1` only via `@hono/node-server` `serve()`.
- Boot order: open db → run migrations → reconcile → start watcher → listen.
- On listen failure (EADDRINUSE) caller retries next port; `ace ui` scans 4242–4252.

### Auth middleware (all `/api/*`)

- Accept `Authorization: Bearer <token>` or `?t=<token>` (needed for EventSource).
- Reject other requests 401 JSON `{error}`. Constant-time compare.
- Host header must be `127.0.0.1[:port]` or `localhost[:port]` else 403 (DNS-rebinding guard).
- Static UI (non-`/api`) is served without token: GET only, from `uiDir`, with SPA
  fallback to `index.html` for paths without file extensions. If `uiDir` is null,
  `/` returns a plain-text "UI not built" hint (API still works for `ui:dev`).

### REST API (JSON, camelCase; errors `{ error: string }` with 4xx/5xx)

| Method & path | Req | Res |
|---|---|---|
| GET `/api/health` | | `{ ok: true, version }` |
| GET `/api/workspace` | | `WorkspaceInfo` |
| GET `/api/questions` | | `QuestionWithStats[]` |
| GET `/api/questions/:category/:slug` | | `QuestionDetail` (404 if unknown) |
| POST `/api/questions/:category/:slug/attempts` | | `{ attempt }` — returns the active attempt if one exists, else creates one (+`reveal` event) |
| GET `/api/attempts/:id` | | `{ attempt, events }` |
| PATCH `/api/attempts/:id` | `{ activeSecondsDelta?, end? }` | `{ attempt }` |
| POST `/api/attempts/:id/events` | `{ type, payload? }` | `{ event }` — `first_edit` deduped server-side (once per attempt) |
| GET `/api/resume` | | `{ attempt, question } \| { attempt: null }` |
| GET `/api/file?path=<rel>` | | `{ path, content, hash }` (404 if absent) |
| PUT `/api/file` | `{ path, content }` | `{ hash }` — registers write for watcher echo-suppression |
| POST `/api/attempts/:id/test-runs` | `{ trigger }` | `{ runId }` (results stream over SSE; also persisted) |
| GET `/api/test-runs?questionId=&limit=` | | `TestRunRow[]` |
| GET `/api/import/preview` | | `{ items: ImportPreviewItem[] }` |
| POST `/api/import/run` | | `ImportResult` |
| GET `/api/events` | | SSE stream (see `SseEventMap`), heartbeat comment every 25s |

`QuestionStats.status`: latest test run all-passed → `green`; any attempt exists →
`in-progress`; else `not-started`.

### File scope (`files.ts`)

`resolveWorkspacePath(root, rel)`: reject absolute paths, `..` segments, and any
resolved path not strictly inside `<root>/questions/`. Hash = sha1 hex of content.
Export `readWorkspaceFile` / `writeWorkspaceFile(root, rel, content)`; the writer
records `{relPath → hash}` in a shared recent-writes map (used by the watcher) and
returns the hash.

### Watcher (`watcher.ts`)

chokidar on the questions dir (`ignoreInitial`, `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }`,
ignore `**/node_modules/**` and dotfiles). On file add/change: hash the file; if the
hash equals the recent server write for that relPath (entries expire after 5s) →
suppress; else emit SSE `file-changed`. On addDir/unlinkDir at question depth:
debounce 500ms → re-run reconciler → emit `questions-changed`.

### Test runner (`runner.ts`)

`runTests({ db, bus, workspaceRoot, question, attemptId, trigger })`:

1. If a run for the same `questionId` is in flight: kill its process, mark it
   `cancelled`, then proceed (supersede semantics).
2. Create `test_runs` row (status `running`), add `test_run` attempt event, emit `run-started`.
3. Spawn the **workspace's** vitest: `<root>/node_modules/.bin/vitest` (if missing →
   finish run as `error` with message "vitest not installed in workspace — run npm install").
   Args: `run <relQuestionDir> --reporter=json --outputFile=.ace/tmp/<runId>.json --root <root>`.
   `cwd: root`, env passthrough + `CI=1`, kill after 180s → `error`.
4. Stream child stdout/stderr chunks over SSE `run-output` (cap stored copy at 200KB each).
5. On exit, parse the JSON output file (jest-style: `numTotalTests`,
   `testResults[].assertionResults[]` with `title`, `ancestorTitles`, `status`
   (`passed|failed|pending|skipped|todo`), `duration`, `failureMessages`). Strip ANSI
   from failure messages. Missing/unparseable file **with nonzero exit** → status
   `error` with stderr tail as message; parseable → status `done` with summary +
   per-case results regardless of exit code (failing tests exit nonzero — that's `done`).
6. Persist via `finishTestRun`, emit `run-done`. If all passed and total > 0: add
   `all_green` attempt event (once per attempt).

### SSE (`sse.ts`)

Tiny typed bus: `bus.emit(name, payload)` fans out to connected `streamSSE` clients
(from `hono/streaming`). Send `hello` on connect. Drop dead clients on write error.

## `ace ui` (`cli/commands/ui.ts`)

Flags: `--port <n>` (default 4242, scan up to +10), `--workspace <dir>` (else
`resolveWorkspaceRoot()` from `../lib/paths.js`), `--no-open`.
Errors if `<root>/questions/` is missing (point at `ace init` / `--workspace`).
Token: `crypto.randomUUID()`, overridable via `ACE_UI_TOKEN` (dev). uiDir candidates
relative to `import.meta.dirname`: `../ui` (built package: dist/commands → dist/ui is
`../ui`), `../../dist/ui` (tsx dev); first that exists with `index.html`, else null +
warning. Print root + URL `http://127.0.0.1:<port>/?t=<token>`; open browser
(darwin `open`, win32 `cmd /c start ""`, else `xdg-open`) unless `--no-open`.
SIGINT/SIGTERM → close server, exit 0.

## SPA (`ui/src/`)

Stack: React 19 + react-router-dom, `@monaco-editor/react` with **bundled** monaco
(`loader.config({ monaco })` + `?worker` imports — never the CDN; ts/tsx →
`ts.worker`, default `editor.worker`; set TS diagnostics
`noSemanticValidation: true`). Markdown via react-markdown + remark-gfm.

Token bootstrap: read `?t=` on load → sessionStorage (`ace-token`) → strip from URL
via `history.replaceState`. `api.ts` wraps fetch with the bearer header; SSE via
`new EventSource('/api/events?t=' + token)` with auto-reconnect handling.

Routes:
- `/` **Library**: fetch workspace + questions. Import banner when
  `legacyImport.available` (preview modal → run → refetch). Resume card pinned on top
  when `activeAttempt` exists. Table rows: title, category chip, difficulty, status
  chip (`not-started` gray / `in-progress` amber / `green` green), attempts, last
  run `p/t`, last activity relative time. Row click → room. Filters: category pills +
  status select (client-side). Empty state per design.
- `/q/:category/:slug` **Room**: three panes (left problem 30% / center editor /
  bottom console ~30% of center column, both collapsible).
  - Boot: GET detail → POST attempts (create-or-resume) → subscribe SSE.
  - Left tabs: **Problem** (rendered README) · **Activity** (attempt events + past runs).
  - Center: Monaco tabs for solution files (editable) + test files (readonly badge).
    Autosave 600ms debounce → PUT `/api/file`; keep last-saved hash per file. On SSE
    `file-changed` for an open file with a different hash: if the buffer is dirty →
    conflict banner "File changed on disk — Reload / Keep mine"; if clean → silently
    reload content. First keystroke → POST `first_edit` event once.
  - Console: Run button (⌘/Ctrl+Enter) → POST test-runs; rows render from `run-done`
    (structured per-case, failures expanded with error text); **Output** tab streams
    raw chunks live during the run; auto-run-on-save toggle (default ON, persisted
    localStorage) triggers runs with `trigger: 'save'`. Show run history count + last
    run age. While running: spinner row + live output.
  - Topbar: title, category/difficulty chips, active timer (mm:ss, counts only while
    tab visible & recent input, idle-pauses after 90s), Run button. Timer PATCHes
    `activeSecondsDelta` every 15s and on unmount/pagehide.
- 404 → link back to Library.

Design tokens (dark-only app identity, from the approved mockups):
bg `#0f141b`, surface `#161c24`, panel `#1b222c`, panel-2 `#212a35`, line `#2a3340`,
ink `#dce4ed`, dim `#8b97a6`, faint `#5c6875`, accent `#ffb224` (accent text on dark
bg only; on accent bg use ink `#201500`), good `#0ca30c` (text-on-dark `#4cc24c`),
crit `#d03b3b` (text `#e58c8c`), category-chip blue `#7db4f0`.
Fonts: `system-ui` body; `ui-monospace, "SF Mono", Menlo` for code/data/timers with
`font-variant-numeric: tabular-nums`. Plain CSS (one `styles.css`), no framework.

## Build

`npm run build` = `tsup` (cli+server → dist, non-bundled ESM) → `vite build` (ui →
`dist/ui`) → `postbuild.js` (assets + shebang). Dev: `npm run ace ui` (tsx, serves
built UI if present) or `ACE_UI_TOKEN=dev npm run ace ui` + `npm run ui:dev` (Vite
dev server proxying `/api` → 4242, open `http://localhost:5173/?t=dev`).

## Testing

Vitest picks up `cli/**/*.test.ts`. server-core: unit tests for db round-trips,
reconciler against a temp questions tree, importer idempotency (temp dirs via
`fs.mkdtempSync(os.tmpdir())`, cleaned in `afterEach`). server-app: unit tests for
path scoping (traversal rejected) and the vitest JSON → `TestCaseResult[]` mapper
(pure function over a fixture JSON). Don't spawn real vitest child processes inside
unit tests.
