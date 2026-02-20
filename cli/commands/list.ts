import chalk from 'chalk';
import Table from 'cli-table3';
import { CATEGORIES } from '../lib/categories.js';
import type { CategorySlug, Difficulty, QuestionStatus } from '../lib/categories.js';
import { getAllQuestions } from '../lib/scorecard.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

const STATUS_COLORS: Record<QuestionStatus, (s: string) => string> = {
  untouched: chalk.gray,
  'in-progress': chalk.yellow,
  attempted: chalk.red,
  solved: chalk.green,
};

const DIFFICULTY_COLORS: Record<Difficulty, (s: string) => string> = {
  easy: chalk.green,
  medium: chalk.yellow,
  hard: chalk.red,
};

export async function run(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.error(chalk.red('\nError: Workspace not initialized.'));
    console.error(chalk.dim('Run `ace init` in this folder first.\n'));
    process.exit(1);
  }

  const parsed = parseArgs(args);
  const filterCategory = parsed.category as CategorySlug | undefined;
  const filterStatus = parsed.status as QuestionStatus | undefined;
  const filterDifficulty = parsed.difficulty as Difficulty | undefined;

  let questions = getAllQuestions();

  if (filterCategory) {
    questions = questions.filter((q) => q.category === filterCategory);
  }
  if (filterStatus) {
    questions = questions.filter((q) => q.scorecard.status === filterStatus);
  }
  if (filterDifficulty) {
    questions = questions.filter((q) => q.scorecard.difficulty === filterDifficulty);
  }

  if (questions.length === 0) {
    console.log(chalk.yellow('\nNo questions found.'));
    console.log(chalk.dim('Use `ace generate` to create one.'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('Category'),
      chalk.bold('Question'),
      chalk.bold('Difficulty'),
      chalk.bold('Status'),
      chalk.bold('~Time'),
    ],
    style: { head: [], border: [] },
  });

  // Sort by category then slug
  questions.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.slug.localeCompare(b.slug);
  });

  for (const q of questions) {
    const config = CATEGORIES[q.category];
    const sc = q.scorecard;
    const diffColor = DIFFICULTY_COLORS[sc.difficulty] || chalk.white;
    const statusColor = STATUS_COLORS[sc.status] || chalk.white;

    table.push([
      config?.shortName || q.category,
      q.slug,
      diffColor(sc.difficulty),
      statusColor(sc.status),
      `~${sc.suggestedTime}m`,
    ]);
  }

  console.log(`\n${chalk.bold.cyan('ace')} — Question Dashboard\n`);
  console.log(table.toString());
  console.log(chalk.dim(`\n  ${questions.length} question(s) total`));

  // Stats
  const solved = questions.filter((q) => q.scorecard.status === 'solved').length;
  const attempted = questions.filter((q) => q.scorecard.status === 'attempted').length;
  const inProgress = questions.filter((q) => q.scorecard.status === 'in-progress').length;

  if (solved > 0 || attempted > 0 || inProgress > 0) {
    console.log(
      chalk.dim(
        `  ${chalk.green(String(solved))} solved · ${chalk.yellow(String(inProgress))} in-progress · ${chalk.red(String(attempted))} attempted`,
      ),
    );
  }

  console.log(chalk.dim('\n  Filters: --category <slug> | --status <status> | --difficulty <level>\n'));
}
