import prompts from 'prompts';
import chalk from 'chalk';
import { saveGlobalAceConfig, maskApiKey, loadAceConfig } from '../lib/config.js';
import { validateOpenAIKey, validateAnthropicKey } from '../lib/llm.js';

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

function printStatusLine(label: string, status: boolean | null, detail: string): void {
  const icon = status === true ? chalk.green('✓') : status === false ? chalk.red('✗') : chalk.yellow('–');
  const paddedLabel = label.padEnd(18);
  console.log(`  ${icon}  ${paddedLabel} ${chalk.dim(detail)}`);
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

  // Validate keys
  console.log(chalk.cyan('\n--- Validating API Keys ---\n'));

  const final = loadAceConfig();

  let openaiValid: boolean | null = null;
  let openaiError: string | undefined;
  if (final.OPENAI_API_KEY) {
    console.log(chalk.dim('Validating OpenAI key...'));
    const result = await validateOpenAIKey(final.OPENAI_API_KEY);
    openaiValid = result.valid;
    openaiError = result.error;
  }

  let anthropicValid: boolean | null = null;
  let anthropicError: string | undefined;
  if (final.ANTHROPIC_API_KEY) {
    console.log(chalk.dim('Validating Anthropic key...'));
    const result = await validateAnthropicKey(final.ANTHROPIC_API_KEY);
    anthropicValid = result.valid;
    anthropicError = result.error;
  }

  // Select default provider if both are valid
  if (openaiValid && anthropicValid) {
    let defaultProvider = parsed['default-provider'];
    
    if (!defaultProvider) {
      const currentDefault = final.default_provider || 'openai';
      const { selected } = await prompts({
        type: 'select',
        name: 'selected',
        message: 'Default LLM provider:',
        choices: [
          { title: 'OpenAI', value: 'openai' },
          { title: 'Anthropic', value: 'anthropic' },
        ],
        initial: currentDefault === 'anthropic' ? 1 : 0,
      });
      defaultProvider = selected;
    }
    
    if (defaultProvider === 'openai' || defaultProvider === 'anthropic') {
      saveGlobalAceConfig({ default_provider: defaultProvider });
    }
  } else if (openaiValid) {
    // Only OpenAI is valid, set as default
    saveGlobalAceConfig({ default_provider: 'openai' });
  } else if (anthropicValid) {
    // Only Anthropic is valid, set as default
    saveGlobalAceConfig({ default_provider: 'anthropic' });
  }

  // Reload config to get the updated default_provider
  const updated = loadAceConfig();

  // Display status dashboard
  console.log(chalk.cyan('\n╭─────────────────────────────────────────╮'));
  console.log(chalk.cyan('│') + chalk.bold('  ace status') + '                            ' + chalk.cyan('│'));
  console.log(chalk.cyan('├─────────────────────────────────────────┤'));

  if (updated.OPENAI_API_KEY) {
    const detail = openaiValid ? maskApiKey(updated.OPENAI_API_KEY) : openaiError || 'validation failed';
    printStatusLine('OpenAI key', openaiValid, detail);
  } else {
    printStatusLine('OpenAI key', null, 'not configured');
  }

  if (updated.ANTHROPIC_API_KEY) {
    const detail = anthropicValid ? maskApiKey(updated.ANTHROPIC_API_KEY) : anthropicError || 'validation failed';
    printStatusLine('Anthropic key', anthropicValid, detail);
  } else {
    printStatusLine('Anthropic key', null, 'not configured');
  }

  console.log(chalk.cyan('├─────────────────────────────────────────┤'));

  const ready = (openaiValid === true || anthropicValid === true);
  printStatusLine('Ready', ready, ready ? 'at least one provider configured' : 'no valid API keys');

  if (updated.default_provider) {
    const providerName = updated.default_provider === 'openai' ? 'OpenAI' : 'Anthropic';
    printStatusLine('Default provider', true, providerName.toLowerCase());
  }

  console.log(chalk.cyan('╰─────────────────────────────────────────╯\n'));

  if (!ready && (openaiValid === false || anthropicValid === false)) {
    console.log(chalk.yellow('No valid API keys configured. You need at least one to use LLM features.\n'));
    console.log(chalk.dim('Generate an API key from either provider:\n'));
    console.log(chalk.cyan('  OpenAI    ') + chalk.dim(' https://platform.openai.com/api-keys'));
    console.log(chalk.cyan('  Anthropic ') + chalk.dim(' https://console.anthropic.com/settings/keys'));
    console.log(chalk.dim('\nThen run ') + chalk.cyan('ace setup') + chalk.dim(' again to configure your key.\n'));
  }
}
