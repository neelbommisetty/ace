export function ConflictBanner({
  fileName,
  onReload,
  onKeepMine,
}: {
  fileName: string;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-text">
        <strong>{fileName}</strong> changed on disk while you have unsaved edits.
      </span>
      <span className="conflict-actions">
        <button className="btn btn-small" onClick={onReload} title="Discard your buffer and load the disk version">
          Reload
        </button>
        <button className="btn btn-small btn-accent" onClick={onKeepMine} title="Overwrite the disk version with your buffer">
          Keep mine
        </button>
      </span>
    </div>
  );
}
