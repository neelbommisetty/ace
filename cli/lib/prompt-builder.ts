import fs from 'node:fs';
import path from 'node:path';
import { CATEGORY_SLUGS, getCategoryConfig, type CategorySlug, type QuestionType } from './categories.js';
import { getImportMetaDirname } from './import-meta.js';

const PROMPTS_DIR = path.resolve(getImportMetaDirname(import.meta), '../prompts');

/** Features whose system prompt is assembled per-category from a skeleton + capsule. */
export type PromptFeature = 'generate' | 'edge-audit' | 'review';

/**
 * The capsule heading that fills the `{{example}}` slot, per question type —
 * a Record so widening QuestionType forces a new entry here at compile time
 * instead of silently falling through a design/coding ternary.
 */
const EXAMPLE_SECTION: Record<QuestionType, string> = {
  coding: 'Example Test File',
  design: 'Example Evaluation Criteria',
  behavioral: 'Example Strong vs Weak Answer',
};

const SLOT_RE = /\{\{([a-z-]+)\}\}/g;

function readPromptFile(relPath: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, relPath), 'utf8');
}

/** One `## `-delimited slice of a markdown document (fence-aware scan). */
export interface MarkdownSection {
  /** Trimmed heading text; null for the slice before the first heading. */
  heading: string | null;
  /** The verbatim `## …` line; null for the pre-heading slice. */
  headingLine: string | null;
  /** Verbatim body lines — no trimming, no joining. */
  body: string[];
}

/**
 * Splits markdown into `## `-delimited slices. Heading detection is
 * fence-aware: a `## ` line inside a ``` code block is content (capsules and
 * generated prompts embed markdown/code examples), not a section boundary.
 * Lossless: re-joining every slice's headingLine + body with '\n'
 * reproduces the input exactly — spoilers.ts's maskPromptText depends on
 * that to withhold sections without disturbing the rest.
 */
export function splitMarkdownSections(raw: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection = { heading: null, headingLine: null, body: [] };
  let inFence = false;

  for (const line of raw.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^## (.+)$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1].trim(), headingLine: line, body: [] };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Splits a capsule into its `## `-delimited sections (name → body) via the
 * fence-aware scan above; content before the first heading is dropped.
 */
export function parseCapsuleSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const { heading, body } of splitMarkdownSections(raw)) {
    if (heading !== null) sections.set(heading, body.join('\n').trim());
  }
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
    example: () => section(EXAMPLE_SECTION[config.type]),
    'edge-case-classes': () => section('Edge-Case Classes'),
    'review-dimensions': () => section('Review Dimensions'),
    signals: () => section('Signals'),
  });
}

/**
 * Renders a question's own markdown — a generated `description` or a
 * README.md read from disk — as the `## Question` section of a prompt user
 * message. Shared by every prompt that embeds a question (edge-audit,
 * review, dispute, feedback); six hand-rolled copies is how the old wrapper
 * drifted (NEE-275).
 *
 * `## Question` is a deliberately non-claiming delimiter: generated
 * descriptions already open with their own `## Problem Statement` and carry
 * sibling `##` sections (Signature/Examples/… or Requirements/Scope/…), so
 * the old `## Problem Statement` wrapper doubled that heading and falsely
 * labeled every sibling section as part of the problem statement. Under
 * `## Question` the content's own sections keep their level — and a
 * manual/pre-overhaul README with no section structure reads just as well.
 */
export function buildQuestionSection(questionMd: string): string {
  return `## Question\n\n${questionMd.trim()}`;
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
