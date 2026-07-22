import fs from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { findQuestion, readScorecard, writeScorecard, getAllQuestions, promptForSlug } from '../lib/scorecard.js';
import { CATEGORIES, isDesignCategory, getPromptGroup } from '../lib/categories.js';
import { chatStream, requireProvider } from '../lib/llm.js';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';
import { getImportMetaDirname } from '../lib/import-meta.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');
}

function parseArgs(args: string[]): { slug?: string; provider?: string; all: boolean } {
  let slug: string | undefined;
  let provider: string | undefined;
  let all = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider' && args[i + 1]) {
      provider = args[++i];
    } else if (arg === '--all' || arg === 'all') {
      all = true;
    } else if (!arg.startsWith('--')) {
      slug = arg;
    }
  }

  return { slug, provider, all };
}

export function hasMeaningfulDesignNotes(notes: string): boolean {
  return notes
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('<!--'));
}

async function runFeedbackForSlug(slug: string, provider: LLMProvider): Promise<void> {
  const question = findQuestion(slug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${slug}`));
    return;
  }

  const config = CATEGORIES[question.category];
  const isDesign = isDesignCategory(question.category);

  // Read question files
  const readmePath = path.join(question.dir, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';

  let systemPrompt: string;
  let userContent: string;

  if (isDesign) {
    systemPrompt = loadPrompt(`review/${getPromptGroup(question.category)}.md`);
    const notesPath = path.join(question.dir, 'notes.md');
    const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : '';

    if (!hasMeaningfulDesignNotes(notes)) {
      console.error(chalk.yellow('Notes file appears to be empty. Write your design notes first!'));
      console.error(chalk.dim(`Edit: questions/${question.category}/${slug}/notes.md`));
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
    systemPrompt = loadPrompt(`review/${getPromptGroup(question.category)}.md`);

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

  console.log(chalk.cyan(`\n--- LLM ${isDesign ? 'Design' : 'Code'} Review: ${slug} ---`));
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
  const scorecard = readScorecard(question.category, slug);
  if (scorecard) {
    scorecard.llmFeedback = fullResponse;

    // Try to extract a numeric score from the response
    const scoreMatch = fullResponse.match(/Overall.*?(\d+(?:\.\d+)?)\s*\/\s*5/i);
    if (scoreMatch && scorecard.attempts.length > 0) {
      const lastAttempt = scorecard.attempts[scorecard.attempts.length - 1];
      lastAttempt.llmScore = parseFloat(scoreMatch[1]);
    }

    writeScorecard(question.category, slug, scorecard);
    console.log(chalk.dim('Feedback saved to scorecard.'));
  }
}

export async function run(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const parsed = parseArgs(args);
  const provider = requireProvider(parsed.provider);

  // Handle --all flag: run feedback for all questions with confirmation
  if (parsed.all) {
    const questions = getAllQuestions();
    if (questions.length === 0) {
      console.log(chalk.yellow('No questions found. Create one first with `ace generate`.'));
      return;
    }

    console.log(chalk.cyan(`\nRunning feedback for ${questions.length} question(s)...\n`));

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(chalk.bold(`\n[${i + 1}/${questions.length}] ${q.slug}`));

      const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: `Run feedback for "${q.slug}"?`,
        initial: true,
      });

      if (!confirm) {
        console.log(chalk.dim('Skipped.'));
        continue;
      }

      await runFeedbackForSlug(q.slug, provider);
    }

    console.log(chalk.green('\nCompleted feedback for all questions.'));
    return;
  }

  // If no slug provided, show interactive picker
  let selectedSlug = parsed.slug;
  if (!selectedSlug) {
    selectedSlug = (await promptForSlug()) ?? undefined;
    if (!selectedSlug) return;
  }

  await runFeedbackForSlug(selectedSlug, provider);
}
