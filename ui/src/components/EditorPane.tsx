import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { EDITOR_APPEARANCE, EDITOR_THEME } from '../editor-options';
import { useLatestRef } from '../hooks/useLatestRef';
import { agoShort } from '../lib/format';
import type { QuestionFileInfo } from '../types';
import { ConflictBanner } from './ConflictBanner';

export interface FileState {
  info: QuestionFileInfo;
  buffer: string;
  savedContent: string;
  savedHash: string;
  loaded: boolean;
  loadError: string | null;
  saveState: 'saved' | 'saving' | 'unsaved';
  lastSavedAt: number | null;
  saveError: string | null;
  conflict: boolean;
}

const EDITOR_OPTIONS = {
  ...EDITOR_APPEARANCE,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  renderLineHighlight: 'line' as const,
  padding: { top: 12 },
  fixedOverflowWidgets: true,
  smoothScrolling: true,
  stickyScroll: { enabled: false },
};

export function EditorPane({
  order,
  files,
  active,
  onSelect,
  onChange,
  onMount,
  onConflictReload,
  onConflictKeep,
}: {
  order: QuestionFileInfo[];
  files: Record<string, FileState>;
  active: string;
  onSelect: (relPath: string) => void;
  onChange: (relPath: string, value: string) => void;
  onMount: OnMount;
  onConflictReload: (relPath: string) => void;
  onConflictKeep: (relPath: string) => void;
}) {
  const activeFile = files[active];

  // Monaco-react keeps ONE Editor instance alive across tab switches and just
  // swaps its model — see the onChange handler below for why we resolve the
  // emitting file from this ref instead of trusting the `active` closure.
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  // Latest `files` by render time, so ANY pending onDidChangeModelContent
  // listener — this render's or a stale one from the previous commit — sees
  // the current readonly flags when it runs during the passive-effect phase.
  const filesRef = useLatestRef(files);

  return (
    <div className="editor-pane">
      <div className="file-tabs">
        {order.map((info) => {
          const f = files[info.relPath];
          const dirty = f != null && f.loaded && f.buffer !== f.savedContent;
          // NEE-358: the conflict banner renders for the ACTIVE tab only, so a
          // conflicted background file — one nothing will autosave — was
          // invisible until you happened to click back to it.
          const conflicted = f != null && f.conflict;
          return (
            <button
              key={info.relPath}
              className={`file-tab ${info.relPath === active ? 'active' : ''}`}
              onClick={() => onSelect(info.relPath)}
              title={conflicted ? `${info.relPath} — changed on disk, unresolved` : info.relPath}
            >
              {conflicted && (
                <span className="conflict-badge" title="Changed on disk — resolve to keep saving">
                  ⚠
                </span>
              )}
              {info.readonly && (
                <span
                  className="lock-badge"
                  title="Generated tests are read-only — dispute a failing assertion to propose a fix"
                >
                  🔒
                </span>
              )}
              {info.name}
              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
            </button>
          );
        })}
      </div>
      {activeFile?.conflict && (
        <ConflictBanner
          fileName={activeFile.info.name}
          onReload={() => onConflictReload(active)}
          onKeepMine={() => onConflictKeep(active)}
        />
      )}
      <div className="editor-host">
        {activeFile == null ? (
          <div className="pane-empty">No file selected.</div>
        ) : activeFile.loadError ? (
          <div className="pane-empty error-note">{activeFile.loadError}</div>
        ) : !activeFile.loaded ? (
          <div className="pane-empty">Loading {activeFile.info.name}…</div>
        ) : (
          <Editor
            path={`file:///${activeFile.info.relPath}`}
            value={activeFile.buffer}
            theme={EDITOR_THEME}
            onMount={(editor, monacoInstance) => {
              editorRef.current = editor;
              onMount(editor, monacoInstance);
            }}
            onChange={(value) => {
              if (value == null) return;
              // NEE-334: don't attribute by the 'active' prop closed over at
              // subscribe time — during a tab-switch commit the model swap
              // effect runs before monaco-react resubscribes onChange, so a
              // still-mounted listener from the PREVIOUS render can fire here
              // with 'active' pointing at the tab we just switched AWAY from.
              // Resolve the real file from the editor's current model URI
              // instead, and refuse anything we can't map to a known,
              // non-readonly file (this also catches the upstream monaco-react
              // bug where switching to a readonly tab calls setValue() without
              // the preventTriggerChangeEvent suppression it uses elsewhere).
              const uriPath = editorRef.current?.getModel?.()?.uri.path;
              if (uriPath == null) return;
              const relPath = uriPath.startsWith('/') ? uriPath.slice(1) : uriPath;
              const info = filesRef.current[relPath]?.info;
              if (info == null || info.readonly) return;
              onChange(relPath, value);
            }}
            options={{ ...EDITOR_OPTIONS, readOnly: activeFile.info.readonly }}
            loading={<div className="pane-empty">Starting editor…</div>}
          />
        )}
      </div>
      <div className="editor-strip">
        {activeFile && <SaveIndicator file={activeFile} />}
        <span className="strip-path mono">{activeFile?.info.relPath}</span>
        <span className="strip-right">
          {activeFile?.info.readonly && <span className="strip-readonly">read-only</span>}
        </span>
      </div>
    </div>
  );
}

function SaveIndicator({ file }: { file: FileState }) {
  // re-render each second so 'saved Ns ago' stays fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (file.info.readonly) return <span className="save-indicator save-readonly">read-only</span>;
  if (file.saveError) {
    return (
      <span className="save-indicator save-error" title={file.saveError}>
        ⚠ save failed
      </span>
    );
  }
  if (file.saveState === 'saving') return <span className="save-indicator save-saving">saving…</span>;
  if (file.saveState === 'unsaved') {
    return <span className="save-indicator save-unsaved">● unsaved</span>;
  }
  return (
    <span className="save-indicator save-saved">
      ● saved{file.lastSavedAt != null ? ` ${agoShort(file.lastSavedAt)}` : ''}
    </span>
  );
}
