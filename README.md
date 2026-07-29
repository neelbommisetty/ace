# ace

[![npm version](https://img.shields.io/npm/v/ace-interview-prep.svg)](https://www.npmjs.com/package/ace-interview-prep)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local-first web app for frontend interview practice. `ace ui` opens a practice room in your browser — a Monaco editor synced to files on disk, live Vitest runs, streamed AI code review, test disputes, and AI question generation — powered by OpenAI or Anthropic, either directly or through any compatible proxy.

## Overview

Everything runs on your machine. `ace init` bootstraps a plain-files workspace under `questions/`, and `ace ui` starts a token-gated local server that serves the app and works against that workspace: question content stays as ordinary TypeScript/Markdown files you could edit with anything, while attempt history, reviews, and disputes live in SQLite at `.ace/ace.db`. LLM features are layered on top of standard TypeScript and Vitest tooling rather than replacing it — no hosted backend, no account.

## The app

- **Library** — browse every question in the workspace with status, category, and difficulty; import legacy scorecard-based workspaces.
- **Room** — Monaco editor two-way-synced to disk (external edits show up live), Vitest runs streamed into the UI, and versioned AI reviews that stream in and are salvaged to disk if anything dies mid-stream. Fresh attempts restore the original scaffold, and an untouched-stub guard blocks accidental paid reviews of unmodified starter code.
- **Disputes** — when a generated test looks wrong, the dispute flow has the AI compare the spec against the failing assertions and proposes a diff you can apply in place.
- **New question** — generate questions from a topic or brainstorm ideas in a chat; generation runs as background jobs through a verified pipeline (generate → edge-audit → verify/repair) with live progress and a debrief reveal when it lands.
- **History** — full-text search (SQLite FTS5) across past reviews and disputes.
- **Settings** — API keys (write-only, masked, validated against the provider before saving), default provider, per-provider base URLs for proxy routing, and a danger zone for clearing progress or resetting the workspace.

## Question categories

| Category | Slug | Type | Focus |
|----------|------|------|-------|
| JS/TS Puzzles | `js-ts` | Coding | Closures, async patterns, type utilities |
| React Components | `web-components` | Coding | Props, events, composition, reusable UI |
| React Web Apps | `react-apps` | Coding | Hooks, state, routing, full features |
| LeetCode Data Structures | `leetcode-ds` | Coding | Trees, graphs, heaps, hash maps |
| LeetCode Algorithms | `leetcode-algo` | Coding | DP, greedy, two pointers, sorting |
| System Design — Frontend | `design-fe` | Design | Component architecture, state, rendering |
| System Design — Backend | `design-be` | Design | APIs, databases, caching, queues |
| System Design — Full Stack | `design-full` | Design | End-to-end systems, trade-offs |

## Architecture

`ace ui` starts a Hono server (default port 4242, scanning upward if it's taken) bound to `127.0.0.1` and gated by a per-session token. The server in [`cli/server/`](cli/server) owns the workspace session: a SQLite database via `node:sqlite`, a chokidar watcher that reconciles disk edits with the editor, programmatic Vitest execution, and engines for reviews, disputes, brainstorming, and verified generation — all streamed to the React app over SSE.

The UI in [`ui/src/`](ui/src) is a React + Monaco single-page app talking to that server's REST + SSE API. Shared logic lives in [`cli/lib/`](cli/lib) — category metadata, workspace discovery, global config with explicit precedence (`~/.ace/config.json`, then `~/.ace/.env`, then environment), and the LLM layer. Prompt files under [`cli/prompts/`](cli/prompts) and Handlebars templates under [`cli/templates/`](cli/templates) separate question authoring, review, brainstorming, and dispute analysis by domain.

Global configuration lives under `~/.ace/`, per-workspace state under `<workspace>/.ace/`, and question content stays in plain files — provider credentials never enter the workspace, and each question folder is self-contained.

## Technical highlights

- All LLM calls go through [`cli/lib/llm.ts`](cli/lib/llm.ts): native OpenAI and Anthropic clients via the Vercel AI SDK, a per-purpose model map (generation, edge-audit, review, extraction, brainstorm, dispute), streaming output as `AsyncIterable<string>`, and Zod-validated structured output.
- Per-provider base URLs (`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`) point those clients at any endpoint speaking the OpenAI or Anthropic wire protocol — e.g. a local subscription-backed proxy — and key validation probes `{base}/models` on the configured host rather than assuming the vendor API.
- Question generation is a verified pipeline: generated tests are edge-audited and run against a reference solution, with automatic repair before anything reaches the workspace.
- Reviews are versioned and crash-safe: a watchdog detects stalled streams and salvages partial output to disk.
- Server endpoints are guarded against DNS rebinding (host allow-listing) and gated behind a launch token.
- The test suite (Vitest + happy-dom + Testing Library) covers the config/LLM layer, server routes, engines, and UI screens; `tsc --noEmit` runs for both the CLI/server and UI projects.

## Getting started

```bash
npm install -g ace-interview-prep
mkdir practice && cd practice
ace init
ace ui
```

`ace init` copies a small hand-authored starter pack (six questions across JS/TS,
LeetCode, React, and system design) into the new workspace, so the first `ace ui`
opens a library you can practise in immediately — no API key, no LLM call. Pass
`ace init --no-samples` for an empty workspace; an existing workspace can adopt
the pack later from the Library's "Add starter questions" action. Add provider
credentials with `ace setup` (or in the app's Settings screen) when you want ACE
to generate questions and review your solutions.

`ace setup` stores provider credentials in `~/.ace/config.json` and validates them before saving. If both providers are valid, it also records a default provider. Useful variants:

```bash
ace setup --openai-key sk-... --anthropic-key sk-ant-...
ace setup --openai-key sk-... --anthropic-key sk-ant-... --default-provider anthropic

# Route a provider through an OpenAI-/Anthropic-compatible proxy.
# The URL includes the /v1 path; pass `none` to go back to the vendor API.
ace setup --anthropic-key sk-local-... --anthropic-base-url http://localhost:4242/v1
ace setup --anthropic-base-url none
```

Earlier CLI question workflows (`generate`, `test`, `feedback`, `score`, `dispute`, …) still ship for scripted use, but the web app is the primary interface.

### Develop locally

```bash
git clone https://github.com/neelbommisetty/ace.git
cd ace
npm install
npm run ace ui        # run the CLI through tsx
npm test
npm run build
node dist/index.js help
```

## Project structure

- `cli/server/` — Hono API, SQLite persistence, SSE bus, watcher, and the review/dispute/generation/brainstorm engines
- `ui/src/` — React + Monaco single-page app (screens, components, API client)
- `cli/commands/` — one file per CLI command (`setup`, `init`, `ui`, plus legacy question commands)
- `cli/lib/` — shared config, paths, LLM, scaffolding, and category logic
- `cli/prompts/` — Markdown prompts for generation, review, brainstorming, and dispute analysis
- `cli/templates/` — Handlebars templates used to scaffold question files
- `questions/` — workspace root for generated question folders
- `dist/` — compiled ESM output plus the built UI and runtime assets

## Configuration

Global configuration is stored under `~/.ace/` and shared across workspaces.

- `~/.ace/config.json` — primary config written by `ace setup` and the Settings screen
- `~/.ace/.env` — dotenv-style fallback
- environment variables — final fallback

Supported keys include:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — optional `/v1`-inclusive endpoint overrides (e.g. `http://localhost:4242/v1` for a local proxy); when unset, calls go to the vendor APIs
- `default_provider`

Base URLs follow the same precedence chain as keys. Clearing one (`ace setup --*-base-url none`, or an empty save in the UI) removes only the `config.json` entry — if `~/.ace/.env` or an environment variable still supplies the value, ace warns (CLI) or rejects the clear (UI/server) rather than silently leaving the override active.

## Tech stack

- TypeScript, Node.js 22.12+, ESM
- Hono + `@hono/node-server`, SSE, `node:sqlite`
- React, React Router, Monaco (`@monaco-editor/react`), react-markdown
- Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`), Zod
- Vitest, happy-dom, Testing Library, chokidar, Handlebars
- Vite, tsup, tsx, Husky, commitlint

## Status and roadmap

- **Shipped**: the practice room (editor ↔ disk ↔ tests), versioned streamed reviews, dispute-as-diff, history search, workspace clear/reset, the generate/brainstorm UI, the verified generation pipeline with debrief, and proxy base-URL support.
- **In progress**: AI interviewer chat with verbal-first delivery.
- **Planned**: mistake ledger with pre-flight coach's notes, and timed interview sessions with a progress dashboard.

See [CONTRIBUTING.md](CONTRIBUTING.md) for repo-specific development notes.

## License

[MIT](LICENSE)
