import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import { Shell } from './Shell.jsx';

// The ride controller binds once to the React shell after its DOM is available.
window.L = L;
const root = createRoot(document.getElementById('app'));
flushSync(() => root.render(<Shell />));
import('./app.js');
