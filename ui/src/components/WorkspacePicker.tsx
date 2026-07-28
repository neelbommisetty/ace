import { useState } from 'react';
import { ApiError, getWorkspaceRecents, switchWorkspace } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { relTime } from '../lib/format';
import type { RecentWorkspace } from '../types';

/**
 * Display-only basename (unlike the reset flow's confirm string, which must
 * come from the server verbatim — see WorkspaceInfo.confirmName).
 */
function baseName(root: string): string {
  const trimmed = root.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

type PickerState = { kind: 'idle' } | { kind: 'switching' } | { kind: 'error'; message: string };

/**
 * Recents list + free path input shared by the full-screen picker (unmounted
 * boot) and the switch dialog. A successful switch ends in a full page
 * reload — either directly below, or via App's `workspace-switched` SSE
 * handler, whichever lands first (reloading an already-navigating page is a
 * no-op). Only the same-root no-op stays on this page, via `onSameRoot`.
 */
function PickerList({
  currentRoot,
  onSameRoot,
}: {
  currentRoot: string | null;
  onSameRoot?: () => void;
}) {
  const [recents, setRecents] = useState<RecentWorkspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [state, setState] = useState<PickerState>({ kind: 'idle' });

  useCancellableEffect((cancelled) => {
    getWorkspaceRecents()
      .then((res) => {
        if (!cancelled()) setRecents(res.recents);
      })
      .catch((e: unknown) => {
        if (!cancelled()) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load recent workspaces');
        }
      });
  }, []);

  const busy = state.kind === 'switching';

  const open = (root: string) => {
    if (busy) return;
    setState({ kind: 'switching' });
    switchWorkspace(root, crypto.randomUUID())
      .then((result) => {
        if (currentRoot != null && result.workspaceRoot === currentRoot) {
          setState({ kind: 'idle' });
          onSameRoot?.();
          return;
        }
        window.location.reload();
      })
      .catch((e: unknown) => {
        setState({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'Failed to switch workspace',
        });
      });
  };

  return (
    <div className="picker-list-wrap">
      {loadError != null && <div className="error-note">{loadError}</div>}
      {recents == null && loadError == null && (
        <div className="pane-empty">Loading recent workspaces…</div>
      )}
      {recents != null && recents.length === 0 && (
        <p className="picker-empty">
          No recent workspaces yet — enter a path below, or run <code>ace ui</code> inside one.
        </p>
      )}
      {recents != null && recents.length > 0 && (
        <ul className="picker-list">
          {recents.map((r) => (
            <li key={r.root}>
              <button
                className="picker-item"
                disabled={busy}
                onClick={() => open(r.root)}
                title={r.root}
              >
                <span className="picker-item-name">{baseName(r.root)}</span>
                <span className="picker-item-path mono">{r.root}</span>
                {r.root === currentRoot ? (
                  <span className="picker-item-when">current</span>
                ) : (
                  <span className="picker-item-when">{relTime(r.lastOpenedAt)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="picker-path-row">
        <input
          className="key-input mono"
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="/path/to/workspace"
          value={pathInput}
          disabled={busy}
          onChange={(e) => {
            setPathInput(e.target.value);
            if (state.kind === 'error') setState({ kind: 'idle' });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pathInput.trim() !== '') open(pathInput.trim());
          }}
        />
        <button
          className="btn btn-accent"
          disabled={busy || pathInput.trim() === ''}
          onClick={() => open(pathInput.trim())}
        >
          {busy ? 'Opening…' : 'Open'}
        </button>
      </div>
      {state.kind === 'error' && <div className="error-note">{state.message}</div>}
    </div>
  );
}

/** Full-screen picker rendered instead of the routed app when the server booted unmounted. */
export function WorkspacePicker() {
  return (
    <div className="token-screen">
      <div className="token-card picker-card">
        <div className="rail-logo">A</div>
        <h1>Pick a workspace</h1>
        <p>
          No workspace is mounted. Open a recent one, or enter the path of a directory with a{' '}
          <code>questions/</code> folder (<code>ace init</code> creates one).
        </p>
        <PickerList currentRoot={null} />
      </div>
    </div>
  );
}

/**
 * App-level switch modal (Cmd/Ctrl+K, or the Library topbar's workspace
 * button) reusing the same picker list. Follows WorkspaceResetDialog's
 * overlay/header/body conventions.
 */
export function WorkspaceSwitchDialog({
  currentRoot,
  onClose,
}: {
  currentRoot: string | null;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal modal-picker">
        <div className="modal-header">
          <h2>Switch workspace</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <PickerList currentRoot={currentRoot} onSameRoot={onClose} />
        </div>
      </div>
    </div>
  );
}
