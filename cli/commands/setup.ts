import prompts from 'prompts';
import chalk from 'chalk';
import { saveGlobalAceConfig, maskApiKey, loadAceConfig } from '../lib/config.js';

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

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  console.log(chalk.cyan('\n--- Setup API Keys ---'));
  console.log(chalk.dim('API keys will be stored in ~/.ace/config.json\n'));

  let openaiKey: string | undefined = parsed['openai-key'];
  let anthropicKey: string | undefined = parsed['anthropic-key'];

  // Load existing config to show current state
  const existing = loadAceConfig();

  // Interactive prompts if not provided via flags
  if (!openaiKey && !anthropicKey) {
    const { openai } = await prompts({
      type: 'text',
      name: 'openai',
      message: 'OpenAI API Key (leave blank to skip):',
      initial: existing.OPENAI_API_KEY ? maskApiKey(existing.OPENAI_API_KEY) : '',
    });

    const { anthropic } = await prompts({
      type: 'text',
      name: 'anthropic',
      message: 'Anthropic API Key (leave blank to skip):',
      initial: existing.ANTHROPIC_API_KEY ? maskApiKey(existing.ANTHROPIC_API_KEY) : '',
    });

    openaiKey = openai;
    anthropicKey = anthropic;
  }

  // Skip masked values (user didn't change them)
  if (openaiKey && openaiKey.startsWith('...')) {
    openaiKey = undefined;
  }
  if (anthropicKey && anthropicKey.startsWith('...')) {
    anthropicKey = undefined;
  }

  // Validation: require at least one key
  const hasNewOpenAI = openaiKey && openaiKey.trim().length > 0;
  const hasNewAnthropic = anthropicKey && anthropicKey.trim().length > 0;
  const hasExistingOpenAI = existing.OPENAI_API_KEY && !hasNewOpenAI;
  const hasExistingAnthropic = existing.ANTHROPIC_API_KEY && !hasNewAnthropic;

  if (!hasNewOpenAI && !hasNewAnthropic && !hasExistingOpenAI && !hasExistingAnthropic) {
    console.error(chalk.red('\nError: At least one API key is required.'));
    console.error(chalk.dim('Provide --openai-key or --anthropic-key, or enter keys when prompted.'));
    process.exit(1);
  }

  // Save config
  const toSave: Record<string, string> = {};
  if (hasNewOpenAI) {
    toSave.OPENAI_API_KEY = openaiKey!.trim();
  }
  if (hasNewAnthropic) {
    toSave.ANTHROPIC_API_KEY = anthropicKey!.trim();
  }

  if (Object.keys(toSave).length > 0) {
    saveGlobalAceConfig(toSave);
    console.log(chalk.green('\n✓ API keys saved to ~/.ace/config.json'));
  } else {
    console.log(chalk.yellow('\nNo new keys provided. Existing configuration unchanged.'));
  }

  // Show summary
  const final = loadAceConfig();
  console.log(chalk.dim('\nConfigured providers:'));
  if (final.OPENAI_API_KEY) {
    console.log(chalk.dim(`  • OpenAI: ${maskApiKey(final.OPENAI_API_KEY)}`));
  }
  if (final.ANTHROPIC_API_KEY) {
    console.log(chalk.dim(`  • Anthropic: ${maskApiKey(final.ANTHROPIC_API_KEY)}`));
  }
  console.log();
}
