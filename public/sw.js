// Offline shell: the app keeps working on roads with no signal.
const CACHE = 'ridelens-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/analytics.js', 'js/obd.js', 'js/sensors.js', 'js/charts.js', 'js/db.js', 'js/reports.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  // network first for our files (fresh code), cache fallback offline; cache-first for map tiles & CDN libs
  const sameOrigin = url.origin === location.origin;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!sameOrigin) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok && (url.hostname.endsWith('tile.openstreetmap.org') || url.hostname === 'unpkg.com')) cache.put(e.request, res.clone());
      return res;
    }
    try { const res = await fetch(e.request); if (res.ok) cache.put(e.request, res.clone()); return res; }
    catch { return (await cache.match(e.request)) || (await cache.match('index.html')); }
  })());
});
