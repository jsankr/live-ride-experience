// Browser sensor bindings: motion (accelerometer + gyro), GPS, screen wake lock.

export async function requestMotionPermission() {
  // iOS 13+ requires an explicit user-gesture permission request
  const DM = window.DeviceMotionEvent;
  if (DM && typeof DM.requestPermission === 'function') {
    const r = await DM.requestPermission();
    if (r !== 'granted') throw new Error('Motion permission denied');
  }
}

export function startMotion(onSample) {
  if (!('DeviceMotionEvent' in window)) throw new Error('This device/browser has no motion sensors');
  const origin = performance.timeOrigin;
  const handler = (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const r = e.rotationRate;
    // rotationRate: alpha = about z, beta = about x, gamma = about y (deg/s)
    const gyro = r && r.alpha != null ? { x: r.beta, y: r.gamma, z: r.alpha } : null;
    onSample(Math.round(origin + e.timeStamp), { x: a.x, y: a.y, z: a.z }, gyro);
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}

export function startGps(onFix, onError) {
  if (!navigator.geolocation) throw new Error('Geolocation not available');
  const id = navigator.geolocation.watchPosition(
    (p) => onFix(p.timestamp, {
      lat: p.coords.latitude, lon: p.coords.longitude,
      alt: p.coords.altitude, altitudeAccuracy: p.coords.altitudeAccuracy,
      speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy,
    }),
    (e) => onError?.(e),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

let wakeLock = null, wantAwake = false;
document.addEventListener('visibilitychange', async () => {
  // the lock is dropped whenever the page is hidden; re-take it on return
  if (wantAwake && document.visibilityState === 'visible') { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
});
export async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not fatal */ }
}
