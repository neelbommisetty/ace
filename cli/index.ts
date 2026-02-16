#!/usr/bin/env node

import chalk from 'chalk';

const [, , command, ...args] = process.argv;

const COMMANDS: Record<string, () => Promise<{ run: (args: string[]) => Promise<void> }>> = {
  setup: () => import('./commands/setup.js'),
  init: () => import('./commands/init.js'),
  generate: () => import('./commands/generate.js'),
  add: () => import('./commands/add.js'),
  list: () => import('./commands/list.js'),
  test: () => import('./commands/test.js'),
  feedback: () => import('./commands/feedback.js'),
  reset: () => import('./commands/reset.js'),
  score: () => import('./commands/score.js'),
};

function printHelp() {
  console.log(`
${chalk.bold.cyan('ace')} — Frontend Interview Prep CLI

${chalk.bold('Setup Commands:')}

  ${chalk.green('setup')}      Configure API keys (stored in ~/.ace)
  ${chalk.green('init')}       Initialize workspace with questions/ and test config

${chalk.bold('Question Commands:')}

  ${chalk.green('generate')}   Generate a question using LLM (--brainstorm for interactive mode)
  ${chalk.green('add')}        Manually add a question with interactive prompts
  ${chalk.green('list')}       List all questions with status and filters
  ${chalk.green('test')}       Run tests for a question (or all questions)
  ${chalk.green('feedback')}   Get LLM code review or design review
  ${chalk.green('reset')}      Reset a question to unanswered state
  ${chalk.green('score')}      View scorecard for a question

${chalk.bold('Examples:')}

  ace setup
  ace init
  ace generate --topic "debounce" --category js-ts --difficulty medium
  ace generate --brainstorm
  ace list
  ace list --category js-ts --status solved
  ace test debounce
  ace test --watch
  ace feedback debounce
  ace reset debounce
  ace score debounce
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  const loader = COMMANDS[command];
  if (!loader) {
    console.error(chalk.red(`Unknown command: ${command}`));
    console.error(`Run ${chalk.cyan('npm run ace help')} for usage.`);
    process.exit(1);
  }

  try {
    const mod = await loader();
    await mod.run(args);
  } catch (err) {
    if (err instanceof Error) {
      console.error(chalk.red(`Error: ${err.message}`));
    } else {
      console.error(chalk.red('An unexpected error occurred'));
    }
    process.exit(1);
  }
}

main();
