#!/usr/bin/env node

import chalk from 'chalk';

const [, , command, ...args] = process.argv;

// The CLI is a bootstrap surface only: configure credentials, create a
// workspace, open the app. Everything about practising — generating,
// listing, running tests, reviews, disputes, scores, resets — lives in the
// web app (`ace ui`) and its server engines under cli/server/.
const COMMANDS: Record<string, () => Promise<{ run: (args: string[]) => Promise<void> }>> = {
  setup: () => import('./commands/setup.js'),
  init: () => import('./commands/init.js'),
  ui: () => import('./commands/ui.js'),
};

function printHelp() {
  console.log(`
${chalk.bold.cyan('ace')} — Frontend Interview Prep CLI

${chalk.bold('Commands:')}

  ${chalk.green('setup')}      Configure API keys (stored in ~/.ace)
  ${chalk.green('init')}       Initialize workspace with questions/ and test config
  ${chalk.green('ui')}         Launch the ACE web app

${chalk.bold('Getting started:')}

  ace setup
  ace init
  ace ui

  ${chalk.dim('# Route a provider through a compatible proxy')}
  ace setup --anthropic-key sk-... --anthropic-base-url http://localhost:4242/v1

  ${chalk.dim('# Initialize without installing workspace dependencies')}
  ace init --skip-install

  ${chalk.dim('# Pick a port, or skip opening a browser tab')}
  ace ui --port 4300
  ace ui --no-open

${chalk.dim('Generating questions, running tests, reviews, disputes and progress all')}
${chalk.dim('live in the app itself — run `ace ui` and work from there.')}
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
