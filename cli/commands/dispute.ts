import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import prompts from 'prompts';
import chalk from 'chalk';
import { z } from 'zod';
import { NoObjectGeneratedError } from 'ai';
import { findQuestion, readScorecard, writeScorecard, promptForSlug } from '../lib/scorecard.js';
import { CATEGORIES, isDesignCategory } from '../lib/categories.js';
import { chatObject, requireProvider } from '../lib/llm.js';
import type { LLMMessage } from '../lib/llm.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';
import { getImportMetaDirname } from '../lib/import-meta.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');
}

const TestVerdictSchema = z.enum(['test_incorrect', 'solution_incorrect', 'ambiguous']);

const DisputeResultSchema = z.object({
  verdict: TestVerdictSchema,
  summary: z.string(),
  details: z.string(),
  failingTests: z.array(
    z.object({
      testName: z.string(),
      verdict: TestVerdictSchema,
      explanation: z.string(),
      fixedAssertion: z.string().nullish(),
    }),
  ),
  fixedTestCode: z.string().nullish(),
  hint: z.string().nullish(),
});

function parseArgs(args: string[]): { slug?: string; provider?: string } {
  let slug: string | undefined;
  let provider: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider' && args[i + 1]) {
      provider = args[++i];
    } else if (!arg.startsWith('--')) {
      slug = arg;
    }
  }

  return { slug, provider };
}

