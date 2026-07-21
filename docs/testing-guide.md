# ACE next — testing guide

How to run, navigate, and poke at the new web app (M1 "The Room" + M2 "The
Corpus") on your own. Everything here works from the `feat/ace-next-m1` branch.

## Run it

```bash
npm install          # once
npm run build        # tsup (server/cli) + vite (dist/ui) + postbuild
node dist/index.js ui --workspace <your-practice-dir>
```

`ace ui` prints the URL (with a one-boot auth token) and opens your browser.
`--port <n>` picks a port (default 4242, auto-scans up to +10), `--no-open`
skips the browser. Ctrl+C shuts down cleanly.

Faster loops while developing:

| Loop | Command | Use when |
|---|---|---|
| Full build | `npm run build && node dist/index.js ui …` | testing the real artifact |
| Server only | `npm run ace ui -- --workspace <dir>` (tsx, serves the last-built UI) | server changes |
| UI hot reload | `ACE_UI_TOKEN=dev npm run ace ui -- --no-open --workspace <dir>` then `npm run ui:dev` and open `http://localhost:5173/?t=dev` | UI changes |

## Free testing (no API spend)

Mock mode short-circuits every LLM call:

```bash
ACE_E2E_MOCK_LLM=1 ACE_MOCK_LLM_MODE=feedback node dist/index.js ui --workspace <dir>
```

- `ACE_MOCK_LLM_MODE=feedback` → reviews return `Overall 4/5 …`
- `ACE_MOCK_LLM_MODE=dispute` → disputes return a `test_incorrect` verdict with a fixed test file

One mode per server process, so restart with the other mode to test the other
flow. Settings shows a "mock mode" banner when active. Without mock mode the
app uses your real keys from `~/.ace/config.json` — the Request-review button
is a real, paid call.

## A throwaway workspace in 30 seconds

Any directory with `questions/<category>/<slug>/` folders and vitest installed
works. Recipe:

```bash
mkdir -p /tmp/ace-play && cd /tmp/ace-play
cat > package.json <<'EOF'
{ "name": "ace-play", "private": true, "type": "module",
  "devDependencies": { "typescript": "^5.9.3", "vitest": "^4.1.10" } }
EOF
cat > vitest.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['questions/**/*.test.ts'] } });
EOF
npm install
mkdir -p questions/js-ts/two-sum
# drop a README.md, solution.ts, solution.test.ts in there (or copy a real one)
```

Tip: put a legacy `scorecard.json` (from any 0.2.x workspace) inside a question
folder to exercise the **import banner** — preview, run, and confirm the old
feedback shows up as review v1 in History. The importer never modifies the
scorecard file; re-running it is a no-op.

Legacy CLI commands still exist for scaffolding content until M3 ships the
generate UI: `npm run ace generate -- --topic "debounce" --category js-ts
--difficulty medium` from the workspace dir.

## What to test, screen by screen

**Library (`/`)** — statuses derive from real runs: `green` only when the
latest finished run passed everything; `in-progress` once any attempt exists.
Resume card appears when an attempt is live; clicking a row opens the room.
Import banner appears when un-imported legacy scorecards exist.

**The Room (`/q/<category>/<slug>`)**
- Problem pane renders the README (tables, code fences, collapsible hints).
- Monaco autosaves 600ms after you stop typing (`● saved Ns ago` in the strip);
  ⌘S forces a flush. Edit the same file in VS Code: a clean buffer silently
  reloads, a dirty buffer shows the conflict banner (Reload / Keep mine).
- Tests: auto-run on save (toggle persists), ⌘⏎ or Run for a manual run — a
  manual run flushes pending saves first, so it always tests what you see.
  Failing rows expand with the assertion diff; Output tab streams raw
  stdout/stderr live. Rapid saves supersede in-flight runs (old run shows
  `cancelled`).
- Timer counts only while the tab is visible and you're active (90s idle
  pause); survives refresh.
- **AI panel** (right): Request review streams in live, then pins a card with
  verdict/score badge and dimension bars; every review is a new version.
  Requesting a review on an untouched stub is blocked with a 400 — the money
  guard. No keys configured → inline notice linking to Settings.
- **Dispute** (kebab on a failing test row): optional argument → verdict +
  details → side-by-side diff when a fix is proposed → Apply rewrites the test
  file (editor updates immediately) and reruns; re-applying is refused.
- **↺ New attempt** (topbar): keep code or reset to the original scaffold
  (signature preserved). Old attempt is archived, nothing is deleted.

**History (`/history`)** — search is full-text over review bodies (FTS5);
filters (category, type, question) are URL params, so links are shareable
between tabs. Review detail has a version picker with side-by-side compare and
the code exactly as it was reviewed ("snapshot").

**Settings (`/settings`)** — keys are write-only and masked; Save validates
against the provider *before* persisting (a bad key changes nothing). Default
provider select. Keys never appear in any API response.

## Where the data lives

```
<workspace>/questions/<cat>/<slug>/   # your files — the only place content lives
<workspace>/.ace/ace.db               # SQLite (WAL): attempts, runs, reviews, disputes, snapshots
<workspace>/.ace/blobs/<sha1>         # content-addressed code snapshots
<workspace>/.ace/tmp/                 # runner scratch (wiped at boot)
~/.ace/config.json                    # API keys + default provider (global)
```

Inspect the db anytime:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.ace/ace.db');
console.table(db.prepare('SELECT slug,status,passed,failed FROM test_runs JOIN questions ON questions.id=test_runs.question_id ORDER BY test_runs.at DESC LIMIT 10').all())"
```

Deleting `.ace/` resets all state (attempts/reviews/history) without touching
your code. The db is gitignored.

## Checks & suite

```bash
npm test                              # 145 unit tests (cli/server/** + lib)
npx tsc --noEmit                      # server/cli typecheck (6 pre-existing errors in legacy commands)
npx tsc --noEmit -p ui/tsconfig.json  # SPA typecheck
```

## Troubleshooting

- **401 / "token missing" screen** — the token lives in sessionStorage per
  tab; a new tab needs the `?t=` URL from the terminal. Restarting the server
  mints a new token.
- **"vitest not installed in workspace"** — run `npm install` in the practice
  workspace (the runner uses the workspace's vitest, not the repo's).
- **Port busy** — another `ace ui` is running; it auto-scans 4242–4252, or pass
  `--port`.
- **Node < 22.12** — `node:sqlite` is missing; upgrade (repo engines say so).
- **Wrong workspace opened** — root resolution walks up from cwd to the
  nearest `questions/`; pass `--workspace` explicitly when in doubt (the
  terminal prints which root it chose).

## Known gaps (by design, coming in M3–M5)

- No generate/brainstorm UI yet (use the legacy CLI); no interviewer chat or
  hint ladder; design rooms have no outline rail or mermaid preview yet — see
  `docs/m3-spec.md`.
- No Coach home / Mistake Ledger (`docs/m4-spec.md`); no sessions, Tape
  scrubber, or dashboard (`docs/m5-spec.md`).
- The auth token appears in the launch URL (visible in local process args) —
  accepted for a single-user machine.
