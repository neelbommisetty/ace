import prompts from 'prompts';
import chalk from 'chalk';
import { NoObjectGeneratedError } from 'ai';
import { CATEGORIES, CATEGORY_SLUGS, slugify } from '../lib/categories.js';
import type { CategorySlug, Difficulty } from '../lib/categories.js';
import {
  generateVerifiedQuestion,
  GenerationVerifyError,
  type GeneratedQuestion,
  type GenerationPhase,
} from '../lib/gen-pipeline.js';
import { chatStream, requireProvider } from '../lib/llm.js';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import { buildBrainstormPrompt } from '../lib/prompt-builder.js';
import { formatReferenceSolutionMd, scaffoldQuestion } from '../lib/scaffold.js';
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

function printPhase(phase: GenerationPhase, attempt: number): void {
  const labels: Record<GenerationPhase, string> = {
    generating: 'Writing question…',
    auditing: 'Auditing edge cases…',
    verifying: 'Running the generated tests…',
    repairing: `Fixing tests (attempt ${attempt}/3)…`,
  };
  console.log(chalk.dim(labels[phase]));
}

/**
 * Runs the shared verified pipeline and scaffolds the result. Returns true
 * when a question dir was created; false when generation/verification failed
 * (nothing is scaffolded on a verify failure — unverified tests never ship).
 */
async function generateAndScaffold(
  provider: LLMProvider,
  userMessage: string,
  category: CategorySlug,
  difficulty: Difficulty,
  fallbackTitle: string,
): Promise<boolean> {
  let parsed: GeneratedQuestion;
  try {
    ({ question: parsed } = await generateVerifiedQuestion(
      { provider, category, difficulty, userMessage, workspaceRoot: resolveWorkspaceRoot() },
      { onProgress: printPhase },
    ));
  } catch (err) {
    if (err instanceof GenerationVerifyError) {
      console.error(
        chalk.red('\nGenerated tests failed verification after 3 attempts — nothing scaffolded.'),
      );
      console.error(chalk.dim(err.failureReport));
      return false;
    }
    console.error(chalk.red('Failed to generate question. Raw response:'));
    console.error(NoObjectGeneratedError.isInstance(err) ? err.text : err);
    return false;
  }

  const slug = parsed.slug || slugify(parsed.title || fallbackTitle);

  // Never pass solutionCode from LLM — it may contain a full implementation.
  // Templates will build a proper stub from the signature instead. (The
  // verified referenceSolution goes only to the hidden .reference.md.)
  if (parsed.solutionCode) {
    console.log(chalk.dim('Note: Discarded LLM solutionCode; using signature-based stub.'));
  }

  const questionDir = scaffoldQuestion({
    title: parsed.title || fallbackTitle,
    slug,
    category,
    difficulty,
    description: parsed.description || '',
    signature: parsed.signature ?? undefined,
    testCode: parsed.testCode ?? undefined,
    interviewerPacket: parsed.interviewerPacket ?? undefined,
    referenceSolutionMd: parsed.referenceSolution
      ? formatReferenceSolutionMd(parsed.referenceSolution)
      : undefined,
  });

  console.log(chalk.green(`\nCreated: questions/${category}/${slug}/`));
  console.log(chalk.dim(`  ${questionDir}`));
  return true;
}

async function directMode(
  provider: LLMProvider,
  topic: string,
  category: CategorySlug,
  difficulty: Difficulty,
): Promise<void> {
  const categoryConfig = CATEGORIES[category];

  console.log(chalk.cyan(`\nGenerating ${categoryConfig.name} question: "${topic}" (${difficulty})...`));

  const userMessage = `Generate a ${difficulty} difficulty ${categoryConfig.name} interview question about: ${topic}

Category slug: ${category}
Question type: ${categoryConfig.type}`;

  await generateAndScaffold(provider, userMessage, category, difficulty, topic);
}