function runTestsAndCapture(projectRoot: string, questionDir: string): { output: string; exitCode: number } {
  const result = spawnSync('npx', ['vitest', 'run', questionDir], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const output = [stdout, stderr].filter(Boolean).join('\n');
  const exitCode = typeof result.status === 'number' ? result.status : 1;

  return { output, exitCode };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(projectRoot)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const parsed = parseArgs(args);

  // If no slug provided, show interactive picker
  let selectedSlug = parsed.slug;
  if (!selectedSlug) {
    selectedSlug = (await promptForSlug()) ?? undefined;
    if (!selectedSlug) return;
  }

  const question = findQuestion(selectedSlug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${selectedSlug}`));
    return;
  }

  if (isDesignCategory(question.category)) {
    console.log(chalk.yellow(`"${selectedSlug}" is a system design question — no tests to dispute.`));
    return;
  }

  const config = CATEGORIES[question.category];

  // Read the problem statement
  const readmePath = path.join(question.dir, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';

  if (!readme.trim()) {
    console.error(chalk.red('No README.md found for this question.'));
    return;
  }

  // Read solution files
  let solutionContent = '';
  for (const f of config.solutionFiles) {
    const fp = path.join(question.dir, f);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf-8');
      solutionContent += `\n--- ${f} ---\n${content}\n`;
    }
  }

  if (!solutionContent.trim() || solutionContent.includes('// TODO: implement')) {
    console.error(chalk.yellow('Solution appears to be the default stub. Write your solution first!'));
    return;
  }

  // Read test files
  let testContent = '';
  let testFilePath = '';
  for (const f of config.testFiles) {
    const fp = path.join(question.dir, f);
    if (fs.existsSync(fp)) {
      testContent += fs.readFileSync(fp, 'utf-8');
      testFilePath = fp;
    }
  }

  if (!testContent.trim()) {
    console.error(chalk.red('No test file found for this question.'));
    return;
  }

  // Run tests and capture output
  console.log(chalk.cyan(`\nRunning tests for "${selectedSlug}" to capture failures...\n`));
  const initialRun = runTestsAndCapture(projectRoot, question.dir);
  const testOutput = initialRun.output;

  if (initialRun.exitCode === 0) {
    console.log(chalk.green('All tests are passing — nothing to dispute.'));
    return;
  }

  const provider = requireProvider(parsed.provider);

  console.log(chalk.yellow('\nFailing tests detected. Sending to LLM for analysis...\n'));

  // Build the LLM request
  const systemPrompt = loadPrompt('test-dispute.md');
  const userContent = `## Problem Statement
${readme}

## Solution Code
${solutionContent}

## Test File
${testContent}

## Test Failure Output
\`\`\`
${testOutput}
\`\`\``;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const spinner = ['|', '/', '-', '\\'];
  let spinIdx = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(spinner[spinIdx++ % spinner.length])} Analyzing...`);
  }, 120);

  let result: z.infer<typeof DisputeResultSchema> | undefined;
  let chatError: unknown;
  try {
    result = await chatObject(provider, messages, DisputeResultSchema, { purpose: 'dispute' });
  } catch (err) {
    chatError = err;
  } finally {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
  }

  if (!result) {
    console.error(chalk.red('Failed to parse LLM response.'));
    console.log(chalk.dim(String(NoObjectGeneratedError.isInstance(chatError) ? chatError.text : chatError)));
    return;
  }

  // Display the verdict
  const verdictColors: Record<string, (s: string) => string> = {
    test_incorrect: chalk.green,
    solution_incorrect: chalk.red,
    ambiguous: chalk.yellow,
  };
  const verdictLabels: Record<string, string> = {
    test_incorrect: 'Test is incorrect',
    solution_incorrect: 'Solution has a bug',
    ambiguous: 'Ambiguous specification',
  };
  const color = verdictColors[result.verdict] || chalk.white;
  const label = verdictLabels[result.verdict] || result.verdict;

  console.log(chalk.bold(`\nVerdict: ${color(label)}\n`));
  console.log(result.summary);
  console.log(chalk.dim('\n--- Details ---\n'));
  console.log(result.details);

  // Per-test breakdown
  if (result.failingTests?.length) {
    console.log(chalk.dim('\n--- Per-Test Breakdown ---\n'));
    for (const t of result.failingTests) {
      const tColor = verdictColors[t.verdict] || chalk.white;
      console.log(`  ${tColor('●')} ${chalk.bold(t.testName)}: ${tColor(verdictLabels[t.verdict] || t.verdict)}`);
      console.log(`    ${t.explanation}`);
      if (t.fixedAssertion) {
        console.log(chalk.dim(`    Fix: ${t.fixedAssertion}`));
      }
    }
  }

  // If the test is wrong, offer to fix it
  if ((result.verdict === 'test_incorrect' || result.verdict === 'ambiguous') && result.fixedTestCode) {
    console.log('');
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Apply the corrected test file?',
      initial: true,
    });

    if (confirm) {
      fs.writeFileSync(testFilePath, result.fixedTestCode, 'utf-8');
      console.log(chalk.green(`\nTest file updated: ${path.relative(projectRoot, testFilePath)}`));

      // Re-run tests to verify the fix
      console.log(chalk.cyan('\nRe-running tests to verify...\n'));
      const verifyRun = runTestsAndCapture(projectRoot, question.dir);
      const verifyOutput = verifyRun.output;
      console.log(verifyOutput);

      // Update scorecard
      const scorecard = readScorecard(question.category, selectedSlug);
      if (scorecard) {
        const passMatch = verifyOutput.match(/(\d+)\s+passed/);
        const failMatch = verifyOutput.match(/(\d+)\s+failed/);
        const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
        const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
        const total = passed + failed;

        if (total > 0) {
          if (scorecard.attempts.length === 0) {
            scorecard.attempts.push({ attempt: 1, testsTotal: 0, testsPassed: 0, llmScore: null });
          }
          const current = scorecard.attempts[scorecard.attempts.length - 1];
          current.testsTotal = total;
          current.testsPassed = passed;
          scorecard.status = passed === total ? 'solved' : 'attempted';
          writeScorecard(question.category, selectedSlug, scorecard);

          const resultColor = passed === total ? chalk.green : chalk.yellow;
          console.log(resultColor(`Scorecard updated: ${passed}/${total} tests passed`));
        }
      }
    } else {
      console.log(chalk.dim('No changes made.'));
    }
  } else if (result.verdict === 'solution_incorrect' && result.hint) {
    console.log(chalk.dim('\n--- Hint ---\n'));
    console.log(chalk.yellow(result.hint));
  }
}
