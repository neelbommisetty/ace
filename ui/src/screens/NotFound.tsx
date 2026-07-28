import { Link } from 'react-router';

export function NotFound({ message }: { message?: string }) {
  return (
    <div className="notfound">
      <div className="notfound-code mono">404</div>
      <p className="notfound-message">{message ?? 'This page does not exist.'}</p>
      <Link className="btn btn-accent" to="/">
        ← Back to Library
      </Link>
    </div>
  );
}
