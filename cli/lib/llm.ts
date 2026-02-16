import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { loadAceConfig, type AceConfig } from './config.js';

export type LLMProvider = 'openai' | 'anthropic';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Load config once at module level
let cachedConfig: AceConfig | null = null;

function getConfig(): AceConfig {
  if (!cachedConfig) {
    cachedConfig = loadAceConfig();
  }
  return cachedConfig;
}

function getAvailableProviders(): LLMProvider[] {
  const config = getConfig();
  const providers: LLMProvider[] = [];
  if (config.OPENAI_API_KEY) providers.push('openai');
  if (config.ANTHROPIC_API_KEY) providers.push('anthropic');
  return providers;
}

export function getDefaultProvider(): LLMProvider | null {
  const providers = getAvailableProviders();
  if (providers.length === 0) return null;
  return providers[0];
}

export function requireProvider(preferred?: string): LLMProvider {
  const config = getConfig();
  
  if (preferred === 'openai' || preferred === 'anthropic') {
    const key = preferred === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!config[key]) {
      console.error(chalk.red(`Error: ${key} is not configured.`));
      console.error(chalk.dim('Run `ace setup` to configure API keys.'));
      process.exit(1);
    }
    return preferred;
  }

  const provider = getDefaultProvider();
  if (!provider) {
    console.error(chalk.red('Error: No LLM API key found.'));
    console.error(chalk.dim('Run `ace setup` to configure API keys.'));
    process.exit(1);
  }
  return provider;
}

async function callOpenAI(messages: LLMMessage[], jsonMode = false): Promise<string> {
  const config = getConfig();
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0.7,
    max_tokens: 4096,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  return response.choices[0]?.message?.content ?? '';
}

async function callAnthropic(messages: LLMMessage[], _jsonMode = false): Promise<string> {
  const config = getConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: nonSystemMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });

  const block = response.content[0];
  if (block.type === 'text') return block.text;
  return '';
}

export async function chat(
  provider: LLMProvider,
  messages: LLMMessage[],
  jsonMode = false,
): Promise<string> {
  if (provider === 'openai') {
    return callOpenAI(messages, jsonMode);
  }
  return callAnthropic(messages, jsonMode);
}

async function streamOpenAI(messages: LLMMessage[]): Promise<AsyncIterable<string>> {
  const config = getConfig();
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const stream = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: 0.7,
    max_tokens: 4096,
    stream: true,
  });

  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}

async function streamAnthropic(messages: LLMMessage[]): Promise<AsyncIterable<string>> {
  const config = getConfig();
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: nonSystemMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if ('text' in delta) yield delta.text;
        }
      }
    },
  };
}

export async function chatStream(
  provider: LLMProvider,
  messages: LLMMessage[],
): Promise<AsyncIterable<string>> {
  if (provider === 'openai') {
    return streamOpenAI(messages);
  }
  return streamAnthropic(messages);
}
