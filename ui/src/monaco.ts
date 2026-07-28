/**
 * Bundled monaco setup — imported once from main.tsx before first render.
 * Never the CDN: workers come in via Vite `?worker` imports and
 * `loader.config({ monaco })` points @monaco-editor/react at this bundle.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { EDITOR_THEME } from './editor-options';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript' || label === 'ts') {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

// Solutions import from test-only or workspace-level deps monaco can't see;
// semantic validation would be all noise. Syntax errors are still shown.
// (monaco 0.55 moved languages.typescript to a top-level namespace.)
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
});

// Catppuccin Macchiato (official palette hexes) for every Monaco surface.
monaco.editor.defineTheme(EDITOR_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '939ab7', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c6a0f6' },
    { token: 'string', foreground: 'a6da95' },
    { token: 'number', foreground: 'f5a97f' },
    { token: 'type', foreground: 'eed49f' },
    { token: 'class', foreground: 'eed49f' },
    { token: 'function', foreground: '8aadf4' },
    { token: 'variable', foreground: 'cad3f5' },
    { token: 'constant', foreground: 'f5a97f' },
    { token: 'operator', foreground: '91d7e3' },
    { token: 'delimiter', foreground: '939ab7' },
    { token: 'tag', foreground: '8aadf4' },
    { token: 'attribute.name', foreground: 'eed49f' },
    { token: 'regexp', foreground: 'f5bde6' },
  ],
  colors: {
    'editor.background': '#24273a',
    'editor.foreground': '#cad3f5',
    'editor.lineHighlightBackground': '#363a4f66',
    'editorLineNumber.foreground': '#6e738d',
    'editorLineNumber.activeForeground': '#a5adcb',
    'editorGutter.background': '#24273a',
    'editorIndentGuide.background1': '#363a4f',
    'editorIndentGuide.activeBackground1': '#494d64',
    'editorWidget.background': '#1e2030',
    'editorWidget.border': '#363a4f',
    'editorSuggestWidget.background': '#1e2030',
    'editorSuggestWidget.border': '#363a4f',
    'editorSuggestWidget.selectedBackground': '#363a4f',
    'editorHoverWidget.background': '#1e2030',
    'editorHoverWidget.border': '#363a4f',
    'editorCursor.foreground': '#f4dbd6',
    'editor.selectionBackground': '#5b607899',
    'scrollbarSlider.background': '#5b607866',
    'scrollbarSlider.hoverBackground': '#5b6078aa',
    'scrollbarSlider.activeBackground': '#5b6078dd',
  },
});

loader.config({ monaco });
