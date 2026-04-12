# ace

[![npm version](https://img.shields.io/npm/v/ace-interview-prep.svg)](https://www.npmjs.com/package/ace-interview-prep)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local-first CLI for frontend interview practice. `ace` bootstraps a workspace, scaffolds coding and system design questions, runs local tests, tracks progress in `scorecard.json`, and uses OpenAI or Anthropic for question generation, review, brainstorming, and test-dispute analysis.

## Overview

The project is built around a file-based workflow instead of a hosted service. A practice workspace lives on disk under `questions/`, question state is stored alongside each prompt, and LLM features are layered on top of standard TypeScript and Vitest tooling rather than replacing it. The result is a CLI that can generate interview exercises, evaluate implementations, and keep attempt history without requiring a backend.

## Core Capabilities

- `ace setup` stores and validates OpenAI and Anthropic keys in `~/.ace/config.json`, with support for a saved default provider.
- `ace init` bootstraps `questions/`, `package.json`, `tsconfig.json`, `vitest.config.ts`, and `vitest.setup.ts`, then runs `npm install` unless `--skip-install` is used.
- `ace generate` supports interactive prompts, direct flags, and `--brainstorm`, then scaffolds a question folder from category-specific prompt and template assets.
- `ace list`, `ace test`, `ace feedback`, `ace score`, and `ace reset` work against a local question workspace and support interactive slug selection; several also support `--all`.
- `ace dispute` analyzes failing generated tests against the problem statement, solution code, and Vitest output, then can apply a corrected test file and re-run verification.

## Question Categories

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

`ace` is a single-package TypeScript CLI. [`cli/index.ts`](cli/index.ts) is a thin command router that lazy-loads one module per subcommand. Each file in [`cli/commands/`](cli/commands) owns one workflow such as setup, generation, testing, scoring, or dispute handling.

Shared behavior lives in [`cli/lib/`](cli/lib). That layer handles category metadata, workspace discovery, global config loading, provider selection, streaming and non-streaming LLM calls, Handlebars-based scaffolding, and scorecard persistence. Prompt files under [`cli/prompts/`](cli/prompts) separate question authoring, review, brainstorming, and dispute analysis by domain. Templates under [`cli/templates/`](cli/templates) define the generated `README.md`, solution stub, test file, and design notes structure for each category.

Execution stays file-based from end to end. `ace generate` creates `questions/<category>/<slug>/` with a problem statement, solution stub, test file when applicable, and `scorecard.json`. `ace test` runs Vitest against a question and records pass counts. `ace feedback` streams a category-specific review and stores it on the scorecard. `ace reset` restores the template stub, and `ace dispute` re-runs failing tests, asks the LLM to compare spec versus assertions, and can patch the test file in place.

Global configuration lives under `~/.ace/`, while per-question state stays inside each generated folder. That split keeps provider credentials out of the workspace and makes each practice question self-contained.

## Technical Highlights

- Multi-provider LLM integration is centralized in [`cli/lib/llm.ts`](cli/lib/llm.ts), including both direct responses and streamed output exposed through `AsyncIterable<string>`.
- Config loading uses explicit precedence: `~/.ace/config.json`, then `~/.ace/.env`, then process environment variables.
- Workspace resolution walks upward to the nearest `questions/` directory, so commands still work from nested paths inside a practice workspace.
- `ace init` merges missing scripts and dev dependencies into an existing `package.json` instead of assuming a blank directory.
- Prompt logic is organized by domain across JS/TS, React, LeetCode, and system design for both generation and review flows.
- Progress tracking is file-backed through `scorecard.json`, including status, attempts, test counts, and saved LLM feedback.
- The test suite combines unit coverage for shared helpers with mock-driven E2E runs that create temp workspaces and execute the CLI end to end.
- The build uses non-bundled ESM via `tsup`, followed by a postbuild step that copies prompt/template assets into `dist/` and prepends a Node shebang to the CLI entry point.

## Tech Stack

- TypeScript, Node.js 18+, ESM
- OpenAI SDK, Anthropic SDK
- Handlebars, prompts, chalk, cli-table3
- Vitest, happy-dom, Testing Library
- tsx, tsup, Husky, commitlint

## Getting Started

### Use the published CLI

```bash
npm install -g ace-interview-prep
ace setup
mkdir practice && cd practice
ace init
ace generate --topic "debounce" --category js-ts --difficulty medium
ace test debounce
ace feedback debounce
ace score debounce
```

`ace setup` stores provider credentials in `~/.ace/config.json`. If both providers are valid, it also records a default provider.

Useful setup variants:

```bash
ace setup --openai-key sk-... --anthropic-key sk-ant-...
ace setup --openai-key sk-... --anthropic-key sk-ant-... --default-provider anthropic
```

### Develop locally

```bash
git clone https://github.com/neelbommisetty/ace.git
cd ace
npm install
npm run ace help
npm test
npm run build
node dist/index.js help
```

During local development, `npm run ace <command>` runs the CLI through `tsx`.

## Project Structure

- `cli/commands/` — one file per CLI command
- `cli/lib/` — shared config, path, LLM, scaffolding, and scorecard logic
- `cli/prompts/` — Markdown prompts for generation, review, brainstorming, and dispute analysis
- `cli/templates/` — Handlebars templates used to scaffold question files
- `cli/e2e/` — temp-workspace end-to-end tests for the CLI workflow
- `docs/` — repository documentation, including the E2E test plan
- `questions/` — workspace root for generated question folders
- `dist/` — compiled ESM output plus copied runtime assets

## Configuration

Global configuration is stored under `~/.ace/` and shared across workspaces.

- `~/.ace/config.json` — primary config written by `ace setup`
- `~/.ace/.env` — dotenv-style fallback
- environment variables — final fallback

Supported keys include:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `default_provider`

## Current Status

- Core CLI workflows are functional and covered by unit and E2E tests.
- The project is still early-stage and organized as a single package.
- Generated question quality depends on LLM output, which is why `ace dispute` exists as a corrective workflow.

See [CONTRIBUTING.md](CONTRIBUTING.md) for repo-specific development notes.

## License

[MIT](LICENSE)
