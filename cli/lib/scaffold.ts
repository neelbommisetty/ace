import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { CategorySlug, Difficulty } from './categories.js';
import { getCategoryConfig, getSuggestedTime, isDesignCategory } from './categories.js';
import { createScorecard, writeScorecard } from './scorecard.js';
import { resolveWorkspaceRoot, getQuestionsDir as getQuestionsDirPath } from './paths.js';

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '../templates');

interface ScaffoldOptions {
  title: string;
  slug: string;
  category: CategorySlug;
  difficulty: Difficulty;
  description: string;
  signature?: string;
  testCode?: string;
  solutionCode?: string;
  notesTemplate?: string;
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

export function getQuestionDir(category: CategorySlug, slug: string): string {
  const root = resolveWorkspaceRoot();
  const questionsDir = getQuestionsDirPath(root);
  return path.join(questionsDir, category, slug);
}

export function scaffoldQuestion(opts: ScaffoldOptions): string {
  const config = getCategoryConfig(opts.category);
  const questionDir = getQuestionDir(opts.category, opts.slug);
  const suggestedTime = getSuggestedTime(opts.category, opts.difficulty);

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

  if (isDesignCategory(opts.category)) {
    // Design question: notes.md
    const notesTemplate = loadTemplate(path.join(TEMPLATES_DIR, 'design', 'notes.md.hbs'));
    fs.writeFileSync(path.join(questionDir, 'notes.md'), notesTemplate(templateData));
  } else {
    // Coding question: solution + test files
    const templateDir = path.join(TEMPLATES_DIR, config.templateDir);

    for (const solutionFile of config.solutionFiles) {
      const templateFile = solutionFile + '.hbs';
      const templatePath = path.join(templateDir, templateFile);

      if (fs.existsSync(templatePath)) {
        const tmpl = loadTemplate(templatePath);
        fs.writeFileSync(path.join(questionDir, solutionFile), tmpl(templateData));
      } else if (opts.solutionCode) {
        fs.writeFileSync(path.join(questionDir, solutionFile), opts.solutionCode);
      }
    }

    for (const testFile of config.testFiles) {
      const templateFile = testFile + '.hbs';
      const templatePath = path.join(templateDir, templateFile);

      if (fs.existsSync(templatePath)) {
        const tmpl = loadTemplate(templatePath);
        fs.writeFileSync(path.join(questionDir, testFile), tmpl(templateData));
      } else if (opts.testCode) {
        fs.writeFileSync(path.join(questionDir, testFile), opts.testCode);
      }
    }
  }

  // Scorecard
  const scorecard = createScorecard(opts.title, opts.category, opts.difficulty);
  writeScorecard(opts.category, opts.slug, scorecard);

  return questionDir;
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
