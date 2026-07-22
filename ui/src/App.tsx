import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { getToken, setUnauthorizedHandler } from './api';
import { Toast } from './components/Toast';
import { consumeSuppressForReset, isSuppressArmed } from './lib/resetSuppress';
import { History } from './screens/History';
import { Library } from './screens/Library';
import { NewQuestion } from './screens/NewQuestion';
import { NotFound } from './screens/NotFound';
import { Room } from './screens/Room';
import { Settings } from './screens/Settings';
import { useSseEvent } from './sse';

// Epoch of the first `hello` seen since page load. A later `hello` (i.e.
// after an SSE reconnect) carrying a different epoch means a workspace
// reset happened while this tab was disconnected and missed the one-shot
// `workspace-reset` broadcast entirely — treated identically to receiving
// that event directly. The epoch itself is persisted in the server's db
// (see session.ts's `resolveEpoch`), so it only ever changes when a reset
// genuinely swaps in a new db — a plain server restart reopens the same db
// and reports the same epoch, so it does NOT trip this fallback.
let lastHelloEpoch: string | null = null;

/** Sends this tab back to a fresh Library — used for every reset signal this tab did not itself initiate. */
function forceReloadToLibrary(): void {
  location.replace('/');
}

export function App() {
  const [authFailed, setAuthFailed] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthFailed(true));
    return () => setUnauthorizedHandler(() => {});
  }, []);

  useSseEvent('workspace-reset', ({ requestId }) => {
    // The tab that initiated this exact reset armed a matching id (see
    // lib/resetSuppress.ts) so its dialog can show the "done" state instead
    // of being reloaded out from under itself. A broadcast for a DIFFERENT
    // tab's reset (requestId won't match, possibly because it never armed
    // one at all) falls through to the normal reload, same as any other
    // passive tab.
    if (consumeSuppressForReset(requestId)) return;
    forceReloadToLibrary();
  });

  useSseEvent('hello', ({ epoch }) => {
    if (lastHelloEpoch == null) {
      lastHelloEpoch = epoch;
      return;
    }
    if (epoch !== lastHelloEpoch) {
      lastHelloEpoch = epoch;
      // No per-request id travels on `hello`, so this can't be matched to a
      // specific in-flight request the way `workspace-reset` broadcasts are
      // — "something is armed" (this tab itself has a reset in flight) is
      // used as a proxy instead. See lib/resetSuppress.ts.
      if (isSuppressArmed()) return;
      forceReloadToLibrary();
    }
  });

  if (getToken() == null || authFailed) {
    return <TokenNotice expired={authFailed} />;
  }

  return (
    <BrowserRouter>
      <div className="app-shell">
        <IconRail />
        <div className="app-main">
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/new" element={<NewQuestion />} />
            <Route path="/q/:category/:slug" element={<Room />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </div>
      <Toast />
    </BrowserRouter>
  );
}

function TokenNotice({ expired }: { expired: boolean }) {
  return (
    <div className="token-screen">
      <div className="token-card">
        <div className="rail-logo">A</div>
        <h1>{expired ? 'Token expired' : 'Token missing'}</h1>
        <p>
          This page needs the access token printed by the CLI. Relaunch with{' '}
          <code>ace ui</code> and open the URL it prints (it carries <code>?t=…</code>).
        </p>
      </div>
    </div>
  );
}

function IconRail() {
  const location = useLocation();

  return (
    <nav className="rail">
      <div className="rail-logo" title="ACE">
        A
      </div>
      <Link
        className={`rail-icon ${location.pathname === '/' ? 'active' : ''}`}
        to="/"
        title="Library"
      >
        <HomeIcon />
      </Link>
      <div className="rail-spacer" />
      <Link
        className={`rail-icon ${location.pathname.startsWith('/history') ? 'active' : ''}`}
        to="/history"
        title="History"
      >
        <ClockIcon />
      </Link>
      <span className="rail-icon rail-icon-dim" title="Stats — coming in M3">
        <ChartIcon />
      </span>
      <Link
        className={`rail-icon ${location.pathname.startsWith('/settings') ? 'active' : ''}`}
        to="/settings"
        title="Settings"
      >
        <GearIcon />
      </Link>
    </nav>
  );
}

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-8" />
      <path d="M22 20H2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z" />
    </svg>
  );
}
