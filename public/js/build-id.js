// One build identifier shared by the page shell (bundled into cockpit.js at build time) and
// the app code (loaded at run time). If they differ, the phone mixed a fresh page with a
// stale cached app file; the shell then refreshes these files and reloads once.
// Change BUILD whenever any file in public/js changes.
export const BUILD = '2026-11-26.4';
// every module the app loads (kept equal to the offline cache list; checked by a test)
export const MODULES = ['app.js', 'analytics.js', 'obd.js', 'sensors.js', 'charts.js', 'db.js', 'reports.js', 'air-quality.js',
  'evidence-location.js', 'evidence-analysis.js', 'trip.js', 'wrongside-watch.js', 'ytplayer.js', 'dashcam.js', 'hazards.js',
  'ai-models.js', 'ride-reports.js', 'voice.js', 'build-id.js', 'places.js', 'select.js'];
