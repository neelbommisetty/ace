# Contributing to ace

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/neel/ace-interview-prep.git
cd ace-interview-prep

# Install dependencies
npm install

# Run the CLI in development mode
npm run ace help
```

## Project Structure

```
cli/
  index.ts          CLI entry point and command router
  commands/         One file per command (add, generate, list, test, etc.)
  lib/              Shared utilities (paths, config, LLM, scaffolding)
  templates/        Handlebars templates for scaffolding questions
  prompts/          Markdown prompts sent to LLMs
questions/          Seed questions (one per category) for development/testing
scripts/            Build and release tooling
```

## Common Tasks

### Run the CLI locally

```bash
npm run ace <command>

# Examples
npm run ace list
npm run ace generate -- --topic "throttle" --category js-ts --difficulty easy
```

### Run tests

```bash
npm test            # single run
npm run test:watch  # watch mode
```

### Build

```bash
npm run build
```

This compiles TypeScript to `dist/`, copies templates and prompts, and adds the
Node.js shebang to the entry point.

### Test the built CLI

```bash
node dist/cli/index.js help
```

## Adding a New Command

1. Create `cli/commands/<name>.ts` exporting an async `run(args: string[])` function.
2. Register the command in `cli/index.ts` in the `COMMANDS` map.
3. Add a description in the `printHelp()` function.

## Adding Seed Questions

Each question lives in `questions/<category>/<slug>/` and contains:

- `README.md` — problem statement
- Solution file(s) — stubs with `// TODO: implement`
- Test file — comprehensive test suite
- `scorecard.json` — must start with `"status": "untouched"` and empty `attempts`

Use the `ace generate` command to scaffold a new question, then clean up
the generated files for use as a seed question.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) to
power automated releases via Release Please.

```
feat: add new throttle question
fix: correct test timeout in star-rating
docs: update README install instructions
chore: bump vitest to v4
```

## Pull Requests

1. Fork the repo and create a feature branch from `main`.
2. Make your changes and ensure tests pass (`npm test`).
3. Ensure the build succeeds (`npm run build`).
4. Open a PR against `main` with a clear description.

## Code Style

- TypeScript strict mode — no `any` unless unavoidable.
- ESM only — use `import`/`export`, not `require`.
- Use `.js` extensions in all relative imports (required for ESM resolution).
