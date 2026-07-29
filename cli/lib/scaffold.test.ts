import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProbeBankMd, getStubContent, renderSolutionStub, scaffoldQuestionAt } from './scaffold.js';

let tempRoot = '';
let otherCwdWorkspace = '';
let originalCwd = '';

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-scaffold-'));
  fs.mkdirSync(path.join(root, 'questions'), { recursive: true });
  return root;
}

beforeEach(() => {
  originalCwd = process.cwd();
  tempRoot = createWorkspace();
  otherCwdWorkspace = createWorkspace();
  process.chdir(otherCwdWorkspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of [tempRoot, otherCwdWorkspace]) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('scaffoldQuestionAt', () => {
  it('writes coding-question files under the GIVEN root, ignoring process.cwd()', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Two Sum',
      slug: 'two-sum',
      category: 'js-ts',
      difficulty: 'hard',
      description: 'Find indices adding to target.',
    });

    const expectedDir = path.join(tempRoot, 'questions', 'js-ts', 'two-sum');
    expect(result.dir).toBe(expectedDir);
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'solution.ts'))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, 'solution.test.ts'))).toBe(true);
    expect(result.files.sort()).toEqual(['README.md', 'solution.test.ts', 'solution.ts']);

    // Nothing should have been written under the cwd workspace.
    expect(fs.existsSync(path.join(otherCwdWorkspace, 'questions', 'js-ts'))).toBe(false);

    const readme = fs.readFileSync(path.join(expectedDir, 'README.md'), 'utf-8');
    expect(readme).toContain('**Difficulty:** hard');
  });

  it('writes design-question files (notes.md, no solution/test files)', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Infinite Scroll',
      slug: 'infinite-scroll',
      category: 'design-fe',
      difficulty: 'medium',
      description: 'Design an infinite scroll component.',
    });

    const expectedDir = path.join(tempRoot, 'questions', 'design-fe', 'infinite-scroll');
    expect(result.dir).toBe(expectedDir);
    expect(result.files.sort()).toEqual(['README.md', 'notes.md']);
    expect(fs.existsSync(path.join(expectedDir, 'notes.md'))).toBe(true);
  });

  it('writes behavioral-question files (story.md, no test file, never .reference.md)', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'A Conflict You Navigated',
      slug: 'conflict-navigated',
      category: 'behavioral',
      difficulty: 'medium',
      description: 'Tell me about a time you disagreed with a decision.',
      // A reference solution is never written for a category with no test
      // suite to verify it against — must be silently dropped, not written.
      referenceSolutionMd: '# Reference\n\nSome reference material.',
    });

    const expectedDir = path.join(tempRoot, 'questions', 'behavioral', 'conflict-navigated');
    expect(result.dir).toBe(expectedDir);
    expect(result.files.sort()).toEqual(['README.md', 'story.md']);
    expect(fs.existsSync(path.join(expectedDir, 'story.md'))).toBe(true);
    expect(fs.existsSync(path.join(expectedDir, '.reference.md'))).toBe(false);
  });

  it('writes a competency-bearing README and a hidden .probes.md when given competency/followUps (NEE-343)', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'A Conflict You Navigated',
      slug: 'conflict-navigated-2',
      category: 'behavioral',
      difficulty: 'medium',
      description: 'Tell me about a time you disagreed with a decision.',
      competency: 'conflict',
      followUps: [
        'What would the other engineer say about how you handled it?',
        'How would your approach change if this happened at 10x the team size?',
      ],
    });

    const expectedDir = path.join(tempRoot, 'questions', 'behavioral', 'conflict-navigated-2');
    expect(result.files.sort()).toEqual(['.probes.md', 'README.md', 'story.md']);

    const readme = fs.readFileSync(path.join(expectedDir, 'README.md'), 'utf-8');
    expect(readme).toContain('**Competency:** conflict');

    const probes = fs.readFileSync(path.join(expectedDir, '.probes.md'), 'utf-8');
    expect(probes).toContain('# Probe Bank');
    expect(probes).toContain('1. What would the other engineer say about how you handled it?');
    expect(probes).toContain(
      '2. How would your approach change if this happened at 10x the team size?',
    );
  });

  it('writes no competency line and no .probes.md for a coding question (competency/followUps absent)', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Two Sum',
      slug: 'two-sum-no-competency',
      category: 'js-ts',
      difficulty: 'medium',
      description: 'Find indices adding to target.',
    });

    const expectedDir = path.join(tempRoot, 'questions', 'js-ts', 'two-sum-no-competency');
    expect(result.files).not.toContain('.probes.md');
    expect(fs.existsSync(path.join(expectedDir, '.probes.md'))).toBe(false);

    const readme = fs.readFileSync(path.join(expectedDir, 'README.md'), 'utf-8');
    expect(readme).not.toContain('**Competency:**');
  });

  // Byte-exact, because the failure this guards is invisible to every
  // substring assertion: a Handlebars {{#if}} block whose closing tag sits on
  // its own line swallows that line entirely, so losing the blank line before
  // `---` turns the thematic break into a Setext H2 and the whole metadata
  // block renders as one giant heading in the Problem pane.
  it('renders the README metadata block with a real thematic break, competency or not', () => {
    const header = '# Two Sum\n\n**Category:** JS/TS Puzzles\n**Difficulty:** medium\n**Suggested Time:** ~30 minutes\n';

    scaffoldQuestionAt(tempRoot, {
      title: 'Two Sum',
      slug: 'readme-shape-coding',
      category: 'js-ts',
      difficulty: 'medium',
      description: 'Find indices adding to target.',
    });
    expect(
      fs.readFileSync(path.join(tempRoot, 'questions', 'js-ts', 'readme-shape-coding', 'README.md'), 'utf-8'),
    ).toBe(`${header}\n---\n\nFind indices adding to target.\n`);

    scaffoldQuestionAt(tempRoot, {
      title: 'A Disagreement',
      slug: 'readme-shape-behavioral',
      category: 'behavioral',
      difficulty: 'easy',
      description: 'Tell me about a time.',
      competency: 'conflict',
    });
    expect(
      fs.readFileSync(
        path.join(tempRoot, 'questions', 'behavioral', 'readme-shape-behavioral', 'README.md'),
        'utf-8',
      ),
    ).toBe(
      '# A Disagreement\n\n**Category:** Behavioral\n**Difficulty:** easy\n**Suggested Time:** ~5 minutes\n**Competency:** conflict\n\n---\n\nTell me about a time.\n',
    );
  });

  it('writes no .probes.md when followUps is an empty array', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Empty Probes',
      slug: 'empty-probes',
      category: 'behavioral',
      difficulty: 'easy',
      description: 'Tell me about a time.',
      competency: 'ownership',
      followUps: [],
    });

    expect(result.files).not.toContain('.probes.md');
    expect(
      fs.existsSync(path.join(tempRoot, 'questions', 'behavioral', 'empty-probes', '.probes.md')),
    ).toBe(false);
  });

  it('writeScorecard: false (default) leaves no scorecard.json', () => {
    const result = scaffoldQuestionAt(tempRoot, {
      title: 'Debounce',
      slug: 'debounce',
      category: 'js-ts',
      difficulty: 'easy',
      description: 'Implement debounce.',
    });

    expect(fs.existsSync(path.join(result.dir, 'scorecard.json'))).toBe(false);
    expect(result.files).not.toContain('scorecard.json');
  });

  it('writeScorecard: true puts scorecard.json under the PASSED root, not cwd', () => {
    const result = scaffoldQuestionAt(
      tempRoot,
      {
        title: 'Throttle',
        slug: 'throttle',
        category: 'js-ts',
        difficulty: 'medium',
        description: 'Implement throttle.',
      },
      { writeScorecard: true },
    );

    const scorecardPath = path.join(result.dir, 'scorecard.json');
    expect(fs.existsSync(scorecardPath)).toBe(true);
    expect(result.files).toContain('scorecard.json');

    // cwd points at a *different*, also-valid workspace — scorecard must not
    // land there.
    expect(
      fs.existsSync(path.join(otherCwdWorkspace, 'questions', 'js-ts', 'throttle', 'scorecard.json')),
    ).toBe(false);

    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8'));
    expect(scorecard.title).toBe('Throttle');
    expect(scorecard.difficulty).toBe('medium');
  });

  it('throws when the question dir already exists', () => {
    scaffoldQuestionAt(tempRoot, {
      title: 'Dup',
      slug: 'dup',
      category: 'js-ts',
      difficulty: 'easy',
      description: 'First.',
    });

    expect(() =>
      scaffoldQuestionAt(tempRoot, {
        title: 'Dup Again',
        slug: 'dup',
        category: 'js-ts',
        difficulty: 'easy',
        description: 'Second.',
      }),
    ).toThrow(/already exists/);
  });
});

