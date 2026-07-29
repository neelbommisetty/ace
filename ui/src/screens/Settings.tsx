import { useState } from 'react';
import { getSettings, getWorkspace, putSettings } from '../api';
import { useCancellableEffect } from '../hooks/useCancellableEffect';
import { WorkspaceResetDialog } from '../components/WorkspaceResetDialog';
import { modelLabel, PURPOSE_LABELS, PURPOSE_ORDER } from '../lib/models';
import type { SettingsInfo, WorkspaceResetMode } from '../types';

type ProviderKey = 'openai' | 'anthropic';

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

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

  useCancellableEffect((cancelled) => {
    getSettings()
      .then((got) => {
        if (!cancelled()) setInfo(got);
      })
      .catch((e: unknown) => {
        if (!cancelled()) setLoadError(e instanceof Error ? e.message : 'Failed to load settings');
      });
  }, []);

  useCancellableEffect((cancelled) => {
    getWorkspace()
      .then((ws) => {
        // Use the server's own basename verbatim — it's the exact string the
        // reset endpoint validates `confirm` against, so re-deriving it here
        // (e.g. splitting on separators) could disagree with the server for
        // roots containing unusual characters.
        if (!cancelled()) setFolderName(ws.confirmName);
      })
      .catch((e: unknown) => {
        if (!cancelled()) {
          setWorkspaceLoadError(e instanceof Error ? e.message : 'Failed to load workspace info');
        }
      });
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
              <ModelsSection info={info} />
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
                their original scaffold — including hand-written behavioral stories and design
                notes, not just code. The confirmation dialog names exactly which ones. Applied
                dispute fixes to test files are kept as the new baseline for the next attempt.
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

/**
 * Read-only per-purpose model map (NEE-303) — what GET /api/settings resolves
 * each paid action to right now. Full editability (NEE-274) can follow later;
 * this just answers "what will actually run" before the user commits to it
 * on Request review / Dispute / Generate / Brainstorm.
 */
function ModelsSection({ info }: { info: SettingsInfo }) {
  const models = info.models;
  return (
    <section className="settings-card">
      <h2 className="settings-card-title">Models</h2>
      <p className="settings-hint">Which provider and model each paid action resolves to.</p>
      {models == null ? (
        <p className="settings-hint">
          {info.openai.configured || info.anthropic.configured
            ? 'Pick a default provider above to resolve models.'
            : 'Add an API key above to resolve models.'}
        </p>
      ) : (
        <ul className="activity-list">
          {PURPOSE_ORDER.map((purpose) => (
            <li key={purpose} className="activity-item">
              <span>{PURPOSE_LABELS[purpose]}</span>
              <span className="mono cell-dim">{modelLabel(models[purpose])}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
  // Prefilled (base URLs are not secret, unlike keys); empty save clears.
  const [baseValue, setBaseValue] = useState(settings.baseUrl ?? '');

  const key = value.trim();
  const baseUrl = baseValue.trim() || null;
  const keyDirty = key !== '';
  const baseDirty = baseUrl !== settings.baseUrl;

  /**
   * Key and base URL save as one patch. The server validates the *effective*
   * pair on any change, so splitting them deadlocks when both must change at
   * once: a new proxy key alone is checked against the vendor host, and a new
   * proxy host alone is checked with the old vendor key. Neither can go first.
   */
  const save = () => {
    if (state === 'saving' || (!keyDirty && !baseDirty)) return;
    const patch = {
      ...(keyDirty ? (provider === 'openai' ? { openaiKey: key } : { anthropicKey: key }) : {}),
      ...(baseDirty
        ? provider === 'openai'
          ? { openaiBaseUrl: baseUrl }
          : { anthropicBaseUrl: baseUrl }
        : {}),
    };
    setState('saving');
    setError(null);
    putSettings(patch)
      .then((next) => {
        onSaved(next);
        setValue('');
        setBaseValue(next[provider].baseUrl ?? '');
        setState('ok');
      })
      .catch((e: unknown) => {
        setState('idle');
        setError(e instanceof Error ? e.message : 'Failed to save');
      });
  };

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h2 className="settings-card-title">{PROVIDER_LABELS[provider]}</h2>
        {settings.configured ? (
          <span className="chip chip-status-solved mono" title="A key is configured">
            {settings.masked ?? 'configured'}
          </span>
        ) : (
          <span className="chip chip-status-not-attempted">not configured</span>
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
      </div>
      <div className="settings-row">
        <input
          className="key-input mono"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Base URL (optional)"
          value={baseValue}
          onChange={(e) => {
            setBaseValue(e.target.value);
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
          disabled={state === 'saving' || (!keyDirty && !baseDirty)}
        >
          {state === 'saving' ? 'Validating…' : 'Save'}
        </button>
        {state === 'ok' && (
          <span className="save-ok" title="Validated and saved">
            ✓ saved
          </span>
        )}
      </div>
      {error != null && <div className="error-note">{error}</div>}
      <p className="settings-hint">
        Both fields save together: the key is validated against the base URL before either is
        written to your global ace config. Leave the base URL empty for the official API, or point
        it at a local proxy (e.g. <code>http://localhost:4242/v1</code>). The full key is never sent
        back to this page.
      </p>
    </section>
  );
}
