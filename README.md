# ace

[![npm version](https://img.shields.io/npm/v/ace-interview-prep.svg)](https://www.npmjs.com/package/ace-interview-prep)
[![CI](https://github.com/neel/ace-interview-prep/actions/workflows/ci.yml/badge.svg)](https://github.com/neel/ace-interview-prep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A CLI tool for staff-engineer-level frontend interview preparation. Scaffolds questions with test cases, tracks progress with scorecards, and provides LLM-powered feedback.

## Install

```bash
npm install -g ace-interview-prep
```

Or run directly with npx:

```bash
npx ace-interview-prep help
```

## Quick Start

### 1. Configure API Keys

```bash
ace setup
```

Stores your OpenAI / Anthropic API keys in `~/.ace/config.json` (one-time, works across all workspaces).

```bash
# Non-interactive
ace setup --openai-key sk-... --anthropic-key sk-ant-...
```

### 2. Initialize a Workspace

Navigate to any folder where you want to practice:

```bash
ace init
```

Creates a `questions/` directory and vitest config files. Then install the test dependencies:

```bash
npm install vitest happy-dom @testing-library/jest-dom
```

### 3. Practice

```bash
# Generate a question interactively (prompts for category, difficulty, topic)
ace generate

# Or pass flags to skip prompts
ace generate --topic "debounce" --category js-ts --difficulty medium

# Interactive brainstorm mode
ace generate --brainstorm

# Manually add a question
ace add

# List all questions
ace list
```

### 4. Test, Review, Track

All commands below work in three modes:
- **Interactive** — run with no arguments to pick from a selectable list
- **Direct** — pass a slug to target a specific question
- **All** — pass `--all` to operate on every question

```bash
# Run tests
ace test              # pick from list
ace test debounce     # specific question
ace test --all        # run all tests
ace test --watch      # watch mode (with --all)

# Get LLM feedback on your solution
ace feedback          # pick from list
ace feedback debounce # specific question
ace feedback --all    # review all questions (confirms each one)

# View scorecard
ace score             # pick from list
ace score debounce    # specific question
ace score --all       # show all scorecards

# Reset a question to its stub
ace reset             # pick from list
ace reset debounce    # specific question
ace reset --all       # reset everything (with confirmation)
```

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

## How It Works

1. **Generate a question** — run `ace generate` and follow the prompts (category, difficulty, topic), or use `ace generate --brainstorm` for an interactive design session.
2. **Open the question folder** — read `README.md` for the problem statement.
3. **Write your solution** in the solution file (`solution.ts`, `App.tsx`, `Component.tsx`, or `notes.md`).
4. **Run tests** with `ace test` to pick a question and check your work.
5. **Get feedback** with `ace feedback` for an LLM-powered code or design review.
6. **Track progress** with `ace score` and `ace list`.

## Configuration

**Global** (`~/.ace/`) — API keys stored once, shared across all workspaces.

- `~/.ace/config.json` — primary config (created by `ace setup`)
- `~/.ace/.env` — fallback (dotenv format)
- Environment variables — final fallback

**Workspace** — each workspace gets its own `questions/` directory and test config.

## Seed Questions

Ships with 8 starter questions (one per category) so you can begin practicing immediately after install.

## Development

```bash
git clone https://github.com/neel/ace-interview-prep.git
cd ace-interview-prep
npm install
npm run ace help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## License

[MIT](LICENSE)
