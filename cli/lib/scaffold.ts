import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { CategorySlug, Difficulty } from './categories.js';
import { getCategoryConfig, getSuggestedTime, hasTests } from './categories.js';
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
  notesTemplate?: string;
  /** Written as `.interviewer.md` — invisible to the watcher/reconciler/UI. */
  interviewerPacket?: string;
  /** Pre-formatted markdown written as `.reference.md`; never for design categories. */
  referenceSolutionMd?: string;
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
  const suggestedTime = getSuggestedTime(opts.category, opts.difficulty);
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

  // Hidden interviewer artifacts (post-review debrief material). Dotfiles
  // are invisible to the watcher, reconciler, UI file list, and vitest by
  // construction — the room never shows them before a review exists.
  if (opts.interviewerPacket) {
    fs.writeFileSync(path.join(questionDir, '.interviewer.md'), opts.interviewerPacket);
    files.push('.interviewer.md');
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
