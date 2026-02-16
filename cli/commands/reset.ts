import fs from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { findQuestion, readScorecard, resetScorecard, startNewAttempt, writeScorecard, getAllQuestions, promptForSlug } from '../lib/scorecard.js';
import { CATEGORIES, isDesignCategory } from '../lib/categories.js';
import { getStubContent } from '../lib/scaffold.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

function resetQuestion(slug: string): void {
  const question = findQuestion(slug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${slug}`));
    return;
  }

  const config = CATEGORIES[question.category];
  const isDesign = isDesignCategory(question.category);

  if (isDesign) {
    // Reset notes.md to template
    const notesPath = path.join(question.dir, 'notes.md');
    const stubContent = getStubContent(question.category, 'notes.md');
    if (stubContent) {
      fs.writeFileSync(notesPath, stubContent);
    }
  } else {
    // Reset solution files to stubs
    for (const file of config.solutionFiles) {
      const filePath = path.join(question.dir, file);
      const stubContent = getStubContent(question.category, file);
      if (stubContent) {
        fs.writeFileSync(filePath, stubContent);
      }
    }
  }

  // Update scorecard
  const scorecard = readScorecard(question.category, slug);
  if (scorecard) {
    resetScorecard(scorecard);
    startNewAttempt(scorecard);
    scorecard.status = 'untouched'; // Override in-progress from startNewAttempt
    writeScorecard(question.category, slug, scorecard);
  }

  console.log(chalk.green(`Reset: questions/${question.category}/${slug}/`));
}

export async function run(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const hasAll = args.includes('--all') || args.includes('all');
  const slug = args.find((a) => !a.startsWith('--') && a !== 'all');

  // Handle --all flag: reset all questions with confirmation
  if (hasAll) {
    const questions = getAllQuestions();
    if (questions.length === 0) {
      console.log(chalk.yellow('No questions found. Create one first with `ace generate` or `ace add`.'));
      return;
    }

    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: `Reset ALL ${questions.length} question(s) to unanswered? This will clear all solutions.`,
      initial: false,
    });

    if (!confirm) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }

    console.log(chalk.cyan(`\nResetting ${questions.length} question(s)...\n`));

    for (const q of questions) {
      resetQuestion(q.slug);
    }

    console.log(chalk.green('\nCompleted reset for all questions.'));
    console.log(chalk.dim('Solution files restored to stubs. Scorecards updated.'));
    return;
  }

  // If no slug provided, show interactive picker
  let selectedSlug = slug;
  if (!selectedSlug) {
    selectedSlug = await promptForSlug();
    if (!selectedSlug) return;
  }

  const question = findQuestion(selectedSlug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${selectedSlug}`));
    return;
  }

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: `Reset "${selectedSlug}" to unanswered? This will clear your solution.`,
    initial: false,
  });

  if (!confirm) {
    console.log(chalk.yellow('Cancelled.'));
    return;
  }

  resetQuestion(selectedSlug);
  console.log(chalk.dim('Solution files restored to stubs. Scorecard updated.'));
}
