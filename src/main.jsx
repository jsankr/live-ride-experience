import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import { Shell } from './Shell.jsx';
import { BUILD, MODULES } from '../public/js/build-id.js';

// The ride controller binds once to the React shell after its DOM is available.
window.L = L;
const root = createRoot(document.getElementById('app'));
flushSync(() => root.render(<Shell />));
window.__RIDELENS_SHELL_BUILD = BUILD;
import('./app.js').catch(() => {}).then(() => {
  if (window.__RIDELENS_APP_BUILD === BUILD) return;
  // Stale app code under a fresh page (browser HTTP cache kept the old file for up to
  // 10 min). Refresh every module past the cache, then reload once.
  let tried = false;
  try { tried = sessionStorage.getItem('ridelens.reloadFor') === BUILD; sessionStorage.setItem('ridelens.reloadFor', BUILD); } catch {}
  if (tried) return;
  Promise.all(MODULES.map((m) => fetch(`js/${m}`, { cache: 'reload' }).catch(() => null)))
    .then(() => navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => null))
    .finally(() => location.reload());
});