async function brainstormMode(provider: LLMProvider): Promise<void> {
  const systemPrompt = buildBrainstormPrompt();
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  console.log(chalk.cyan('\n--- Brainstorm Mode ---'));
  console.log(chalk.dim('Chat with the LLM to design a question. Type "done" when ready to scaffold.\n'));

  // First, ask what area they want to practice
  const { area } = await prompts({
    type: 'text',
    name: 'area',
    message: 'What area do you want to practice?',
  });

  if (!area) return;

  messages.push({
    role: 'user',
    content: `I want to practice: ${area}. Suggest some question directions across relevant categories.`,
  });

  // Start conversation loop
  while (true) {
    console.log(chalk.dim('\nThinking...\n'));

    const stream = await chatStream(provider, messages, { purpose: 'brainstorm' });
    let fullResponse = '';

    for await (const chunk of stream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }
    console.log('\n');

    messages.push({ role: 'assistant', content: fullResponse });

    const { userInput } = await prompts({
      type: 'text',
      name: 'userInput',
      message: chalk.dim('Your response (or "done" to scaffold, "quit" to exit):'),
    });

    if (!userInput || userInput.toLowerCase() === 'quit' || userInput.toLowerCase() === 'q') {
      console.log(chalk.yellow('Exiting brainstorm.'));
      return;
    }

    if (userInput.toLowerCase() === 'done' || userInput.toLowerCase() === 'y') {
      break;
    }

    messages.push({ role: 'user', content: userInput });
  }

  // Now generate the structured question from the brainstorm
  console.log(chalk.cyan('\nNow let me finalize the question...'));

  // Ask for category and difficulty
  const { category } = await prompts({
    type: 'select',
    name: 'category',
    message: 'Which category?',
    choices: CATEGORY_SLUGS.map((s) => ({ 
      title: CATEGORIES[s].name, 
      description: CATEGORIES[s].hint,
      value: s 
    })),
  });

  const { difficulty } = await prompts({
    type: 'select',
    name: 'difficulty',
    message: 'Difficulty?',
    choices: [
      { title: 'Easy', value: 'easy' },
      { title: 'Medium', value: 'medium' },
      { title: 'Hard', value: 'hard' },
    ],
  });

  if (!category || !difficulty) return;

  // Finalize through the shared verified pipeline
  const categoryConfig = CATEGORIES[category as CategorySlug];
  const brainstormSummary = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');

  const userMessage = `Based on the following brainstorm conversation, generate a structured ${difficulty} ${categoryConfig.name} interview question.

Category slug: ${category}
Question type: ${categoryConfig.type}

Brainstorm conversation:
${brainstormSummary}`;

  await generateAndScaffold(
    provider,
    userMessage,
    category as CategorySlug,
    difficulty as Difficulty,
    'brainstorm-question',
  );
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  
  // Auto-initialize workspace if needed
  const root = resolveWorkspaceRoot();
  if (!isWorkspaceInitialized(root)) {
    console.log(chalk.yellow('\nWorkspace not initialized. Running init...\n'));
    const initModule = await import('./init.js');
    await initModule.run([]);
    console.log();
  }
  
  const provider = requireProvider(parsed.provider);

  console.log(chalk.dim(`Using LLM provider: ${provider}`));

  if (parsed.brainstorm === 'true') {
    await brainstormMode(provider);
    return;
  }

  // Direct mode - prompt for category, difficulty, then topic
  let category = parsed.category as CategorySlug | undefined;
  let difficulty = parsed.difficulty as Difficulty | undefined;
  let topic = parsed.topic;

  if (!category) {
    const result = await prompts({
      type: 'select',
      name: 'category',
      message: 'Which category?',
      choices: CATEGORY_SLUGS.map((s) => ({ 
        title: CATEGORIES[s].name, 
        description: CATEGORIES[s].hint,
        value: s 
      })),
    });
    category = result.category;
  }

  if (!category) return;

  if (!difficulty) {
    const result = await prompts({
      type: 'select',
      name: 'difficulty',
      message: 'Difficulty?',
      choices: [
        { title: 'Easy', value: 'easy' },
        { title: 'Medium', value: 'medium' },
        { title: 'Hard', value: 'hard' },
      ],
    });
    difficulty = result.difficulty;
  }

  if (!difficulty) return;

  if (!topic) {
    const result = await prompts({
      type: 'text',
      name: 'topic',
      message: 'What topic do you want to practice?',
    });
    topic = result.topic;
  }

  if (!topic) return;

  await directMode(provider, topic, category, difficulty);
}
