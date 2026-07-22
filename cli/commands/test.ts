import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { findQuestion, readScorecard, updateTestResults, writeScorecard, promptForSlug } from '../lib/scorecard.js';
import { isDesignCategory } from '../lib/categories.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

function parseArgs(args: string[]): { slug?: string; watch: boolean; all: boolean } {
  let slug: string | undefined;
  let watch = false;
  let all = false;

  for (const arg of args) {
    if (arg === '--watch') {
      watch = true;
    } else if (arg === '--all' || arg === 'all') {
      all = true;
    } else if (!arg.startsWith('--')) {
      slug = arg;
    }
  }

  return { slug, watch, all };
}

function parseTestOutput(output: string): { total: number; passed: number } {
  // Try to parse vitest output for test counts
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  const totalMatch = output.match(/Tests\s+(\d+)/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;

  return { total, passed };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(projectRoot)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const { slug, watch, all } = parseArgs(args);

  // Handle --all flag: run all tests
  if (all) {
    console.log(chalk.cyan('\nRunning all tests...\n'));
    try {
      const cmd = watch ? 'npx vitest' : 'npx vitest run';
      execSync(cmd, { cwd: projectRoot, stdio: 'inherit' });
    } catch {
      // vitest exits with non-zero when tests fail — that's expected
    }
    return;
  }

  // If no slug provided, show interactive picker
  let selectedSlug = slug;
  if (!selectedSlug) {
    selectedSlug = (await promptForSlug()) ?? undefined;
    if (!selectedSlug) return;
  }

  const question = findQuestion(selectedSlug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${selectedSlug}`));
    console.error(chalk.dim('Run `npm run ace list` to see all questions.'));
    return;
  }

  if (isDesignCategory(question.category)) {
    console.log(chalk.yellow(`"${selectedSlug}" is a system design question — no tests to run.`));
    console.log(chalk.dim('Use `npm run ace feedback ' + selectedSlug + '` for LLM review.'));
    return;
  }

  console.log(chalk.cyan(`\nRunning tests for: ${selectedSlug}\n`));

  let output = '';
  try {
    const cmd = watch
      ? `npx vitest ${question.dir}`
      : `npx vitest run ${question.dir}`;
    output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] });
    console.log(output);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      output = (err as { stdout: string }).stdout || '';
      console.log(output);
    }
  }

  // Update scorecard if not in watch mode
  if (!watch) {
    const scorecard = readScorecard(question.category, selectedSlug);
    if (scorecard) {
      const { total, passed } = parseTestOutput(output);
      updateTestResults(scorecard, total, passed);
      writeScorecard(question.category, selectedSlug, scorecard);

      if (total > 0) {
        const color = passed === total ? chalk.green : chalk.red;
        console.log(color(`\nScorecard updated: ${passed}/${total} tests passed`));
      }
    }
  }
}
