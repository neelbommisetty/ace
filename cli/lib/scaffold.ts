import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { CategorySlug, Difficulty } from './categories.js';
import { getCategoryConfig, getSuggestedTime, hasTests } from './categories.js';
import { derivePreviewFixture } from './preview-fixture.js';
import { createScorecard, writeScorecardAt } from './scorecard.js';
import { getQuestionsDir as getQuestionsDirPath } from './paths.js';
import { getImportMetaDirname } from './import-meta.js';

const TEMPLATES_DIR = path.resolve(getImportMetaDirname(import.meta), '../templates');

export interface ScaffoldOptions {
  title: string;
  slug: string;
  category: CategorySlug;
  difficulty: Difficulty;
  description: string;
  signature?: string;
  testCode?: string;
  solutionCode?: string;
  /**
   * LLM-authored read-only support module content (e.g. react-apps' fake
   * `api.ts`), written verbatim to `config.supportFiles[0]` — no `.hbs`
   * template, same convention as `testCode`. Absent writes nothing; a
   * category with an empty `config.supportFiles` never has a target to
   * write it to regardless.
   */
  supportCode?: string;
  /**
   * README-only override for the static suggestedTimes table — the LLM's
   * confirmed time estimate for coding categories, resolved by the caller
   * (generation.ts's resolveSuggestedMinutes). Falls back to
   * getSuggestedTime(category, difficulty) when absent, so every other
   * caller (starter pack, CLI scaffold) is unaffected.
   */
  suggestedMinutes?: number;
  notesTemplate?: string;
  /** Written as `.interviewer.md` — invisible to the watcher/reconciler/UI. */
  interviewerPacket?: string;
  /** Pre-formatted markdown written as `.reference.md`; never for design categories. */
  referenceSolutionMd?: string;
  /**
   * Behavioral-only (NEE-343): the competency this question probes — a
   * visible `{{competency}}` slot in README.md.hbs (renders nothing when
   * absent, so every other category's README is unaffected).
   */
  competency?: string | null;
  /**
   * Behavioral-only (NEE-343): candidate follow-up probes, written as the
   * hidden `.probes.md` bank beside `.interviewer.md` — invisible to the
   * watcher/reconciler/UI/vitest by the same dotfile convention. Absent or
   * empty writes nothing (see getProbeBankMd's format doc).
   */
  followUps?: string[] | null;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

function loadTemplate(templatePath: string): HandlebarsTemplateDelegate {
  const raw = fs.readFileSync(templatePath, 'utf-8');
  return Handlebars.compile(raw);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Scaffolds a question dir under the GIVEN workspace root, never resolving
 * the root from process.cwd() — the server is bound to workspaceRoot at
 * boot and must not depend on its own cwd. Throws if the question dir
 * already exists (caller handles suffixing). Returns the created dir and
 * the list of files written (basenames, relative to the dir).
 */
export function scaffoldQuestionAt(
  workspaceRoot: string,
  opts: ScaffoldOptions,
  extras: { writeScorecard?: boolean } = {},
): ScaffoldResult {
  const config = getCategoryConfig(opts.category);
  const questionsDir = getQuestionsDirPath(workspaceRoot);
  const questionDir = path.join(questionsDir, opts.category, opts.slug);
  const suggestedTime = opts.suggestedMinutes ?? getSuggestedTime(opts.category, opts.difficulty);
  const shouldWriteScorecard = extras.writeScorecard ?? false;
  const files: string[] = [];

  if (fs.existsSync(questionDir)) {
    throw new Error(`Question already exists: ${questionDir}`);
  }

  ensureDir(questionDir);

  const templateData = {
    title: opts.title,
    slug: opts.slug,
    category: config.name,
    categorySlug: opts.category,
    difficulty: opts.difficulty,
    suggestedTime,
    description: opts.description,
    signature: opts.signature || '',
    testCode: opts.testCode || '',
    solutionCode: opts.solutionCode || '',
    competency: opts.competency || '',
  };

  // README.md
  const readmeTemplate = loadTemplate(path.join(TEMPLATES_DIR, 'readme.md.hbs'));
  fs.writeFileSync(path.join(questionDir, 'README.md'), readmeTemplate(templateData));
  files.push('README.md');

  // Solution + test files. The generic loop covers design too: design
  // declares templateDir: 'design' + solutionFiles: ['notes.md'], and
  // cli/templates/design/notes.md.hbs is the exact file this joins —
  // there is nothing design-specific left to special-case here.
  const templateDir = path.join(TEMPLATES_DIR, config.templateDir);

  for (const solutionFile of config.solutionFiles) {
    const templateFile = solutionFile + '.hbs';
    const templatePath = path.join(templateDir, templateFile);

    if (fs.existsSync(templatePath)) {
      const tmpl = loadTemplate(templatePath);
      fs.writeFileSync(path.join(questionDir, solutionFile), tmpl(templateData));
      files.push(solutionFile);
    } else if (opts.solutionCode) {
      fs.writeFileSync(path.join(questionDir, solutionFile), opts.solutionCode);
      files.push(solutionFile);
    }
  }

  for (const testFile of config.testFiles) {
    const templateFile = testFile + '.hbs';
    const templatePath = path.join(templateDir, templateFile);

    if (fs.existsSync(templatePath)) {
      const tmpl = loadTemplate(templatePath);
      fs.writeFileSync(path.join(questionDir, testFile), tmpl(templateData));
      files.push(testFile);
    } else if (opts.testCode) {
      fs.writeFileSync(path.join(questionDir, testFile), opts.testCode);
      files.push(testFile);
    }
  }

  // Support module (e.g. react-apps' `api.ts`): LLM-authored, written
  // verbatim like testCode above — no `.hbs` template exists for it, since
  // its whole content is generated per-question. `config.supportFiles` is
  // `[]` for every category without one, so this is a silent no-op there
  // even if `opts.supportCode` were somehow set; conversely a category WITH
  // a supportFiles entry but no `opts.supportCode` (e.g. a legacy resumed
  // job) writes nothing rather than an empty file.
  if (opts.supportCode) {
    for (const supportFile of config.supportFiles) {
      fs.writeFileSync(path.join(questionDir, supportFile), opts.supportCode);
      files.push(supportFile);
    }
  }

  // Preview fixture (NEE-352): a seeded preview.tsx for component categories
  // whose bare export needs example props to render anything meaningful.
  // Handlebars-templated like every other per-question file, but deliberately
  // NOT added to config.solutionFiles/testFiles — it must never reach the
  // reviewer (buildReviewMessages reads only those two lists) and must never
  // match the workspace's `questions/**/*.test.{ts,tsx}` vitest glob (it
  // isn't a `.test.ts(x)` file, so that's true by construction). Presence of
  // the template, not the category, gates this — the same pattern
  // config.solutionFiles/testFiles already use above.
  const previewFixtureTemplate = path.join(templateDir, 'preview.tsx.hbs');
  if (fs.existsSync(previewFixtureTemplate)) {
    const fixture = derivePreviewFixture(opts.signature);
    const tmpl = loadTemplate(previewFixtureTemplate);
    fs.writeFileSync(
      path.join(questionDir, 'preview.tsx'),
      tmpl({
        ...templateData,
        previewComponentName: fixture.componentName,
        previewPropsCode: fixture.propsCode,
      }),
    );
    files.push('preview.tsx');
  }

  // Hidden interviewer artifacts (post-review debrief material). Dotfiles
  // are invisible to the watcher, reconciler, UI file list, and vitest by
  // construction — the room never shows them before a review exists.
  if (opts.interviewerPacket) {
    fs.writeFileSync(path.join(questionDir, '.interviewer.md'), opts.interviewerPacket);
    files.push('.interviewer.md');
  }
  // Behavioral-only in practice (only the behavioral capsule asks the model
  // for followUps — every other category's generated question has
  // followUps: null and nothing is written), but gated on presence, not
  // category, mirroring interviewerPacket above.
  if (opts.followUps && opts.followUps.length > 0) {
    fs.writeFileSync(path.join(questionDir, '.probes.md'), getProbeBankMd(opts.followUps));
    files.push('.probes.md');
  }
  if (opts.referenceSolutionMd && hasTests(config)) {
    fs.writeFileSync(path.join(questionDir, '.reference.md'), opts.referenceSolutionMd);
    files.push('.reference.md');
  }

  // Scorecard
  if (shouldWriteScorecard) {
    const scorecard = createScorecard(opts.title, opts.category, opts.difficulty);
    writeScorecardAt(workspaceRoot, opts.category, opts.slug, scorecard);
    files.push('scorecard.json');
  }

  return { dir: questionDir, files };
}

/**
 * Renders the `.probes.md` probe-bank format (NEE-343/NEE-345): a fixed
 * `# Probe Bank` heading, one short framing line, then the probes as a
 * plain numbered markdown list — nothing fancier, since the only consumer
 * is a parser, never a human editing it by hand. NEE-345's probe engine
 * reads this file as its `source: 'bank'` pool (absent file ⇒ every probe
 * is `source: 'derived'` instead); parse with the numbered-item regex
 * `/^\d+\.\s+(.+)$/gm` against everything after the heading — each capture
 * is one probe's full text, no further structure.
 */
export function getProbeBankMd(probes: string[]): string {
  const items = probes.map((probe, i) => `${i + 1}. ${probe.trim()}`).join('\n');
  return `# Probe Bank\n\nFollow-up questions to pull from when drilling into this story. Hidden\nuntil the debrief — this file is a dotfile precisely so it stays invisible\nbefore then.\n\n${items}\n`;
}

/** Formats a raw reference solution into the `.reference.md` document. */
export function formatReferenceSolutionMd(code: string): string {
  // Four-backtick fence so a reference solution that itself contains a
  // ``` fence (e.g. in a doc comment) cannot break out of the block.
  return `# Reference Solution\n\n\`\`\`\`tsx\n${code.replace(/\n?$/, '\n')}\`\`\`\`\n`;
}

/**
 * Renders a solution-file template with REAL signature/title data — the exact
 * starter content a generated question's scaffold produces. (getStubContent
 * renders with empty placeholders, which is not what a generated question's
 * stub looks like — the verifier's stub-must-fail run needs the real thing.)
 */
export function renderSolutionStub(
  category: CategorySlug,
  file: string,
  data: { signature?: string; title?: string },
): string {
  const config = getCategoryConfig(category);
  const templatePath = path.join(TEMPLATES_DIR, config.templateDir, file + '.hbs');
  if (!fs.existsSync(templatePath)) return '';
  const tmpl = loadTemplate(templatePath);
  return tmpl({
    title: data.title || '',
    slug: '',
    category: config.name,
    categorySlug: category,
    difficulty: '',
    suggestedTime: 0,
    description: '',
    signature: data.signature || '',
    testCode: '',
    solutionCode: '',
  });
}

export function getStubContent(category: CategorySlug, file: string): string {
  const config = getCategoryConfig(category);
  const templateDir = path.join(TEMPLATES_DIR, config.templateDir);
  const templateFile = file + '.hbs';
  const templatePath = path.join(templateDir, templateFile);

  if (fs.existsSync(templatePath)) {
    // Return the template with empty placeholders
    const tmpl = loadTemplate(templatePath);
    return tmpl({
      title: '',
      slug: '',
      category: '',
      categorySlug: category,
      difficulty: '',
      suggestedTime: 0,
      description: '',
      signature: '',
      testCode: '',
      solutionCode: '',
    });
  }

  return '';
}
