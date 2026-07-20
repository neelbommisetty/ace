#!/usr/bin/env node

import chalk from 'chalk';

const [, , command, ...args] = process.argv;

const COMMANDS: Record<string, () => Promise<{ run: (args: string[]) => Promise<void> }>> = {
  setup: () => import('./commands/setup.js'),
  init: () => import('./commands/init.js'),
  ui: () => import('./commands/ui.js'),
  generate: () => import('./commands/generate.js'),
  list: () => import('./commands/list.js'),
  test: () => import('./commands/test.js'),
  feedback: () => import('./commands/feedback.js'),
  reset: () => import('./commands/reset.js'),
  score: () => import('./commands/score.js'),
  dispute: () => import('./commands/dispute.js'),
};

function printHelp() {
  console.log(`
${chalk.bold.cyan('ace')} — Frontend Interview Prep CLI

${chalk.bold('Setup Commands:')}

  ${chalk.green('setup')}      Configure API keys (stored in ~/.ace)
  ${chalk.green('init')}       Initialize workspace with questions/ and test config
  ${chalk.green('ui')}         Launch the ACE web app

${chalk.bold('Question Commands:')}

  ${chalk.green('generate')}   Generate a question using LLM (--brainstorm for interactive mode)
  ${chalk.green('list')}       List all questions with status and filters
  ${chalk.green('test')}       Run tests for a question (or all questions)
  ${chalk.green('feedback')}   Get LLM code review or design review
  ${chalk.green('reset')}      Reset a question to unanswered state
  ${chalk.green('score')}      View scorecard for a question
  ${chalk.green('dispute')}    Challenge a potentially incorrect test case

${chalk.bold('Examples:')}

  ace setup
  ace init
  
  ${chalk.dim('# Generate interactively (prompts for category, difficulty, topic)')}
  ace generate
  
  ${chalk.dim('# Or pass flags to skip prompts')}
  ace generate --topic "debounce" --category js-ts --difficulty medium
  
  ${chalk.dim('# Brainstorm mode for design help')}
  ace generate --brainstorm
  
  ${chalk.dim('# List all questions')}
  ace list
  ace list --category js-ts --status solved
  
  ${chalk.dim('# Test interactively (shows question picker)')}
  ace test
  
  ${chalk.dim('# Or test a specific question or all questions')}
  ace test debounce
  ace test --all
  
  ${chalk.dim('# Feedback, score, and reset also support interactive mode and --all')}
  ace feedback
  ace feedback debounce
  ace feedback --all
  
  ace score
  ace score debounce
  ace score --all
  
  ace reset
  ace reset debounce
  ace reset --all
  
  ${chalk.dim('# Dispute a test you think is wrong')}
  ace dispute
  ace dispute debounce
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
