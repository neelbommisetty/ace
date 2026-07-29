import './monaco';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/400-italic.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { scheduleGuardClear, triggerStaleReload } from './stale-reload';

// A rebuild rewrites dist/assets with new content hashes; an already-open
// tab still requests lazy chunks under the old hashed names and Vite fires
// this event for the failed dynamic import(). Reload once to pick up the
// fresh bundle instead of leaving the tab silently broken — see
// stale-reload.ts for why this is a one-shot guard rather than an
// unconditional reload.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  triggerStaleReload(window.sessionStorage, () => window.location.reload());
});

const root = document.getElementById('root');
if (root == null) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The current bundle loaded and rendered, but that alone doesn't prove
// recovery: a restored .ts question still has to construct Monaco workers
// asynchronously, and a genuinely-missing chunk needs the chance to fail
// (and re-set the guard) before we clear it — see scheduleGuardClear.
scheduleGuardClear(window.sessionStorage, window, setTimeout);
