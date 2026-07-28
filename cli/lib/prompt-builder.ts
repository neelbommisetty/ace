import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORY_SLUGS,
  getCategoryConfig,
  isDesignCategory,
  type CategorySlug,
} from './categories.js';
import { getImportMetaDirname } from './import-meta.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

/** Features whose system prompt is assembled per-category from a skeleton + capsule. */
export type PromptFeature = 'generate' | 'edge-audit' | 'review';

const SLOT_RE = /\{\{([a-z-]+)\}\}/g;

function readPromptFile(relPath: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, relPath), 'utf8');
}

/**
 * Splits a capsule into its `## `-delimited sections (name → body). Heading
 * detection is fence-aware: a `## ` line inside a ``` code block is content
 * (capsules embed markdown/code examples), not a section boundary.
 */
export function parseCapsuleSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current !== null) sections.set(current, body.join('\n').trim());
  };

  for (const line of raw.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^## (.+)$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].trim();
      body = [];
    } else if (current !== null) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function requireSection(
  sections: Map<string, string>,
  name: string,
  capsuleRelPath: string,
): string {
  const body = sections.get(name);
  if (body === undefined || body.length === 0) {
    throw new Error(`missing required section "## ${name}" in cli/prompts/${capsuleRelPath}`);
  }
  return body;
}

/**
 * Replaces every `{{slot}}` in the skeleton via the resolver map. Resolvers
 * are lazy so a skeleton only *requires* the capsule sections it actually
 * references. Unknown slot names and any slot left unresolved throw — the
 * output is guaranteed slot-free or the build fails loudly.
 */
function substituteSlots(
  skeleton: string,
  skeletonRelPath: string,
  resolvers: Record<string, () => string>,
): string {
  const out = skeleton.replace(SLOT_RE, (_match, name: string) => {
    const resolve = resolvers[name];
    if (!resolve) {
      throw new Error(`unknown slot {{${name}}} in cli/prompts/${skeletonRelPath}`);
    }
    return resolve();
  });
  const leftover = /\{\{.+?\}\}/.exec(out);
  if (leftover) {
    throw new Error(
      `unresolved slot ${leftover[0]} in assembled prompt from cli/prompts/${skeletonRelPath}`,
    );
  }
  return out;
}

/**
 * Assembles the system prompt for a feature × category pair: the interviewer
 * charter (always first), the feature skeleton, and the category capsule's
 * sections spliced into the skeleton's {{slots}}. Reads from disk on every
 * call — prompt files are small and reads are cheap.
 */
export function buildSystemPrompt(feature: PromptFeature, category: CategorySlug): string {
  const config = getCategoryConfig(category);
  const design = isDesignCategory(category);
  const capsuleRelPath = `categories/${category}.md`;
  const sections = parseCapsuleSections(readPromptFile(capsuleRelPath));
  const section = (name: string) => requireSection(sections, name, capsuleRelPath);

  return substituteSlots(readPromptFile(`features/${feature}.md`), `features/${feature}.md`, {
    charter: () => readPromptFile('charter.md').trim(),
    'category-name': () => config.name,
    'category-slug': () => category,
    'question-type': () => config.type,
    identity: () => section('Identity'),
    'difficulty-calibration': () => section('Difficulty Calibration'),
    environment: () => section('Environment & Test Contract'),
    example: () => section(design ? 'Example Evaluation Criteria' : 'Example Test File'),
    'edge-case-classes': () => section('Edge-Case Classes'),
    'review-dimensions': () => section('Review Dimensions'),
    signals: () => section('Signals'),
  });
}

/**
 * Assembles the brainstorm system prompt: charter + brainstorm skeleton + a
 * digest (Identity, Difficulty Calibration, Example Directions) of all 8
 * category capsules, since brainstorm conversations span categories.
 */
export function buildBrainstormPrompt(): string {
  const digest = CATEGORY_SLUGS.map((slug) => {
    const config = getCategoryConfig(slug);
    const capsuleRelPath = `categories/${slug}.md`;
    const sections = parseCapsuleSections(readPromptFile(capsuleRelPath));
    const section = (name: string) => requireSection(sections, name, capsuleRelPath);
    return [
      `### ${config.name} (\`${slug}\`)`,
      section('Identity'),
      `#### Difficulty Calibration`,
      section('Difficulty Calibration'),
      `#### Example Directions`,
      section('Example Directions'),
    ].join('\n\n');
  }).join('\n\n');

  return substituteSlots(readPromptFile('features/brainstorm.md'), 'features/brainstorm.md', {
    charter: () => readPromptFile('charter.md').trim(),
    'category-digest': () => digest,
  });
}
