// Speed from GPS that reads 0 when you are not moving.
//
// Why: a phone that is standing still still sees its GPS position wander by a few metres
// from fix to fix (more indoors, under trees, or next to buildings), and its Doppler speed
// reads a few tenths of a metre per second. Dividing that wander by the time between fixes
// gave ~3-10 km/h while sitting with the phone, and every wander over 5 m added distance.
//
// How: decide "moving" from where you actually got to over the last few seconds, compared
// with what the GPS's own stated accuracy allows for noise, with hysteresis so a reading at
// a signal does not flicker. Only while moving is a speed reported (the phone's Doppler
// speed when it gives one: accurate when moving) and distance added.
const R = 6371000, D2R = Math.PI / 180;
const haversine = (a, b) => {
  const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export function createSpeedFilter({
  windowMs = 6000,     // look back this far to see where we actually got to
  startDoppler = 1.4,  // m/s (5 km/h): the phone's own speed must reach this to count as moving...
  stopDoppler = 0.6,   // ...and fall below this (2 km/h) to count as stopped
  minNetM = 8,         // never call fewer metres than this "moved", however good the accuracy says it is
  maxAccM = 60,        // fixes worse than this are too vague to judge motion from
} = {}) {
  const hist = []; // { t, lat, lon, acc }
  let moving = false, last = null, posSpeed = null, streak = 0, dStreak = 0;
  return function update(t, fix) {
    const acc = Number.isFinite(fix.accuracy) && fix.accuracy > 0 ? fix.accuracy : 25;
    const doppler = Number.isFinite(fix.speed) && fix.speed >= 0 && fix.speed < 100 ? fix.speed : null;
    const prev = last;
    let stepM = 0, jump = false;
    if (prev) {
      const d = haversine(prev, fix), dt = (t - prev.t) / 1000;
      jump = dt > 0 && d / dt > 100; // over 360 km/h: the GPS jumped, we did not
      stepM = jump ? 0 : d;
    }
    if (jump) hist.length = 0; // start judging afresh from the new position
    if (acc <= maxAccM) hist.push({ t, lat: fix.lat, lon: fix.lon, acc });
    while (hist.length > 2 && t - hist[0].t > windowMs) hist.shift();
    last = { t, lat: fix.lat, lon: fix.lon };

    const first = hist[0];
    const spanS = first ? (t - first.t) / 1000 : 0;
    // Where we were in the older half of the window against the newer half: averaging the
    // fixes in each half cancels most random wander; real travel does not average away.
    let net = 0, noise = Infinity, gapS = 0;
    if (hist.length >= 3 && spanS > 0) {
      const mid = first.t + (t - first.t) / 2;
      const a = hist.filter((h) => h.t <= mid), b = hist.filter((h) => h.t > mid);
      const mean = (xs, k) => xs.reduce((s2, h) => s2 + h[k], 0) / xs.length;
      if (a.length && b.length) {
        const ca = { lat: mean(a, 'lat'), lon: mean(a, 'lon') }, cb = { lat: mean(b, 'lat'), lon: mean(b, 'lon') };
        net = haversine(ca, cb); gapS = (mean(b, 't') - mean(a, 't')) / 1000;
        noise = Math.max(minNetM, Math.hypot(mean(a, 'acc') / Math.sqrt(a.length), mean(b, 'acc') / Math.sqrt(b.length)) * 2.5);
      }
    }
    posSpeed = gapS >= 1 ? net / gapS : null;
    const movedNow = spanS >= 2 && net > noise;
    streak = movedNow ? streak + 1 : 0;
    const clearlyMoved = streak >= 2; // twice in a row, not one lucky pair of fixes
    const clearlyStill = spanS >= 3 && net < noise * 0.4;

    if (doppler == null) dStreak = 0;
    if (doppler != null) {
      // one high reading can be a glitch; three in a row, or one backed by real travel, is motion
      dStreak = doppler >= startDoppler ? dStreak + 1 : 0;
      if (!moving && ((dStreak >= 2 && !clearlyStill) || (dStreak >= 1 && clearlyMoved))) moving = true; // the position must not say we stayed put
      else if (moving && (doppler < stopDoppler || (clearlyStill && doppler < startDoppler))) moving = false;
    } else {
      if (!moving && clearlyMoved) moving = true;
      else if (moving && clearlyStill) moving = false;
    }
    const speed = moving ? (doppler ?? posSpeed ?? 0) : 0;
    return { speed, moving, stepM: moving ? stepM : 0, jump, accuracy: acc };
  };
}
