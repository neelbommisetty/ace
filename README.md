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
# Generate a question via LLM
ace generate --topic "debounce" --category js-ts --difficulty medium

# Interactive brainstorm mode
ace generate --brainstorm

# Manually add a question
ace add

# List all questions
ace list

# Run tests
ace test debounce
ace test              # run all
ace test --watch      # watch mode

# Get LLM feedback
ace feedback debounce

# View scorecard
ace score debounce

# Reset a question
ace reset debounce
```

## Question Categories

| Category | Slug | Type |
|----------|------|------|
| JS/TS Puzzles | `js-ts` | Coding |
| Web Components | `web-components` | Coding |
| React Web Apps | `react-apps` | Coding |
| LeetCode Data Structures | `leetcode-ds` | Coding |
| LeetCode Algorithms | `leetcode-algo` | Coding |
| System Design — Frontend | `design-fe` | Design |
| System Design — Backend | `design-be` | Design |
| System Design — Full Stack | `design-full` | Design |

## How It Works

1. **Pick a question** from the dashboard (`ace list`) or generate one (`ace generate`).
2. **Open the question folder** — read `README.md` for the problem statement.
3. **Write your solution** in the solution file (`solution.ts`, `App.tsx`, `component.ts`, or `notes.md`).
4. **Run tests** with `ace test <slug>` to check your work.
5. **Get feedback** with `ace feedback <slug>` for an LLM-powered code or design review.
6. **Track progress** with `ace score <slug>` and `ace list`.

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
