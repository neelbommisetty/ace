import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { findQuestion, readScorecard, writeScorecard } from '../lib/scorecard.js';
import { CATEGORIES, isDesignCategory } from '../lib/categories.js';
import { chatStream, requireProvider } from '../lib/llm.js';
import type { LLMMessage } from '../lib/llm.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

const PROMPTS_DIR = path.resolve(import.meta.dirname, '../prompts');

function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');
}

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

export async function run(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const parsed = parseArgs(args);

  if (!parsed.slug) {
    console.error(chalk.red('Missing question slug.'));
    console.error(chalk.dim('Usage: npm run ace feedback <slug>'));
    return;
  }

  const question = findQuestion(parsed.slug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${parsed.slug}`));
    return;
  }

  const provider = requireProvider(parsed.provider);
  const config = CATEGORIES[question.category];
  const isDesign = isDesignCategory(question.category);

  // Read question files
  const readmePath = path.join(question.dir, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';

  let systemPrompt: string;
  let userContent: string;

  if (isDesign) {
    systemPrompt = loadPrompt('design-review.md');
    const notesPath = path.join(question.dir, 'notes.md');
    const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : '';

    if (!notes.trim() || notes.includes('<!-- List the core features')) {
      console.error(chalk.yellow('Notes file appears to be empty. Write your design notes first!'));
      console.error(chalk.dim(`Edit: questions/${question.category}/${parsed.slug}/notes.md`));
      return;
    }

    const designSubType = question.category === 'design-fe'
      ? 'frontend'
      : question.category === 'design-be'
        ? 'backend'
        : 'full-stack';

    userContent = `## Design Sub-Type: ${designSubType}

## Problem Statement
${readme}

## Candidate's Design Notes
${notes}`;
  } else {
    systemPrompt = loadPrompt('code-review.md');

    // Find the solution file
    const solutionFiles = config.solutionFiles;
    let solutionContent = '';
    for (const f of solutionFiles) {
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

    // Read test file for context
    let testContent = '';
    for (const f of config.testFiles) {
      const fp = path.join(question.dir, f);
      if (fs.existsSync(fp)) {
        testContent += `\n--- ${f} ---\n${fs.readFileSync(fp, 'utf-8')}\n`;
      }
    }

    userContent = `## Problem Statement
${readme}

## Candidate's Solution Code
${solutionContent}

## Test Cases
${testContent}`;
  }

  console.log(chalk.cyan(`\n--- LLM ${isDesign ? 'Design' : 'Code'} Review: ${parsed.slug} ---`));
  console.log(chalk.dim(`Provider: ${provider}\n`));

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const stream = await chatStream(provider, messages);
  let fullResponse = '';

  for await (const chunk of stream) {
    process.stdout.write(chunk);
    fullResponse += chunk;
  }
  console.log('\n');

  // Save feedback to scorecard
  const scorecard = readScorecard(question.category, parsed.slug);
  if (scorecard) {
    scorecard.llmFeedback = fullResponse;

    // Try to extract a numeric score from the response
    const scoreMatch = fullResponse.match(/Overall.*?(\d+(?:\.\d+)?)\s*\/\s*5/i);
    if (scoreMatch && scorecard.attempts.length > 0) {
      const lastAttempt = scorecard.attempts[scorecard.attempts.length - 1];
      lastAttempt.llmScore = parseFloat(scoreMatch[1]);
    }

    writeScorecard(question.category, parsed.slug, scorecard);
    console.log(chalk.dim('Feedback saved to scorecard.'));
  }
}
