/**
 * Bundled monaco setup — imported once from main.tsx before first render.
 * Never the CDN: workers come in via Vite `?worker` imports and
 * `loader.config({ monaco })` points @monaco-editor/react at this bundle.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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

monaco.editor.defineTheme('ace-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0f141b',
    'editor.foreground': '#dce4ed',
    'editor.lineHighlightBackground': '#161c24',
    'editorLineNumber.foreground': '#5c6875',
    'editorLineNumber.activeForeground': '#8b97a6',
    'editorGutter.background': '#0f141b',
    'editorIndentGuide.background1': '#2a3340',
    'editorIndentGuide.activeBackground1': '#3a4552',
    'editorWidget.background': '#1b222c',
    'editorWidget.border': '#2a3340',
    'editorSuggestWidget.background': '#1b222c',
    'editorSuggestWidget.border': '#2a3340',
    'editorSuggestWidget.selectedBackground': '#212a35',
    'editorHoverWidget.background': '#1b222c',
    'editorHoverWidget.border': '#2a3340',
    'editorCursor.foreground': '#ffb224',
    'editor.selectionBackground': '#2a334099',
    'scrollbarSlider.background': '#2a334066',
    'scrollbarSlider.hoverBackground': '#2a3340aa',
    'scrollbarSlider.activeBackground': '#2a3340dd',
  },
});

loader.config({ monaco });
