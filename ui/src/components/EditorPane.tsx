import { useEffect, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
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
  fontSize: 13,
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
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

  return (
    <div className="editor-pane">
      <div className="file-tabs">
        {order.map((info) => {
          const f = files[info.relPath];
          const dirty = f != null && f.loaded && f.buffer !== f.savedContent;
          return (
            <button
              key={info.relPath}
              className={`file-tab ${info.relPath === active ? 'active' : ''}`}
              onClick={() => onSelect(info.relPath)}
              title={info.relPath}
            >
              {info.readonly && (
                <span className="lock-badge" title="Test file — read-only in M1">
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
            theme="ace-dark"
            onMount={onMount}
            onChange={(value) => {
              if (value != null) onChange(active, value);
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
