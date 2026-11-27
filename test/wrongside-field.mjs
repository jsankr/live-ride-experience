// Field model of the wrong-side watcher, for measuring catch rate and false alerts.
// A vehicle is projected through the real watch geometry (portrait phone video, the
// watched crop squeezed into the detector's 300 px input); the detector only sees it once
// it is big enough there, then with box jitter, missed frames and person/bike flicker.
import { createWrongSideTracker, watchRegion, REAL_WIDTH_M, REAL_HEIGHT_M } from '../public/js/wrongside-watch.js';

export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// vw x vh: the camera stream (portrait 4K by default); fovDeg: horizontal FOV of that stream
export function fieldRun({ seed = 1, own, other, lateral, cls = 'motorcycle', realW, realH, rider = cls === 'motorcycle', lamp = other > 0 && cls === 'motorcycle' ? 0.5 : 0.03, start = 45,
  vw = 2160, vh = 3840, fovDeg = 48, camH = 1.1, checksPerS = 3, tiles = null, tracker = null, trackerOpts = {}, minPx = 14 }) {
  const r = rng(seed);
  const g = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const tr = tracker || createWrongSideTracker({ keep: 'left', ...trackerOpts });
  tr.config.fovDeg = fovDeg;
  const f = vw / (2 * Math.tan((fovDeg * Math.PI) / 360));
  const horizon = vh * 0.42;
  const W = realW ?? REAL_WIDTH_M[cls], H = realH ?? REAL_HEIGHT_M[cls];
  const regions = tiles || [watchRegion('left', vw, vh)];
  const alerts = [];
  const closing = (own + other) / 3.6;
  let t = r() * 0.3;
  for (let d = start; d > 2.5 && t < 25; ) {
    // vehicle box in full video pixels (tyres on the road below the horizon)
    const w = (W / d) * f, h = (H / d) * f, cx = vw / 2 + (lateral / d) * f, bottom = horizon + (camH / d) * f;
    const truth = [cx - w / 2, bottom - h, w, h];
    const dets = [];
    for (const [rx, ry, rw, rh] of regions) {
      const k = 300 / Math.max(rw, rh); // detector input scale
      const px = Math.min(w, h * 0.7) * k;
      const inside = truth[0] + w > rx && truth[0] < rx + rw && truth[1] + h > ry && truth[1] < ry + rh;
      if (!inside) continue;
      const p = px < minPx ? 0 : Math.min(0.9, 0.25 + (px - minPx) / 20);
      if (r() > p) continue; // missed this frame
      const j = 0.06 + 0.08 * Math.max(0, (30 - px) / 30); // small boxes jitter more
      const bw = w * (1 + g() * j), bh = h * (1 + g() * j);
      const bx = truth[0] + (w - bw) / 2 + g() * w * j * 0.5, by = truth[1] + (h - bh) + g() * h * j * 0.3;
      // clip to the tile
      const x0 = Math.max(rx, bx), y0 = Math.max(ry, by), x1 = Math.min(rx + rw, bx + bw), y1 = Math.min(ry + rh, by + bh);
      // headlamp seen in the full-resolution frame: often for a running two-wheeler facing us
      // (daylight washes some out), almost never for a parked one (a reflection now and then)
      const det = { class: cls, score: 0.3 + 0.5 * Math.min(1, px / 60), bbox: [x0, y0, x1 - x0, y1 - y0], tile: [rx, ry, rw, rh], lit: cls === 'motorcycle' && w > 24 ? r() < lamp : null };
      if (cls === 'motorcycle' && rider) {
        const flick = r();
        if (flick < 0.2) det.class = 'person';
        else if (flick < 0.7) dets.push({ class: 'person', score: 0.6, bbox: [det.bbox[0] + det.bbox[2] * 0.15, det.bbox[1] - det.bbox[3] * 0.1, det.bbox[2] * 0.7, det.bbox[3] * 0.65], tile: det.tile });
      }
      dets.push(det);
    }
    const ownSeen = own + g() * 1.5; // GPS speed noise
    alerts.push(...tr.update(t * 1000, dets, vw, vh, Math.max(0, ownSeen), regions.length === 1 ? regions[0] : undefined));
    const dt = 1 / checksPerS * (0.8 + 0.4 * r());
    t += dt; d -= closing * dt;
  }
  return alerts;
}

// catch rate over typical Chennai wrong-side riders, and false alerts over things that must not fire
export function survey(opts = {}) {
  const res = { caught: 0, total: 0, falseAlerts: 0, negatives: 0, misses: [], fps: [] };
  let seed = 1;
  for (const own of [20, 30, 40, 50, 60]) for (const other of [10, 15, 20, 25, 30]) for (const lateral of [-0.6, -1.4, -2.2]) {
    for (let rep = 0; rep < 2; rep++) {
      res.total++;
      const a = fieldRun({ seed: seed++, own, other, lateral, ...opts });
      if (a.length) res.caught++; else res.misses.push(`${own}/${other}/${lateral}`);
    }
  }
  const neg = (o) => { res.negatives++; const a = fieldRun({ seed: seed++, ...o, ...opts }); if (a.length) { res.falseAlerts++; res.fps.push(JSON.stringify({ ...o, alert: { oncomingKmh: a[0].oncomingKmh, d: a[0].distanceM } })); } };
  for (const own of [20, 30, 40, 50, 60]) {
    for (const [w, h] of [[0.6, 1.1], [0.7, 1.15], [0.85, 1.2]]) for (const lateral of [-1.6, -2.4]) {
      neg({ own, other: 0, lateral, realW: w, realH: h, rider: false });            // parked scooter
      neg({ own, other: 0, lateral, realW: w, realH: h + 0.45, rider: true });      // someone sitting on a parked scooter
      neg({ own, other: 0, lateral, realW: w, realH: h + 0.45, rider: true, lamp: 0.5 }); // ...with the engine idling, lamp on
    }
    for (const other of [-10, -20]) if (own + other > 3) neg({ own, other, lateral: -1.5 });    // slower rider we overtake
    neg({ own, other: 25, lateral: 3.2 });                                         // normal oncoming lane
    neg({ own, other: 25, lateral: 2.2 });
  }
  return res;
}
