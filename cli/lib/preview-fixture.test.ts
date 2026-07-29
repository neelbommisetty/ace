import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { derivePreviewFixture } from './preview-fixture.js';

describe('derivePreviewFixture', () => {
  it('degrades to a bare Component mount when there is no signature', () => {
    expect(derivePreviewFixture(undefined)).toEqual({ componentName: 'Component', propsCode: '{}' });
    expect(derivePreviewFixture(null)).toEqual({ componentName: 'Component', propsCode: '{}' });
    expect(derivePreviewFixture('')).toEqual({ componentName: 'Component', propsCode: '{}' });
  });

  it('derives props from a named interface + destructured signature (the category-doc example)', () => {
    const signature = [
      'interface TagInputProps {',
      '  value: string[];',
      '  onChange: (next: string[]) => void;',
      '  maxTags?: number;',
      '}',
      '',
      'export function TagInput({ value, onChange, maxTags }: TagInputProps)',
    ].join('\n');

    const result = derivePreviewFixture(signature);
    expect(result.componentName).toBe('TagInput');
    expect(result.propsCode).toContain("value: ['Example one', 'Example two']");
    expect(result.propsCode).toContain('onChange: (...args) => console.log("onChange", ...args)');
    expect(result.propsCode).toContain('maxTags: 10');
  });

  it('derives props from an inline object type (no named interface)', () => {
    const result = derivePreviewFixture('export function Badge({ label }: { label: string })');
    expect(result.componentName).toBe('Badge');
    expect(result.propsCode).toBe("{\n  label: 'Example label',\n}");
  });

  it('handles a non-destructured named param (`props: FooProps`)', () => {
    const signature = [
      'interface StarRatingProps {',
      '  value: number;',
      '  onChange: (next: number) => void;',
      '  max?: number;',
      '  label: string;',
      '  readOnly?: boolean;',
      '}',
      '',
      'export function StarRating(props: StarRatingProps)',
    ].join('\n');

    const result = derivePreviewFixture(signature);
    expect(result.componentName).toBe('StarRating');
    expect(result.propsCode).toContain('value: 1');
    expect(result.propsCode).toContain('onChange: (...args) => console.log("onChange", ...args)');
    expect(result.propsCode).toContain('max: 10');
    expect(result.propsCode).toContain("label: 'Example label'");
    expect(result.propsCode).toContain('readOnly: false');
  });

  it('strips JSDoc comments before parsing fields', () => {
    const signature = [
      'interface WidgetProps {',
      '  /** A count of things. */',
      '  count: number;',
      '}',
      '',
      'export function Widget({ count }: WidgetProps)',
    ].join('\n');

    const result = derivePreviewFixture(signature);
    expect(result.propsCode).toBe('{\n  count: 3,\n}');
  });

  it('falls back to empty props when the signature has no parseable param type', () => {
    expect(derivePreviewFixture('export function Empty()')).toEqual({
      componentName: 'Empty',
      propsCode: '{}',
    });
  });

  it('falls back to empty props for an unrecognised (generic/object) field type', () => {
    const result = derivePreviewFixture(
      'export function Chart({ data }: { data: Record<string, number> })',
    );
    expect(result.componentName).toBe('Chart');
    expect(result.propsCode).toBe('{\n  data: {},\n}');
  });
});

// ---------------------------------------------------------------------------
// Exclusion regression (NEE-352 acceptance #4): preview.tsx must never match
// the workspace vitest test glob. Extracted from the REAL source text of both
// places that glob is spelled out, rather than a hand-copied literal, so this
// test cannot silently drift from the actual pattern if either ever changes.
// ---------------------------------------------------------------------------

describe('preview.tsx never matches the vitest test-file glob', () => {
  function extractTestGlob(sourceRelPath: string): string {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', sourceRelPath), 'utf-8');
    const match = /include:\s*\[\s*'([^']*\.test\.\{ts,tsx\})'\s*\]/.exec(source);
    if (!match) throw new Error(`could not find the test-file include glob in ${sourceRelPath}`);
    return match[1];
  }

  it.each([['commands/init.ts'], ['lib/gen-verify.ts']])(
    'the glob in %s matches Component.test.tsx but not preview.tsx',
    (sourceRelPath) => {
      const glob = extractTestGlob(sourceRelPath);

      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-preview-glob-'));
      try {
        const qdir = path.join(root, 'questions', 'web-components', 'demo');
        fs.mkdirSync(qdir, { recursive: true });
        fs.writeFileSync(path.join(qdir, 'Component.test.tsx'), '');
        fs.writeFileSync(path.join(qdir, 'preview.tsx'), '');

        // Same pattern semantics vite/vitest use (brace expansion + `**`),
        // via Node's own built-in glob matcher — no extra dependency needed.
        const matches = fs.globSync(glob, { cwd: root });

        expect(matches).toEqual(['questions/web-components/demo/Component.test.tsx']);
        expect(matches).not.toContain('questions/web-components/demo/preview.tsx');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
