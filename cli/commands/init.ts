import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { getQuestionsDir, isWorkspaceInitialized } from '../lib/paths.js';
import { copyStarterPack } from '../lib/starter-pack.js';

function parseArgs(args: string[]): { force: boolean; skipInstall: boolean; samples: boolean } {
  return {
    force: args.includes('--force'),
    skipInstall: args.includes('--skip-install'),
    // A fresh workspace gets the bundled starter questions so the first
    // `ace ui` is practisable with no API key (NEE-301). `--no-samples`
    // reproduces the old behaviour: an empty questions/ tree.
    samples: !args.includes('--no-samples'),
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

const PACKAGE_JSON_TEMPLATE = {
  name: 'ace-workspace',
  private: true,
  type: 'module',
  scripts: {
    test: 'vitest run',
    'test:watch': 'vitest',
  },
  devDependencies: {
    '@testing-library/jest-dom': '^6.9.1',
    '@testing-library/react': '^16.3.2',
    '@types/react': '^19.2.14',
    '@types/react-dom': '^19.2.3',
    // vite + plugin-react power the live preview pane (NEE-348). `ace init`
    // merges missing devDependencies into an existing package.json, so
    // pre-existing workspaces pick these up by re-running init.
    '@vitejs/plugin-react': '^6.0.3',
    'happy-dom': '^20.6.1',
    'react': '^19.2.4',
    'react-dom': '^19.2.4',
    'typescript': '^5.9.3',
    'vite': '^8.1.5',
    'vitest': '^4.0.18',
  },
};

const TSCONFIG_TEMPLATE = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    esModuleInterop: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'react-jsx',
  },
  include: ['questions/**/*'],
};

export async function run(args: string[]): Promise<void> {
  const { force, skipInstall, samples } = parseArgs(args);
  const root = process.cwd();
  const shouldSkipInstall =
    skipInstall || process.env.ACE_SKIP_INSTALL === '1' || process.env.ACE_SKIP_INSTALL === 'true';

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

  // Starter pack — copied before npm install so the summary below is the last
  // thing between the user and a workspace they can actually open.
  let installedSamples = 0;
  if (samples) {
    try {
      const pack = copyStarterPack(root);
      installedSamples = pack.installed.length;
      if (pack.installed.length > 0) {
        changes.push(
          `Added ${pack.installed.length} starter question${pack.installed.length === 1 ? '' : 's'}`,
        );
      }
      if (pack.unavailable.length > 0) {
        console.warn(
          chalk.yellow(
            `Warning: ${pack.unavailable.length} starter question(s) missing from this install`,
          ),
        );
      }
    } catch {
      // A broken pack must not fail the init — the workspace itself is fine.
      console.warn(chalk.yellow('Warning: could not copy the starter questions'));
    }
  }

  // Create or merge package.json
  const packageJsonPath = path.join(root, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, JSON.stringify(PACKAGE_JSON_TEMPLATE, null, 2) + '\n', 'utf-8');
    changes.push('Created package.json');
  } else {
    // Merge scripts and devDependencies into existing package.json
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      let updated = false;

      // Merge scripts (don't overwrite existing)
      pkg.scripts = pkg.scripts || {};
      for (const [key, value] of Object.entries(PACKAGE_JSON_TEMPLATE.scripts)) {
        if (!pkg.scripts[key]) {
          pkg.scripts[key] = value;
          updated = true;
        }
      }

      // Merge devDependencies (don't overwrite existing)
      pkg.devDependencies = pkg.devDependencies || {};
      for (const [key, value] of Object.entries(PACKAGE_JSON_TEMPLATE.devDependencies)) {
        if (!pkg.devDependencies[key]) {
          pkg.devDependencies[key] = value;
          updated = true;
        }
      }

      if (updated) {
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
        changes.push('Updated package.json (scripts and devDependencies)');
      }
    } catch (err) {
      console.warn(chalk.yellow('Warning: Could not update package.json'));
    }
  }

  // Create tsconfig.json if missing
  const tsconfigPath = path.join(root, 'tsconfig.json');
  const tsconfigExisted = fs.existsSync(tsconfigPath);
  if (!tsconfigExisted || force) {
    fs.writeFileSync(tsconfigPath, JSON.stringify(TSCONFIG_TEMPLATE, null, 2) + '\n', 'utf-8');
    changes.push(tsconfigExisted ? 'Overwrote tsconfig.json' : 'Created tsconfig.json');
  }

  // Create vitest.config.ts if missing
  const vitestConfigPath = path.join(root, 'vitest.config.ts');
  const vitestConfigExisted = fs.existsSync(vitestConfigPath);
  if (!vitestConfigExisted || force) {
    fs.writeFileSync(vitestConfigPath, VITEST_CONFIG_TEMPLATE, 'utf-8');
    changes.push(vitestConfigExisted ? 'Overwrote vitest.config.ts' : 'Created vitest.config.ts');
  }

  // Create vitest.setup.ts if missing
  const vitestSetupPath = path.join(root, 'vitest.setup.ts');
  const vitestSetupExisted = fs.existsSync(vitestSetupPath);
  if (!vitestSetupExisted || force) {
    fs.writeFileSync(vitestSetupPath, VITEST_SETUP_TEMPLATE, 'utf-8');
    changes.push(vitestSetupExisted ? 'Overwrote vitest.setup.ts' : 'Created vitest.setup.ts');
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

  // Install dependencies
  console.log(chalk.cyan('--- Installing dependencies ---'));
  if (shouldSkipInstall) {
    console.log(chalk.yellow('Skipping npm install (set by --skip-install or ACE_SKIP_INSTALL).'));
  } else {
    try {
      execSync('npm install', { cwd: root, stdio: 'inherit' });
      console.log(chalk.green('\n✓ Dependencies installed'));
    } catch {
      console.error(chalk.red('\n✗ npm install failed. Please run it manually.'));
    }
  }

  console.log();

  // Print next steps. The app comes FIRST and needs no key: with the starter
  // pack on disk there is something to practise immediately, and Settings
  // inside the app is a better place to paste a key than a second CLI command.
  console.log(chalk.bold('Next steps:'));
  console.log(chalk.dim('  1. Open the app:'));
  console.log(chalk.dim('     ace ui'));
  if (installedSamples > 0) {
    console.log(
      chalk.dim(
        `  2. Pick one of the ${installedSamples} starter questions and start practising.`,
      ),
    );
    console.log(chalk.dim('  3. To generate your own questions, add an API key in Settings.'));
  } else {
    console.log(chalk.dim('  2. Add an API key in Settings, then generate your first question.'));
    console.log(chalk.dim('     (Or add the bundled starter questions from the Library.)'));
  }
  console.log();
}
