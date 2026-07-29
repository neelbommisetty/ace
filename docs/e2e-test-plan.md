# E2E Test Plan

## Purpose

Ensure ace works end-to-end for the primary user workflow: configure credentials, bootstrap a workspace, and launch the app. Practising itself (generation, tests, review, disputes, probes, reset) happens inside the `ace ui` web app and is covered by the server engine + UI test suites, not by CLI commands.

## Scope

Covers the three CLI commands that still exist — `setup`, `init`, `ui` — their filesystem side effects, and the workspace-reset flow exercised over a real running `ace ui` server. Focuses on flows a user runs with the installed CLI and on this repo when run via `npm run ace`.

The per-action CLI commands the older revision of this plan tested (`generate`, `test`, `feedback`, `score`, `reset`, `dispute`, `test --all`) were retired at the M2 cut line and no longer exist; their behaviour now lives behind `ace ui` and is verified by `cli/server/*.test.ts` and the UI screen tests.

## Out of Scope

Performance benchmarking, network reliability, and LLM model quality. In-browser rendering of the app beyond what the server drives (covered by the UI suite). The paid-flow-through-the-proxy smoke is tracked separately as a manual gate check (see NEE-364), since it depends on the owner's live proxy and provider key.

## Environments

- Node.js LTS compatible with repo `package.json` engines
- macOS and Linux shells
- Clean temp workspace per run
- Automated E2E runs use `ACE_E2E_MOCK_LLM=1`, optional `ACE_MOCK_LLM_MODE`, and `ace init --skip-install` plus a `node_modules` symlink

## Test Data

- A temp workspace directory
- Sample `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in a secure test environment
- A known question slug from the starter pack for deterministic tests

## E2E Scenarios

These mirror the automated coverage in `cli/e2e/` (`setup.test.ts`, `init.test.ts`, `workspace-reset.test.ts`).

1. Setup stores config
Steps: run `ace setup` with a provider and key; confirm `~/.ace/config.json` is created and contains the provider without exposing secrets in logs.

2. Init bootstraps workspace
Steps: run `ace init`; verify `questions/` created; verify `package.json`, the `vitest` config, and (unless `--skip-install`) `node_modules` exist; run `npm test` to ensure the starter pack passes.

3. Init copies the starter pack by default
Steps: run `ace init`; verify the twelve starter questions (six behavioral plus one each of js-ts, web-components, react-apps, leetcode-ds, leetcode-algo, design-fe) are scaffolded with `README.md`, `scorecard.json`, and the correct solution/test filenames per category.

4. Init `--no-samples` leaves an empty library
Steps: run `ace init --no-samples`; verify `questions/` exists but contains no seeded question folders, and the workspace still bootstraps and runs `npm test` cleanly.

5. Launch serves the app on the default port
Steps: run `ace ui`; verify it binds `127.0.0.1:4280` (scanning upward if taken), gates requests behind the launch token in `~/.ace/ui-token`, and serves the SPA and `/api/*` routes. (Port 4280 is deliberately not 4242 — that is reserved for the local proxy target.)

6. Workspace reset — progress mode over a live server
Steps: with a running server and some attempt history, trigger a progress reset; verify SQLite progress is cleared while solution files on disk are preserved.

7. Workspace reset — full mode over a live server
Steps: modify a solution, then trigger a full reset; verify the solution file is restored to its captured scaffold baseline (or the rendered template stub when no snapshot exists) and the solved code is snapshotted into the archive first.

8. Workspace reset — guarded against a running test
Steps: start a deliberately slow test run, then request a reset; verify the reset is refused with a 409 rather than racing the runner.

9. Clean server shutdown after a reset
Steps: perform a reset, then close the server; verify `server.close()` resolves promptly, leaving no dangling watcher or database handles.

## Reporting

Record pass/fail per scenario, exit codes / HTTP statuses, and any unexpected filesystem changes. Attach command and server logs when failures occur.
