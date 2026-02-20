import chalk from 'chalk';
import { findQuestion, readScorecard, getAllQuestions, promptForSlug } from '../lib/scorecard.js';
import { CATEGORIES } from '../lib/categories.js';
import type { Scorecard, CategorySlug } from '../lib/categories.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

function displayScorecard(slug: string, category: CategorySlug, scorecard: Scorecard): void {
  const config = CATEGORIES[category];

  console.log(`\n${chalk.bold.cyan('Scorecard:')} ${chalk.bold(scorecard.title || slug)}`);
  console.log(chalk.dim('─'.repeat(60)));
  console.log(`  ${chalk.bold('Category:')}     ${config?.name || category}`);
  console.log(`  ${chalk.bold('Difficulty:')}   ${scorecard.difficulty}`);
  console.log(`  ${chalk.bold('Suggested:')}    ~${scorecard.suggestedTime} minutes`);

  const statusColors: Record<string, (s: string) => string> = {
    untouched: chalk.gray,
    'in-progress': chalk.yellow,
    attempted: chalk.red,
    solved: chalk.green,
  };
  const statusColor = statusColors[scorecard.status] || chalk.white;
  console.log(`  ${chalk.bold('Status:')}       ${statusColor(scorecard.status)}`);

  if (scorecard.attempts.length > 0) {
    console.log(`\n${chalk.bold('  Attempts:')}`);
    for (const attempt of scorecard.attempts) {
      const testInfo =
        attempt.testsTotal > 0
          ? `${attempt.testsPassed}/${attempt.testsTotal} tests`
          : 'no tests run';
      const scoreInfo = attempt.llmScore !== null ? ` · LLM: ${attempt.llmScore}/5` : '';
      const color = attempt.testsPassed === attempt.testsTotal && attempt.testsTotal > 0
        ? chalk.green
        : chalk.yellow;

      console.log(`    #${attempt.attempt}: ${color(testInfo)}${scoreInfo}`);
    }
  } else {
    console.log(chalk.dim('\n  No attempts yet.'));
  }

  if (scorecard.llmFeedback) {
    console.log(`\n${chalk.bold('  Last LLM Feedback:')}`);
    // Show a truncated preview
    const lines = scorecard.llmFeedback.split('\n').slice(0, 15);
    for (const line of lines) {
      console.log(`  ${chalk.dim(line)}`);
    }
    if (scorecard.llmFeedback.split('\n').length > 15) {
      console.log(chalk.dim('  ... (run `ace feedback` for full review)'));
    }
  }

  console.log(chalk.dim('\n' + '─'.repeat(60)));
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

  // Handle --all flag: show all scorecards
  if (hasAll) {
    const questions = getAllQuestions();
    if (questions.length === 0) {
      console.log(chalk.yellow('No questions found. Create one first with `ace generate`.'));
      return;
    }

    for (const q of questions) {
      displayScorecard(q.slug, q.category, q.scorecard);
    }
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

  const scorecard = readScorecard(question.category, selectedSlug);
  if (!scorecard) {
    console.error(chalk.red('No scorecard found for this question.'));
    return;
  }

  displayScorecard(selectedSlug, question.category, scorecard);
}
