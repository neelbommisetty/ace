import { useEffect, useState } from 'react';
import { getSettings, getWorkspace, putSettings } from '../api';
import { WorkspaceResetDialog } from '../components/WorkspaceResetDialog';
import type { SettingsInfo, WorkspaceResetMode } from '../types';

type ProviderKey = 'openai' | 'anthropic';

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** Basename of a workspace root, tolerant of both POSIX and Windows separators. */
function folderNameOf(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/**
 * /settings — API keys and default provider. Keys are write-only: the server
 * only ever returns a masked suffix, and saves are validated against the
 * provider before anything is written.
 */
export function Settings() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [defaultSaving, setDefaultSaving] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [resetMode, setResetMode] = useState<WorkspaceResetMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((got) => {
        if (!cancelled) setInfo(got);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load settings');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getWorkspace()
      .then((ws) => {
        if (!cancelled) setFolderName(folderNameOf(ws.root));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setWorkspaceLoadError(e instanceof Error ? e.message : 'Failed to load workspace info');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dangerDisabled = folderName == null;

  const setDefaultProvider = (value: ProviderKey) => {
    setDefaultSaving(true);
    setDefaultError(null);
    putSettings({ defaultProvider: value })
      .then((next) => {
        setInfo(next);
        setDefaultSaving(false);
      })
      .catch((e: unknown) => {
        setDefaultSaving(false);
        setDefaultError(e instanceof Error ? e.message : 'Failed to save');
      });
  };

  return (
    <div className="settings">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="topbar-title">Settings</h1>
        </div>
      </header>
      <div className="library-scroll">
        <div className="settings-wrap">
          {loadError != null && <div className="error-note">{loadError}</div>}
          {info == null && loadError == null && (
            <div className="pane-empty">Loading settings…</div>
          )}
          {info != null && (
            <>
              {info.mockMode && (
                <div className="mock-banner">
                  Mock LLM mode is on (<code>ACE_E2E_MOCK_LLM=1</code>) — reviews and disputes
                  return canned responses; no API calls are made and keys are ignored.
                </div>
              )}
              <ProviderCard provider="openai" info={info} onSaved={setInfo} />
              <ProviderCard provider="anthropic" info={info} onSaved={setInfo} />
              <section className="settings-card">
                <h2 className="settings-card-title">Default provider</h2>
                <p className="settings-hint">Used for reviews and disputes.</p>
                <div className="settings-row">
                  <select
                    className="status-select"
                    value={info.defaultProvider ?? ''}
                    disabled={defaultSaving}
                    onChange={(e) => {
                      if (e.target.value === 'openai' || e.target.value === 'anthropic') {
                        setDefaultProvider(e.target.value);
                      }
                    }}
                  >
                    <option value="" disabled>
                      {info.openai.configured || info.anthropic.configured
                        ? 'Pick a provider…'
                        : 'Add a key first'}
                    </option>
                    {(['openai', 'anthropic'] as ProviderKey[]).map((p) => (
                      <option key={p} value={p} disabled={!info[p].configured}>
                        {PROVIDER_LABELS[p]}
                        {!info[p].configured ? ' (no key)' : ''}
                      </option>
                    ))}
                  </select>
                  {defaultSaving && <span className="cell-dim">saving…</span>}
                </div>
                {defaultError != null && <div className="error-note">{defaultError}</div>}
              </section>
            </>
          )}
          <section className="settings-danger-zone">
            <h2 className="settings-section-title">Danger zone</h2>
            <div className="settings-card settings-card-danger">
              <h3 className="settings-card-title">Clear progress</h3>
              <p className="settings-hint">
                Archives every attempt, test run, review, and dispute, and returns each question
                to a fresh, unattempted state. Solution and test files on disk are left exactly as
                they are — nothing is deleted, the archive keeps a full copy.
              </p>
              <div className="settings-row">
                <button
                  className="btn btn-danger"
                  disabled={dangerDisabled}
                  onClick={() => setResetMode('progress')}
                >
                  Clear progress…
                </button>
                {dangerDisabled && (
                  <span className="cell-dim">
                    {workspaceLoadError != null
                      ? 'workspace info unavailable'
                      : 'loading workspace info…'}
                  </span>
                )}
              </div>
            </div>
            <div className="settings-card settings-card-danger">
              <h3 className="settings-card-title">Reset workspace</h3>
              <p className="settings-hint">
                Does everything Clear progress does, and also resets solution files on disk to
                their original scaffold. Applied dispute fixes to test files are kept as the new
                baseline for the next attempt.
              </p>
              <div className="settings-row">
                <button
                  className="btn btn-danger"
                  disabled={dangerDisabled}
                  onClick={() => setResetMode('full')}
                >
                  Reset workspace…
                </button>
                {dangerDisabled && (
                  <span className="cell-dim">
                    {workspaceLoadError != null
                      ? 'workspace info unavailable'
                      : 'loading workspace info…'}
                  </span>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      {resetMode != null && folderName != null && (
        <WorkspaceResetDialog
          mode={resetMode}
          folderName={folderName}
          onClose={() => setResetMode(null)}
        />
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  info,
  onSaved,
}: {
  provider: ProviderKey;
  info: SettingsInfo;
  onSaved: (next: SettingsInfo) => void;
}) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'ok'>('idle');
  const [error, setError] = useState<string | null>(null);
  const settings = info[provider];

  const save = () => {
    const key = value.trim();
    if (key === '' || state === 'saving') return;
    setState('saving');
    setError(null);
    putSettings(provider === 'openai' ? { openaiKey: key } : { anthropicKey: key })
      .then((next) => {
        onSaved(next);
        setValue('');
        setState('ok');
      })
      .catch((e: unknown) => {
        setState('idle');
        setError(e instanceof Error ? e.message : 'Failed to save the key');
      });
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">{PROVIDER_LABELS[provider]}</h2>
        {settings.configured ? (
          <span className="chip chip-status-green mono" title="A key is configured">
            {settings.masked ?? 'configured'}
          </span>
        ) : (
          <span className="chip chip-status-not-started">not configured</span>
        )}
      </div>
      <div className="settings-row">
        <input
          className="key-input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={settings.configured ? 'paste a new key to replace' : 'paste your API key'}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setState('idle');
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <button
          className="btn btn-accent btn-small"
          onClick={save}
          disabled={value.trim() === '' || state === 'saving'}
        >
          {state === 'saving' ? 'Validating…' : 'Save'}
        </button>
        {state === 'ok' && (
          <span className="save-ok" title="Key validated and saved">
            ✓ saved
          </span>
        )}
      </div>
      {error != null && <div className="error-note">{error}</div>}
      <p className="settings-hint">
        Validated against the {PROVIDER_LABELS[provider]} API before saving; stored in your global
        ace config. The full key is never sent back to this page.
      </p>
    </section>
  );
}
