import prompts from 'prompts';
import chalk from 'chalk';
import { CATEGORIES, CATEGORY_SLUGS, slugify } from '../lib/categories.js';
import type { CategorySlug, Difficulty } from '../lib/categories.js';
import { scaffoldQuestion } from '../lib/scaffold.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

export async function run(_args: string[]): Promise<void> {
  // Auto-initialize workspace if needed
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.log(chalk.yellow('\nWorkspace not initialized. Running init...\n'));
    const initModule = await import('./init.js');
    await initModule.run([]);
    console.log();
  }

  console.log(chalk.cyan('\n--- Add a Question Manually ---\n'));

  const { category } = await prompts({
    type: 'select',
    name: 'category',
    message: 'Category:',
    choices: CATEGORY_SLUGS.map((s) => ({ title: CATEGORIES[s].name, value: s })),
  });
  if (!category) return;

  const { difficulty } = await prompts({
    type: 'select',
    name: 'difficulty',
    message: 'Difficulty:',
    choices: [
      { title: 'Easy', value: 'easy' },
      { title: 'Medium', value: 'medium' },
      { title: 'Hard', value: 'hard' },
    ],
  });
  if (!difficulty) return;

  const { title } = await prompts({
    type: 'text',
    name: 'title',
    message: 'Question title:',
    validate: (v: string) => (v.length > 0 ? true : 'Title is required'),
  });
  if (!title) return;

  const slug = slugify(title);

  const { description } = await prompts({
    type: 'text',
    name: 'description',
    message: 'Problem description (paste markdown, press Enter when done):',
  });

  const config = CATEGORIES[category as CategorySlug];
  let signature: string | undefined;
  let testCode: string | undefined;
  let solutionCode: string | undefined;

  if (config.type === 'coding') {
    const sigResult = await prompts({
      type: 'text',
      name: 'signature',
      message: 'Function/component signature (optional):',
    });
    signature = sigResult.signature || undefined;

    const testResult = await prompts({
      type: 'text',
      name: 'testCode',
      message: 'Paste test code (optional, press Enter to skip):',
    });
    testCode = testResult.testCode || undefined;

    const solResult = await prompts({
      type: 'text',
      name: 'solutionCode',
      message: 'Paste starter/solution code (optional, press Enter to skip):',
    });
    solutionCode = solResult.solutionCode || undefined;
  }

  try {
    const questionDir = scaffoldQuestion({
      title,
      slug,
      category: category as CategorySlug,
      difficulty: difficulty as Difficulty,
      description: description || '',
      signature,
      testCode,
      solutionCode,
    });

    console.log(chalk.green(`\nCreated: questions/${category}/${slug}/`));
    console.log(chalk.dim(`  ${questionDir}`));
  } catch (err) {
    if (err instanceof Error) {
      console.error(chalk.red(err.message));
    }
  }
}
