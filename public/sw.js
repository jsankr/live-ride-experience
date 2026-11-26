// Offline shell: the app keeps working on roads with no signal.
const CACHE_PREFIX = `ridelens:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v20`;
const SHELL = ['./', 'index.html', 'styles.css', 'cockpit.css', 'js/cockpit.js', 'leaflet/leaflet.css',
  'leaflet/images/layers.png', 'leaflet/images/layers-2x.png', 'leaflet/images/marker-icon.png', 'leaflet/images/marker-icon-2x.png', 'leaflet/images/marker-shadow.png', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/analytics.js', 'js/obd.js', 'js/sensors.js', 'js/charts.js', 'js/db.js', 'js/reports.js', 'js/air-quality.js', 'js/evidence-location.js', 'js/evidence-analysis.js', 'js/trip.js', 'js/wrongside-watch.js', 'js/ytplayer.js', 'js/dashcam.js', 'js/hazards.js', 'js/ai-models.js', 'js/ride-reports.js', 'js/voice.js', 'js/build-id.js', 'js/places.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE && k !== `${CACHE_PREFIX}models`).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.hostname === 'api.open-meteo.com' || url.hostname === 'air-quality-api.open-meteo.com') return;
  // network first for our files (fresh code), cache fallback offline; cache-first for map tiles, CDN libs & web fonts
  const sameOrigin = url.origin === location.origin;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!sameOrigin) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok && (url.hostname.endsWith('tile.openstreetmap.org') || url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com')) cache.put(e.request, res.clone());
      return res;
    }
    // AI model files are large and versioned by name: download once, then serve from the phone
    if (url.pathname.includes('/models/')) {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(`${CACHE_PREFIX}models`)).put(e.request, res.clone());
      return res;
    }
    // always revalidate with the server (ETag): never serve a file the browser's HTTP cache
    // kept, or a fresh page can run with stale code
    try { const res = await fetch(e.request, { cache: 'no-cache' }); if (res.ok) cache.put(e.request, res.clone()); return res; }
    catch { return (await cache.match(e.request)) || (await cache.match('index.html')); }
  })());
});
