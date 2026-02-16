import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { getQuestionsDir, isWorkspaceInitialized } from '../lib/paths.js';

function parseArgs(args: string[]): { force: boolean; writeScripts: boolean } {
  return {
    force: args.includes('--force'),
    writeScripts: args.includes('--write-scripts'),
  };
}

const VITEST_CONFIG_TEMPLATE = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['questions/**/*.test.{ts,tsx}'],
    testTimeout: 10000,
    setupFiles: ['vitest.setup.ts'],
  },
});
`;

const VITEST_SETUP_TEMPLATE = `import '@testing-library/jest-dom/vitest';
`;

const PACKAGE_JSON_SCRIPTS = {
  ace: 'tsx cli/index.ts',
  test: 'vitest run',
  'test:watch': 'vitest',
};

export async function run(args: string[]): Promise<void> {
  const { force, writeScripts } = parseArgs(args);
  const root = process.cwd();

  console.log(chalk.cyan('\n--- Initialize Workspace ---'));
  console.log(chalk.dim(`Workspace: ${root}\n`));

  // Check if already initialized
  if (isWorkspaceInitialized(root) && !force) {
    console.log(chalk.yellow('✓ Workspace already initialized (questions/ exists)'));
    console.log(chalk.dim('Use --force to reinitialize.\n'));
    return;
  }

  const changes: string[] = [];

  // Create questions/ directory
  const questionsDir = getQuestionsDir(root);
  if (!fs.existsSync(questionsDir)) {
    fs.mkdirSync(questionsDir, { recursive: true });
    changes.push('Created questions/');
  }

  // Create vitest.config.ts if missing
  const vitestConfigPath = path.join(root, 'vitest.config.ts');
  if (!fs.existsSync(vitestConfigPath) || force) {
    fs.writeFileSync(vitestConfigPath, VITEST_CONFIG_TEMPLATE, 'utf-8');
    changes.push(force && fs.existsSync(vitestConfigPath) ? 'Overwrote vitest.config.ts' : 'Created vitest.config.ts');
  }

  // Create vitest.setup.ts if missing
  const vitestSetupPath = path.join(root, 'vitest.setup.ts');
  if (!fs.existsSync(vitestSetupPath) || force) {
    fs.writeFileSync(vitestSetupPath, VITEST_SETUP_TEMPLATE, 'utf-8');
    changes.push(force && fs.existsSync(vitestSetupPath) ? 'Overwrote vitest.setup.ts' : 'Created vitest.setup.ts');
  }

  // Handle package.json scripts
  const packageJsonPath = path.join(root, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    if (writeScripts) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        pkg.scripts = pkg.scripts || {};
        
        let added = false;
        for (const [key, value] of Object.entries(PACKAGE_JSON_SCRIPTS)) {
          if (!pkg.scripts[key]) {
            pkg.scripts[key] = value;
            added = true;
          }
        }
        
        if (added) {
          fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
          changes.push('Added scripts to package.json');
        }
      } catch (err) {
        console.warn(chalk.yellow('Warning: Could not update package.json scripts'));
      }
    }
  }

  // Print summary
  if (changes.length > 0) {
    console.log(chalk.green('✓ Workspace initialized:\n'));
    for (const change of changes) {
      console.log(chalk.dim(`  • ${change}`));
    }
  } else {
    console.log(chalk.green('✓ Workspace already initialized (no changes needed)'));
  }

  console.log();

  // Print next steps
  console.log(chalk.bold('Next steps:'));
  console.log(chalk.dim('  1. Install dependencies (if not already installed):'));
  console.log(chalk.dim('     npm install vitest happy-dom @testing-library/jest-dom'));
  console.log(chalk.dim('  2. Configure API keys:'));
  console.log(chalk.dim('     ace setup'));
  console.log(chalk.dim('  3. Generate or add questions:'));
  console.log(chalk.dim('     ace generate --topic "debounce"'));
  console.log(chalk.dim('     ace add'));
  console.log();
}
