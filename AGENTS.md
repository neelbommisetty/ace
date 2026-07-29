# Agent Guide (ace)

This repo is a local-first web app for frontend interview practice, launched by a small bootstrap CLI (`ace ui`). It scaffolds question folders with tests, tracks progress in SQLite (with a per-question `scorecard.json` still written to disk), and provides LLM-powered review, disputes, follow-up probes, and generation — all through the app's server engines.

## User Workflow (Installed CLI)

When using the published CLI (`npm install -g ace-interview-prep`), the typical flow is:

1. `ace setup` to store API keys in `~/.ace/config.json` (supports OpenAI and Anthropic; can set a default provider)
2. `ace init` in a workspace folder to bootstrap `questions/` plus test/tooling config and run `npm install`
3. `ace ui` to launch the local web app — all practising happens there: generating questions, running tests, streamed AI review, disputing a wrong test assertion, follow-up probes, and workspace reset

The CLI itself has exactly three commands — `setup`, `init`, `ui`. The earlier per-action commands (`generate`, `test`, `feedback`, `score`, `reset`, `dispute`) were retired at the M2 cut line and now live as server engines behind `ace ui`; invoking them errors.

Notes:

- Global config is under `~/.ace/` (`config.json` primary; `.env` fallback; environment variables final fallback).
- Do not commit API keys or secrets.

## Repo Structure

- `cli/`: CLI entry point, commands, libs, templates, and LLM prompts
- `questions/`: All interview questions organized by category
- `dist/`: built output

## Question Layout + Workflow

Each question lives at `questions/<category>/<slug>/` and includes:

- `README.md`: problem statement, examples, constraints
- `scorecard.json`: progress tracking (auto-managed by CLI)
- Solution file:
  - `js-ts`, `leetcode-ds`, `leetcode-algo`: `solution.ts`
  - `web-components`: `Component.tsx`
  - `react-apps`: `App.tsx`
  - `design-*`: `notes.md` (no tests)
- Test file (when applicable):
  - `solution.test.ts`, `Component.test.tsx`, `App.test.tsx`

Workflow when solving:

1. Read the question's `README.md`
2. Implement only in the solution file for that category
3. Run tests for the question
4. Do not modify tests (they define the acceptance criteria)

Repo note: for seed-question maintenance in this repo, test updates are allowed when fixing/improving the seed suites.

Adding new questions:

- For end-users in a workspace: use the app's `/new` screen (`ace ui`) — the CLI's old `ace generate` command retired at the M2 cut line and no longer exists; only `init` / `setup` / `ui` remain in `cli/commands/`
- For this repo's seed questions: write a throwaway script that calls `scaffoldQuestionAt()` (`cli/lib/scaffold.ts`) against the repo root, run it once, then delete the script before committing
- Never create question folders manually

## Common Dev Commands (Repo)

- `npm install`
- `npm run ace help` (run the CLI locally via `tsx`)
- `npm test` / `npm run test:watch`
- `npm run build` (compiles to `dist/`, copies templates/prompts, adds Node shebang)
- `node dist/cli/index.js help` (smoke test the built CLI)

## Commands

- `npm run ace`: run the CLI (`tsx cli/index.ts`)
- `npm test`: run all tests (`vitest run`)
- `npm run test:watch`: watch mode

The CLI surface is just `setup`, `init`, and `ui` (see the User Workflow section). Per-question actions — running tests, review, disputes, probes, reset — are driven from the `ace ui` app, not from CLI subcommands.

## CLI Command Implementation Conventions

Command files under `cli/commands/`:

- Export `run(args: string[]): Promise<void>`
- Use `chalk` for colored terminal output
- Use `cli-table3` for table formatting
- Use `prompts` for interactive input
- Use the custom `parseArgs()` helper for arg parsing
- Handle errors with descriptive messages (prefer chalk-red)
- Commands are lazy-loaded via dynamic imports in `cli/index.ts`
- For ESM path resolution use `import.meta.dirname` (do not use `__dirname`)

Adding a new command:

1. Create `cli/commands/<name>.ts` exporting `run(args: string[])`
2. Register it in `cli/index.ts` in the `COMMANDS` map
3. Add a description in `printHelp()`

## TypeScript Conventions

- ES modules only (`import` / `export`)
- Node built-ins use `node:` prefix (e.g. `import fs from 'node:fs'`)
- Use path alias `@cli/*` for imports from `cli/`
- Use `.js` file extensions in relative imports (ESM requirement)
- Files: `kebab-case`; functions/vars: `camelCase`; types: `PascalCase`
- Prefer string unions over enums (e.g. `'easy' | 'medium' | 'hard'`)
- Strict mode: handle null/undefined; avoid implicit `any`
- Prefer named exports; default exports only for React components

## Testing Conventions (Vitest)

- Vitest with globals enabled (no `import { describe, it, expect }`)
- `happy-dom` test environment
- Tests live alongside solutions in `questions/`
- Timeout: 10s per test
- React tests: `@testing-library/react` + jest-dom matchers (from `vitest.setup.ts`)
- Use `vi.fn()` for mocks and `vi.useFakeTimers()` for timer-dependent tests

Note: tests only run from `questions/**/*.test.{ts,tsx}` (vitest config scopes to this).

## E2E Test Plan Maintenance

- Keep `docs/e2e-test-plan.md` updated when code changes introduce new user flows, change CLI behavior, or add new testable functionality.

## Commits / Releases

- Use Conventional Commits (used by automated releases via Release Please): `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`.
