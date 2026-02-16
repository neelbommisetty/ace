import fs from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { findQuestion, readScorecard, resetScorecard, startNewAttempt, writeScorecard } from '../lib/scorecard.js';
import { CATEGORIES, isDesignCategory } from '../lib/categories.js';
import { getStubContent } from '../lib/scaffold.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

export async function run(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const slug = args.find((a) => !a.startsWith('--'));

  if (!slug) {
    console.error(chalk.red('Missing question slug.'));
    console.error(chalk.dim('Usage: npm run ace reset <slug>'));
    return;
  }

  const question = findQuestion(slug);
  if (!question) {
    console.error(chalk.red(`Question not found: ${slug}`));
    return;
  }

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: `Reset "${slug}" to unanswered? This will clear your solution.`,
    initial: false,
  });

  if (!confirm) {
    console.log(chalk.yellow('Cancelled.'));
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
      if (file === 'index.html') continue; // Don't reset HTML scaffold
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

  console.log(chalk.green(`\nReset: questions/${question.category}/${slug}/`));
  console.log(chalk.dim('Solution files restored to stubs. Scorecard updated.'));
}