describe('renderSolutionStub', () => {
  it('renders a js-ts stub with the real signature and a TODO body', () => {
    const stub = renderSolutionStub('js-ts', 'solution.ts', {
      signature: 'export function add(a: number, b: number): number',
    });
    expect(stub).toContain('export function add(a: number, b: number): number {');
    expect(stub).toContain('// TODO: implement');
  });

  it('uses the react-apps signature verbatim as the whole starter file', () => {
    const signature = [
      "import React from 'react';",
      '',
      'export default function App() {',
      '  // TODO: implement',
      '  return <div />;',
      '}',
    ].join('\n');
    const stub = renderSolutionStub('react-apps', 'App.tsx', { signature });
    expect(stub).toContain(signature);
  });

  it('prepends the React import and appends the JSX shell for web-components', () => {
    const stub = renderSolutionStub('web-components', 'Component.tsx', {
      signature: 'export function Badge({ label }: { label: string })',
      title: 'Badge Component',
    });
    expect(stub).toContain("import React from 'react';");
    expect(stub).toContain('export function Badge({ label }: { label: string }) {');
    expect(stub).toContain('<h1>Badge Component</h1>');
  });

  it('returns an empty string when the category has no template for the file', () => {
    expect(renderSolutionStub('js-ts', 'nonexistent.ts', { signature: 'x' })).toBe('');
  });
});

describe('getStubContent', () => {
  it('renders the behavioral story.md template non-empty', () => {
    // Not optional: getStubContent returning '' for a missing template is
    // silent — that '' becomes the workspace-reset baseline and the
    // reset-to-stub content, i.e. a user's story would be blanked on reset
    // with no error anywhere.
    const stub = getStubContent('behavioral', 'story.md');
    expect(stub).not.toBe('');
    expect(stub).toContain('## Situation');
  });
});

describe('getProbeBankMd (NEE-343/NEE-345 .probes.md format)', () => {
  it('renders a numbered list under a fixed heading, parseable via /^\\d+\\.\\s+(.+)$/gm', () => {
    const md = getProbeBankMd(['First probe?', 'Second probe?', 'Third probe?']);
    expect(md).toContain('# Probe Bank');

    const matches = [...md.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1]);
    expect(matches).toEqual(['First probe?', 'Second probe?', 'Third probe?']);
  });

  it('trims each probe and numbers from 1', () => {
    const md = getProbeBankMd(['  padded probe  ']);
    expect(md).toContain('1. padded probe');
  });
});
