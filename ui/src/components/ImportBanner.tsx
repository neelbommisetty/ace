import { useEffect, useState } from 'react';
import { getImportPreview, runImport } from '../api';
import { categoryShortName } from '../lib/categories';
import type { ImportPreviewItem, ImportResult } from '../types';

export function ImportBanner({
  questionCount,
  onImported,
}: {
  questionCount: number;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="import-banner">
        <span>
          Legacy scorecard data found — <strong>{questionCount}</strong>{' '}
          {questionCount === 1 ? 'question' : 'questions'} with history can be imported.
        </span>
        <button className="btn btn-small btn-accent" onClick={() => setOpen(true)}>
          Preview import
        </button>
      </div>
      {open && (
        <ImportModal
          onClose={() => setOpen(false)}
          onImported={() => {
            setOpen(false);
            onImported();
          }}
        />
      )}
    </>
  );
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [items, setItems] = useState<ImportPreviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    getImportPreview()
      .then(({ items: got }) => {
        if (!cancelled) setItems(got);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load preview');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  const newCount = items?.filter((i) => !i.alreadyImported).length ?? 0;
  const doneCount = (items?.length ?? 0) - newCount;

  const handleRun = () => {
    setRunning(true);
    setError(null);
    runImport()
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Import failed'))
      .finally(() => setRunning(false));
  };

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import legacy history</h2>
          <button className="icon-btn" onClick={onClose} disabled={running} title="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="error-note">{error}</div>}
          {result ? (
            <div className="import-result">
              <p>Import complete.</p>
              <ul>
                <li>
                  <strong>{result.questionsImported}</strong> questions imported
                </li>
                <li>
                  <strong>{result.attemptsCreated}</strong> attempts created
                </li>
                <li>
                  <strong>{result.reviewsCreated}</strong> reviews created
                </li>
                <li>
                  <strong>{result.skipped}</strong> skipped
                </li>
              </ul>
            </div>
          ) : items == null ? (
            !error && <div className="modal-loading">Loading preview…</div>
          ) : items.length === 0 ? (
            <div className="modal-loading">Nothing to import.</div>
          ) : (
            <>
              <p className="import-counts">
                {items.length} {items.length === 1 ? 'question' : 'questions'} ·{' '}
                <strong>{newCount}</strong> new · {doneCount} already imported
              </p>
              <div className="table-wrap modal-table-wrap">
                <table className="question-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Category</th>
                      <th className="num">Attempts</th>
                      <th>Feedback</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={`${item.category}/${item.slug}`}>
                        <td className="cell-title">{item.title}</td>
                        <td>
                          <span className="chip chip-category">
                            {categoryShortName(item.category)}
                          </span>
                        </td>
                        <td className="num mono">{item.legacyAttempts}</td>
                        <td className="cell-dim">{item.hasFeedback ? 'yes' : '—'}</td>
                        <td className="cell-dim">
                          {item.alreadyImported ? 'already imported' : 'new'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          {result ? (
            <button className="btn btn-accent" onClick={onImported}>
              Done
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={running}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                onClick={handleRun}
                disabled={running || items == null || items.length === 0}
              >
                {running ? 'Importing…' : 'Run import'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
