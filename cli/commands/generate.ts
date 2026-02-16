import fs from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { CATEGORIES, CATEGORY_SLUGS, slugify } from '../lib/categories.js';
import type { CategorySlug, Difficulty } from '../lib/categories.js';
import { chat, chatStream, requireProvider } from '../lib/llm.js';
import type { LLMMessage, LLMProvider } from '../lib/llm.js';
import { scaffoldQuestion } from '../lib/scaffold.js';
import { resolveWorkspaceRoot, isWorkspaceInitialized } from '../lib/paths.js';

const PROMPTS_DIR = path.resolve(import.meta.dirname, '../prompts');

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

function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');
}

interface GeneratedQuestion {
  title: string;
  slug: string;
  description: string;
  signature?: string;
  testCode?: string;
  solutionCode?: string;
}

function extractJSON(text: string): string {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Try to find raw JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

async function directMode(
  provider: LLMProvider,
  topic: string,
  category: CategorySlug,
  difficulty: Difficulty,
): Promise<void> {
  const systemPrompt = loadPrompt('question-generate.md');
  const categoryConfig = CATEGORIES[category];

  console.log(chalk.cyan(`\nGenerating ${categoryConfig.name} question: "${topic}" (${difficulty})...`));

  const userMessage = `Generate a ${difficulty} difficulty ${categoryConfig.name} interview question about: ${topic}

Category slug: ${category}
Question type: ${categoryConfig.type}`;

  const response = await chat(provider, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ], true);

  let parsed: GeneratedQuestion;
  try {
    parsed = JSON.parse(extractJSON(response));
  } catch {
    console.error(chalk.red('Failed to parse LLM response as JSON. Raw response:'));
    console.error(response);
    return;
  }

  const slug = parsed.slug || slugify(parsed.title || topic);

  // Never pass solutionCode from LLM — it may contain a full implementation.
  // Templates will build a proper stub from the signature instead.
  if (parsed.solutionCode) {
    console.log(chalk.dim('Note: Discarded LLM solutionCode; using signature-based stub.'));
  }

  const questionDir = scaffoldQuestion({
    title: parsed.title || topic,
    slug,
    category,
    difficulty,
    description: parsed.description || '',
    signature: parsed.signature,
    testCode: parsed.testCode,
  });

  console.log(chalk.green(`\nCreated: questions/${category}/${slug}/`));
  console.log(chalk.dim(`  ${questionDir}`));
}

async function brainstormMode(provider: LLMProvider): Promise<void> {
  const systemPrompt = loadPrompt('question-brainstorm.md');
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

    const stream = await chatStream(provider, messages);
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
    choices: CATEGORY_SLUGS.map((s) => ({ title: CATEGORIES[s].name, value: s })),
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

  // Use the generate prompt to create structured output
  const generatePrompt = loadPrompt('question-generate.md');
  const brainstormSummary = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');

  const categoryConfig = CATEGORIES[category as CategorySlug];

  const response = await chat(
    provider,
    [
      { role: 'system', content: generatePrompt },
      {
        role: 'user',
        content: `Based on the following brainstorm conversation, generate a structured ${difficulty} ${categoryConfig.name} interview question.

Category slug: ${category}
Question type: ${categoryConfig.type}

Brainstorm conversation:
${brainstormSummary}`,
      },
    ],
    true,
  );

  let parsed: GeneratedQuestion;
  try {
    parsed = JSON.parse(extractJSON(response));
  } catch {
    console.error(chalk.red('Failed to parse LLM response. Raw:'));
    console.error(response);
    return;
  }

  const slug = parsed.slug || slugify(parsed.title || 'brainstorm-question');

  // Never pass solutionCode from LLM — it may contain a full implementation.
  if (parsed.solutionCode) {
    console.log(chalk.dim('Note: Discarded LLM solutionCode; using signature-based stub.'));
  }

  const questionDir = scaffoldQuestion({
    title: parsed.title,
    slug,
    category: category as CategorySlug,
    difficulty: difficulty as Difficulty,
    description: parsed.description || '',
    signature: parsed.signature,
    testCode: parsed.testCode,
  });

  console.log(chalk.green(`\nCreated: questions/${category}/${slug}/`));
  console.log(chalk.dim(`  ${questionDir}`));
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

  // Direct mode
  if (!parsed.topic) {
    console.error(chalk.red('Missing --topic. Use --brainstorm for interactive mode.'));
    console.error(chalk.dim('Example: npm run ace generate -- --topic "debounce" --category js-ts --difficulty medium'));
    return;
  }

  let category = parsed.category as CategorySlug | undefined;
  let difficulty = parsed.difficulty as Difficulty | undefined;

  if (!category) {
    const result = await prompts({
      type: 'select',
      name: 'category',
      message: 'Which category?',
      choices: CATEGORY_SLUGS.map((s) => ({ title: CATEGORIES[s].name, value: s })),
    });
    category = result.category;
  }

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

  if (!category || !difficulty) return;

  await directMode(provider, parsed.topic, category, difficulty);
}
