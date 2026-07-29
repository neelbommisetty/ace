import './monaco';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/400-italic.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { clearStaleReloadGuard, triggerStaleReload } from './stale-reload';

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

// Reaching this point means the current bundle loaded and rendered
// successfully, so any stale-reload guard from an earlier recovery no
// longer applies — clear it so a later rebuild can trigger its own reload.
clearStaleReloadGuard(window.sessionStorage);
