import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
import { post } from './api';

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

monaco.editor.defineTheme('drakox-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b6b78', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'string', foreground: 'a5d6a7' },
    { token: 'number', foreground: 'f78c6c' },
    { token: 'type', foreground: 'ffcb6b' },
  ],
  colors: {
    'editor.background': '#0b0b0e',
    'editor.lineHighlightBackground': '#16161b',
    'editorLineNumber.foreground': '#3f3f48',
    'editorLineNumber.activeForeground': '#9a9aa6',
    'editor.selectionBackground': '#ff6b3533',
    'editorCursor.foreground': '#ff6b35',
    'editorIndentGuide.background1': '#1f1f25',
    'editorGutter.background': '#0b0b0e',
    'editorWidget.background': '#141418',
    'editorSuggestWidget.background': '#141418',
    'editorGhostText.foreground': '#ff8a5c99',
    'diffEditor.insertedTextBackground': '#34d39922',
    'diffEditor.removedTextBackground': '#f8717122',
  },
});
monaco.editor.defineTheme('drakox-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorCursor.foreground': '#ff5a36',
    'editor.selectionBackground': '#ff6b3530',
    'editorGhostText.foreground': '#e0582f99',
  },
});

/** Cursor-style Tab completion backed by /api/complete (any provider: local FIM via Ollama, or chat models). */
let registered = false;
export const completionState = { enabled: localStorage.getItem('drakox.tab') !== '0', path: '' };

export function registerInlineCompletions(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model: monaco.editor.ITextModel, position: monaco.Position, _ctx: unknown, token: monaco.CancellationToken) {
      if (!completionState.enabled) return { items: [] };
      await new Promise((r) => setTimeout(r, 280));
      if (token.isCancellationRequested) return { items: [] };
      const full = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = full.slice(Math.max(0, offset - 6000), offset);
      const suffix = full.slice(offset, offset + 2000);
      try {
        const r = await post<{ completion: string }>('/api/complete', { prefix, suffix, path: completionState.path, language: model.getLanguageId() });
        if (token.isCancellationRequested || !r.completion) return { items: [] };
        return { items: [{ insertText: r.completion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      } catch {
        return { items: [] };
      }
    },
    disposeInlineCompletions() {},
  } as any);
}

export { monaco };
