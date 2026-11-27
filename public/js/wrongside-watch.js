// Hands-free wrong-side detection.
//
// Pure tracking/decision logic (createWrongSideTracker) is DOM-free and unit-tested.
// The browser loop (startAutoWatch) feeds it COCO-SSD detections from the live camera.
//
// How a vehicle is judged "wrong side" (all estimates, never certainties):
//  1. Distance from apparent size. Cars, buses and trucks use box HEIGHT: their box width
//     includes the side of the vehicle once it is off to one side, and that side grows
//     faster than the rear as we close in, which made slower traffic we overtake on the
//     left look like it was coming at us. Two-wheelers use box WIDTH (narrow head-on,
//     and the box height changes when the rider is or is not part of the detection).
//  2. Closing speed from a robust (median-of-slopes) fit of distance over ≥3 sightings.
//  3. "Oncoming" when it closes faster than the rider is moving by more than the size
//     guess could be wrong by (a tempo and a lorry are both "truck" to the detector).
//  4. "In our lane" from the lateral offset in metres at that distance:
//     keep-left traffic (India) → oncoming traffic belongs on our right; an oncoming
//     vehicle at or left of our line of travel is on the wrong side.
//  5. A car, bus or truck showing red tail lamps on both sides is seen from behind and is
//     never flagged, whatever the numbers say.
// Every trigger is saved as "suspected" with the numbers behind it for human review.

export const REAL_WIDTH_M = { car: 1.75, motorcycle: 0.75, bicycle: 0.55, person: 0.5, bus: 2.55, truck: 2.0 };
export const REAL_HEIGHT_M = { car: 1.55, bus: 3.1, truck: 2.4, motorcycle: 1.6, bicycle: 1.6, person: 1.6 };
// Smallest real size a vehicle of the class can have (height for 4w, width for 2w).
// A PARKED vehicle smaller than the class average looks nearer than it is, so its distance
// seems to shrink faster than we ride and it passes for oncoming: a hatchback, an auto
// rickshaw (the detector calls it "truck") or a scooter. Deciding with the smallest size
// means a parked vehicle of any plausible size reads as closing no faster than we ride.
export const MIN_SIZE_M = { car: 1.4, bus: 2.9, truck: 1.65, motorcycle: 0.6, bicycle: 0.45, person: 0.4 };
export const LABELS = { motorcycle: 'Two-wheeler', car: 'Car', bus: 'Bus', truck: 'Truck / tempo', bicycle: 'Cycle', person: 'Two-wheeler' };
const GROUP = { car: '4w', bus: '4w', truck: '4w', motorcycle: '2w', bicycle: '2w', person: '2w' };
// small, head-on two-wheelers score low on COCO-SSD; the tracking checks protect precision
export const MIN_SCORE = { car: 0.45, bus: 0.45, truck: 0.45, motorcycle: 0.3, bicycle: 0.3, person: 0.4 };
const WHEELS = new Set(['motorcycle', 'bicycle']);
export const WHEEL_CATEGORY = { motorcycle: 'Two-wheeler', bicycle: 'Two-wheeler', person: 'Two-wheeler', car: 'Four-wheeler', bus: 'Heavy vehicle', truck: 'Four-wheeler or heavier' };

// Overlap measured against the SMALLER box: an approaching vehicle's box can grow
// several-fold between checks, which plain IoU would treat as a different vehicle.
export const overlap = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
};
const union = (a, b) => {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};

// A head-on two-wheeler is often detected as a person, a motorcycle, or both. Merge a
// rider into the bike under them, so one vehicle is one track whatever the detector says.
export function mergeRiders(detections) {
  const out = detections.filter((d) => GROUP[d.class] && d.class !== 'person').map((d) => ({ ...d }));
  for (const p of detections.filter((d) => d.class === 'person')) {
    const pcx = p.bbox[0] + p.bbox[2] / 2;
    const bike = out.find((d) => WHEELS.has(d.class) && overlap(d.bbox, p.bbox) > 0.25 && pcx >= d.bbox[0] && pcx <= d.bbox[0] + d.bbox[2]);
    if (bike) { bike.bbox = union(bike.bbox, p.bbox); bike.score = Math.max(bike.score, p.score); bike.withRider = true; bike.clipped = bike.clipped || p.clipped; }
    else out.push({ ...p });
  }
  return out;
}

// The same vehicle found in two overlapping tiles is one vehicle: keep the box that is not
// cut off by its tile's edge (or the higher score), so it does not start a second track.
export function dedupeTiles(dets, clippedOf = () => false) {
  const out = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    const c = clippedOf(d.bbox, d.tile);
    const same = out.find((o) => GROUP[o.class] === GROUP[d.class] && o.tile !== d.tile && overlap(o.bbox, d.bbox) > 0.5);
    if (!same) { out.push({ ...d, clipped: d.clipped ?? c }); continue; }
    if (same.clipped && !c) Object.assign(same, d, { clipped: false });
    same.withRider = same.withRider || d.withRider;
  }
  return out;
}

// Red tail-lamp check on a small RGBA sample of a vehicle box ({ data, width, height }).
// Rear view: red on BOTH outer sides of the box and little in the middle (a red car or a
// red bus front is red all over, so it is not called "rear").
export function tailLightScore({ data, width, height }) {
  const cnt = { left: [0, 0], right: [0, 0], middle: [0, 0] };
  for (let y = Math.floor(height * 0.12); y < Math.ceil(height * 0.8); y++) {
    for (let x = 0; x < width; x++) {
      const fx = x / width;
      const zone = fx < 0.3 ? 'left' : fx >= 0.7 ? 'right' : fx >= 0.38 && fx < 0.62 ? 'middle' : null;
      if (!zone) continue;
      const i = (y * width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      cnt[zone][1]++;
      if (r > 95 && r > 1.45 * g && r > 1.25 * b) cnt[zone][0]++; // daylight tail lamps photograph pinkish
    }
  }
  const f = (z) => cnt[z][0] / (cnt[z][1] || 1);
  return { left: f('left'), right: f('right'), middle: f('middle') };
}
export const looksLikeRear = (s) => s.left >= 0.012 && s.right >= 0.012 && s.middle < 0.6 * Math.min(s.left, s.right) && s.middle < 0.15;

// Headlamp check on a small RGBA sample of a two-wheeler box ({ data, width, height }).
// Indian two-wheelers made since April 2017 keep the headlamp on whenever the engine runs
// (AHO), so one coming at us shows a small, near-white blob in the middle of its front; a
// parked one does not. A white body panel in the sun is bright all over, so the blob must be
// compact and brighter than the rest of the box.
export function headlampScore({ data, width, height }) {
  let cB = 0, cN = 0, oB = 0, oN = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, bright = Math.min(data[i], data[i + 1], data[i + 2]) >= 232;
    const fx = x / width, fy = y / height;
    if (fx >= 0.3 && fx < 0.7 && fy >= 0.25 && fy < 0.75) { cN++; if (bright) cB++; } else { oN++; if (bright) oB++; }
  }
  return { centre: cB / (cN || 1), outer: oB / (oN || 1) };
}
export const looksLit = (s) => s.centre >= 0.015 && s.centre <= 0.3 && s.centre > 2.5 * s.outer;

function fit(points, noiseFrac = 0) { // distance over time (seconds): median-of-slopes, and how well a straight line explains it
  const n = points.length;
  const slopes = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (points[j].t > points[i].t) slopes.push((points[j].d - points[i].d) / (points[j].t - points[i].t));
  slopes.sort((a, b) => a - b);
  const slope = slopes.length ? slopes[Math.floor((slopes.length - 1) / 2)] / 2 + slopes[Math.ceil((slopes.length - 1) / 2)] / 2 : 0;
  const mt = points.reduce((s, p) => s + p.t, 0) / n, md = points.reduce((s, p) => s + p.d, 0) / n;
  let tot = 0, res = 0;
  for (const p of points) tot += (p.d - md) ** 2;
  const icpt = md - slope * mt;
  for (const p of points) res += (p.d - (icpt + slope * p.t)) ** 2;
  // standard error of the slope: with 3 jittery sightings it is large, with 6 steady ones small
  let stt = 0; for (const p of points) stt += (p.t - mt) ** 2;
  let se = n > 2 && stt ? Math.sqrt(res / (n - 2) / stt) : Infinity;
  // Three points can line up by chance, so never trust the fit more than the boxes allow:
  // a detector box is good to about ±noiseFrac of the distance, which is worse far away.
  if (noiseFrac && stt) se = Math.max(se, (noiseFrac * md) / Math.sqrt(stt));
  return { slope, r2: tot ? 1 - res / tot : 0, se };
}

// The vehicle's own size, measured instead of assumed. Its tyres touch the road, so the
// bottom of its box sits camHeight·f/d below the horizon while its size in pixels is
// size·f/d: bottom = horizon + (camHeight/size)·sizePx. A straight-line fit of box bottom
// against box size over the track gives camHeight/size, i.e. its real size, whatever the
// detector calls it. Returns { sizeM, r2 } or null.
export function groundSize(obs, sizeOf, camHeightM) {
  const n = obs.length;
  if (n < 5) return null;
  const xs = obs.map(sizeOf), ys = obs.map((o) => o.box[1] + o.box[3]);
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!sxx || !syy || sxy <= 0) return null;
  if (Math.max(...xs) < 1.6 * Math.min(...xs)) return null; // too little change in distance to fit
  // Noise in box size flattens an ordinary least-squares slope, which would overstate the
  // size and make parked vehicles look oncoming. The reduced-major-axis slope does not
  // flatten; noise in the box bottom steepens it instead, which errs toward "parked".
  const b = Math.sqrt(syy / sxx);
  return { sizeM: camHeightM / b, r2: (sxy * sxy) / (sxx * syy), horizonY: my - b * mx };
}

export function createWrongSideTracker(options = {}) {
  const cfg = {
    fovDeg: 60,            // horizontal field of view of the video stream
    keep: 'left',          // which side traffic keeps to ('left' for India/UK, 'right' elsewhere)
    triggerDistanceM: 30,  // decide only once the vehicle is this close
    // Keep-left India: a wrong-side vehicle comes at us on OUR LEFT (between us and the kerb)
    // or dead ahead. Oncoming traffic on our right is legitimate and ignored.
    sideEdgeM: 0.2,        // max lateral offset toward the oncoming side (m) that still counts
    minOwnVelocityKmh: 12, // the vehicle's own speed toward us must exceed this...
    minOwnVelocityFrac: 0.25, // ...and this fraction of our speed when its size is only assumed
    measuredOwnVelocityFrac: 0.1, // ...or this fraction when its size was measured
    riderOnlyExtraKmh: 8,  // a rider seen without a bike must be clearly faster than a jogger
    maxOwnVelocityKmh: 140, // faster than this is a measurement glitch, not a vehicle
    minDistanceM: 4,       // closer than this the box is usually cut off by the picture edge
    minSightings: 4,       // seen at least this many times (13 of 15 false alerts on 27 Nov had only 3)...
    minSpanS: 0.5,         // ...over at least this long...
    minFitR2: 0.6,         // ...closing steadily (distances on a straight line, not jitter)
    // The vehicle's speed toward us must clear the threshold by this many standard errors.
    // 13 of the 15 false alerts on 27 Nov fired on the minimum 3 sightings: with so few
    // points, jitter alone makes some overtaken cars look like they are coming at us.
    confidenceZ: 1.0,
    boxNoiseFrac: 0.08,
    camHeightM: 1.1,       // phone lens height above the road (handlebar mount); refined from car tracks
    camHeightErr: 0.08,    // how wrong that height may be
    minGroundR2: 0.95,     // tyre-contact line must fit this well to trust the measured size    // typical box-size error on a moving bike (vibration + detector jitter)
    requireOwnSpeed: true, // without GPS speed we cannot tell oncoming from slower traffic
    riddenSizeK: 1.0,      // a ridden two-wheeler: its class's typical width...
    riddenMinKmh: 10,      // ...coming at us at least this fast...
    riddenOwnVelocityFrac: 0.22, // ...and this fraction of our speed (a person on a parked scooter at 60 km/h stays below)
    // headlamp on (AHO): it is running and facing us, the parked-scooter doubt is gone
    litMinKmh: 8,
    litOwnVelocityFrac: 0.15,
    litConfidenceZ: 0.4,
    confirmChecks: 1,      // consecutive checks that must agree before an alert
    minScore: MIN_SCORE,
    ...options,
  };
  const tracks = new Map();
  const speeds = []; // [t, km/h] of our own GPS speed, last few seconds
  // Lens height: starts at the configured value and is refined so the cars we measure come
  // out at the typical Indian car height (median of many, so one SUV does not move it).
  const carHeights = [];
  let camHeight = cfg.camHeightM;
  const refineCamHeight = () => {
    if (carHeights.length < 15) return;
    while (carHeights.length > 200) carHeights.shift();
    const med = [...carHeights].sort((a, b) => a - b)[carHeights.length >> 1];
    camHeight = Math.min(1.6, Math.max(0.7, camHeight * (REAL_HEIGHT_M.car / med)));
    carHeights.length = 0;
  };
  // where the horizon sits (fraction of frame height), learned from vehicles whose size was
  // measured from the road: the far tile is centred on it
  const horizons = [];
  let horizonFrac = null, frameHNow = 0;
  const noteHorizon = (gs) => {
    if (gs.horizonY == null || !frameHNow) return;
    horizons.push(gs.horizonY / frameHNow); if (horizons.length > 30) horizons.shift();
    if (horizons.length >= 5) horizonFrac = [...horizons].sort((a, b) => a - b)[horizons.length >> 1];
  };
  // vehicles that were on our side, close, and NOT flagged: kept so a ride report can show why
  const nearMisses = [];
  const noteEnded = (tr) => {
    const dcs = tr.decision;
    if (tr.fired || !dcs || dcs.reason === 'other lane' || dcs.reason === 'flagged') return;
    const minD = Math.min(...tr.obs.map((o) => o.d ?? Infinity));
    if (!(minD <= cfg.triggerDistanceM)) return;
    nearMisses.push({ ...dcs, minD: +minD.toFixed(1) });
    if (nearMisses.length > 40) nearMisses.shift();
  };
  let nextId = 1;
  const tanHalf = () => Math.tan((cfg.fovDeg * Math.PI) / 360);
  const scoreOk = (d) => d.score >= (typeof cfg.minScore === 'number' ? cfg.minScore : (cfg.minScore[d.class] ?? 0.45));

  // the class whose size is used for the whole track (a box's height does not change with
  // what the detector calls the vehicle, so one class per track keeps distances consistent)
  const trackClass = (tr) => {
    const counts = {};
    for (const o of tr.obs) if (tr.group === '4w' || WHEELS.has(o.cls)) counts[o.cls] = (counts[o.cls] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : tr.obs[tr.obs.length - 1].cls;
  };
  // distance (m) of one box, frame width fw: 4w by height, 2w by width of what was detected
  const distanceOf = (box, cls, group, fw) => {
    const f = fw / (2 * tanHalf());
    return group === '4w' ? (REAL_HEIGHT_M[cls] * f) / Math.max(box[3], 1) : (REAL_WIDTH_M[cls] * f) / Math.max(box[2], 1);
  };

  // region: [x, y, w, h] of the analysed crop in frame coordinates. A box touching its
  // edge is cut off, so its size (and the distance from it) is wrong.
  function update(tMs, detections, frameW, frameH, ownSpeedKmh = null, region = [0, 0, frameW, frameH]) {
    const edge = 0.015 * frameW;
    // a detection may carry the tile it was found in (several crops per check): its own edges
    const clippedBox = ([x, y, w, h], rg = region) => x <= rg[0] + edge || x + w >= rg[0] + rg[2] - edge
      || y <= rg[1] + edge || y + h >= rg[1] + rg[3] - edge;
    const t = tMs / 1000;
    if (ownSpeedKmh != null) speeds.push([t, ownSpeedKmh]);
    while (speeds.length && t - speeds[0][0] > 8) speeds.shift();
    const vehicles = dedupeTiles(mergeRiders(detections.filter((d) => GROUP[d.class] && scoreOk(d))), clippedBox);
    // Associate detections with tracks. Box overlap alone failed for exactly the vehicles we
    // want: a small rider coming at us on the left slides sideways by more than its own width
    // between checks, so every sighting started a new track and none reached 3 sightings.
    // Instead: predict where the box centre should be (constant image velocity), accept
    // anything within about one box size of that, and require a size change a real vehicle
    // could make in the time. Same group only (car↔truck and person↔motorcycle flips are
    // common). Pairs are matched cheapest first, so a nearer, better match wins.
    const centre = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
    const pairs = [];
    vehicles.forEach((det, di) => {
      const group = GROUP[det.class];
      const [nx, ny] = centre(det.bbox);
      for (const tr of tracks.values()) {
        if (tr.group !== group) continue;
        const dt = Math.max(0.05, t - tr.last.t);
        const [lx, ly] = centre(tr.last.box);
        let px = lx, py = ly;
        const prev = tr.obs[tr.obs.length - 2];
        if (prev && tr.last.t > prev.t) { const [qx, qy] = centre(prev.box), k = Math.min(2, dt / (tr.last.t - prev.t)); px += (lx - qx) * k; py += (ly - qy) * k; }
        const size = Math.max(tr.last.box[2], tr.last.box[3], det.bbox[2], det.bbox[3]);
        const miss = Math.hypot(nx - px, ny - py) / size;
        if (miss > 0.9 && overlap(tr.last.box, det.bbox) <= 0.5) continue;
        const cls = group === '4w' ? trackClass(tr) : null;
        const dOld = distanceOf(tr.last.box, cls ?? tr.last.cls, group, frameW), dNew = distanceOf(det.bbox, cls ?? det.class, group, frameW);
        const implied = (dOld - dNew) / dt; // m/s toward us
        if (implied > 75 || implied < -25) continue; // a different vehicle at the same spot
        pairs.push({ di, id: tr.id, cost: miss });
      }
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const takenDet = new Set(), takenTrack = new Set(), matchOf = new Map();
    for (const pr of pairs) {
      if (takenDet.has(pr.di) || takenTrack.has(pr.id)) continue;
      takenDet.add(pr.di); takenTrack.add(pr.id); matchOf.set(pr.di, pr.id);
    }
    vehicles.forEach((det, di) => {
      const obs = { t, box: det.bbox, cls: det.class, score: det.score, clipped: det.clipped ?? clippedBox(det.bbox, det.tile), rear: det.rear ?? null, rider: !!det.withRider, lit: det.lit ?? null };
      const id = matchOf.get(di);
      if (id != null) {
        const tr = tracks.get(id);
        tr.obs.push(obs); if (tr.obs.length > 12) tr.obs.shift();
        tr.last = obs;
      } else {
        const nid = nextId++;
        tracks.set(nid, { id: nid, group: GROUP[det.class], obs: [obs], last: obs, fired: false });
      }
    });
    frameHNow = frameH;
    for (const [id, tr] of tracks) if (t - tr.last.t > 1.5) { noteEnded(tr); tracks.delete(id); }
    for (const tr of tracks.values()) { // what the overlay and status show
      tr.cls = trackClass(tr);
      tr.last.d = distanceOf(tr.last.box, tr.group === '4w' ? tr.cls : tr.last.cls, tr.group, frameW);
      for (const o of tr.obs) o.d ??= distanceOf(o.box, tr.group === '4w' ? tr.cls : o.cls, tr.group, frameW);
      tr.last.lateral = ((tr.last.box[0] + tr.last.box[2] / 2) / frameW - 0.5) * 2 * tr.last.d * tanHalf();
    }

    const alerts = [];
    refineCamHeight();
    if (ownSpeedKmh == null && cfg.requireOwnSpeed) return alerts;
    for (const tr of tracks.values()) {
      if (tr.fired || tr.last.clipped) continue;
      const cls = tr.cls;
      const good = tr.obs.filter((o) => !o.clipped).map((o) => ({ ...o, d: distanceOf(o.box, tr.group === '4w' ? cls : o.cls, tr.group, frameW) }));
      if (good.length < cfg.minSightings) { tr.decision = { t, cls, sightings: good.length, reason: 'too few sightings' }; continue; }
      const span = good[good.length - 1].t - good[0].t;
      if (span < cfg.minSpanS) { tr.decision = { t, cls, sightings: good.length, reason: 'seen too briefly' }; continue; }
      const { slope, r2, se } = fit(good, cfg.boxNoiseFrac);
      if (r2 < cfg.minFitR2) { tr.decision = { t, cls, sightings: good.length, reason: 'unsteady approach' }; continue; }
      if (tr.group === '4w') { // tail lamps on both sides: we are looking at its back
        const checked = tr.obs.filter((o) => o.rear != null), rear = checked.filter((o) => o.rear).length;
        if (checked.length && rear >= Math.max(1, checked.length / 2)) { tr.vetoed = 'rear lamps'; tr.decision = { t, cls, sightings: good.length, reason: 'tail lamps (seen from behind)' }; continue; }
      }
      const riderOnly = tr.group === '2w' && !tr.obs.some((o) => WHEELS.has(o.cls));
      const closingKmh = -slope * 3.6;
      const own = ownSpeedKmh ?? 0;
      // GPS speed lags ~1 s: while we accelerate it reads low, and a parked car seems to
      // close faster than we ride. Use our highest speed over the track and the second before.
      const ownMax = speeds.filter(([ts]) => ts >= good[0].t - 1.5).reduce((m, [, v]) => Math.max(m, v), own);
      const ownVelocityKmh = closingKmh - own; // the other vehicle's own speed toward us (best guess)
      // Size used for distance: measured from the tyre-contact line when the fit is good
      // (then a parked vehicle of any size reads as parked), else the smallest plausible
      // size of its class (safe, but costs some real catches).
      const prior = (tr.group === '4w' ? REAL_HEIGHT_M : REAL_WIDTH_M)[cls] || 1;
      const sizePx = (o) => (tr.group === '4w' ? o.box[3] : o.box[2]);
      const gs = groundSize(good, sizePx, camHeight);
      const measured = gs && gs.r2 >= cfg.minGroundR2 && gs.sizeM > (MIN_SIZE_M[cls] ?? 0) * 0.6 && gs.sizeM < prior * 2.5;
      if (measured) noteHorizon(gs);
      // A two-wheeler seen WITH its rider on it in most sightings is being ridden: parked
      // scooters at the kerb are mostly riderless. Assuming the smallest scooter for those
      // (×0.8) meant a rider coming at us at 20 km/h while we rode at 40 was never flagged
      // (27 Nov 12:50 ride: 0 alerts). Ridden: the class's typical size and a smaller margin.
      const ridden = tr.group === '2w' && !riderOnly && tr.obs.filter((o) => o.rider).length >= Math.max(2, tr.obs.length * 0.4);
      // headlamp on, seen in at least 2 checks: its engine runs and we see its front
      const lit = tr.group === '2w' && tr.obs.filter((o) => o.lit).length >= 2;
      const easy = lit || ridden; // evidence it is moving, not parked
      const sizeK = measured ? (gs.sizeM / prior) * (1 - (lit ? 0 : cfg.camHeightErr)) : easy ? cfg.riddenSizeK : (MIN_SIZE_M[cls] ?? prior) / prior;
      if (measured && cls === 'car') carHeights.push(gs.sizeM);
      const ownVelocityMinKmh = closingKmh * sizeK - ownMax; // the least it can be: smallest size, highest own speed
      const last = good[good.length - 1];
      const lateral = ((tr.last.box[0] + tr.last.box[2] / 2) / frameW - 0.5) * 2 * last.d * tanHalf(); // m, + = right of our line
      const near = last.d <= cfg.triggerDistanceM && last.d >= cfg.minDistanceM;
      const towardOncoming = cfg.keep === 'left' ? lateral : -lateral;
      const inOurLane = towardOncoming <= cfg.sideEdgeM;
      // with the size measured, the size error is already in sizeK; keep a small margin only
      const frac = lit ? cfg.litOwnVelocityFrac : measured ? cfg.measuredOwnVelocityFrac : ridden ? cfg.riddenOwnVelocityFrac : cfg.minOwnVelocityFrac;
      const needed = Math.max((lit ? cfg.litMinKmh : ridden ? cfg.riddenMinKmh : cfg.minOwnVelocityKmh) + (ownSpeedKmh == null ? 7 : 0) + (riderOnly ? cfg.riderOnlyExtraKmh : 0), frac * ownMax);
      const sure = ownVelocityMinKmh - (lit ? cfg.litConfidenceZ : cfg.confidenceZ) * se * 3.6 * sizeK; // speed toward us we are fairly sure of
      // what decided, for the ride's diagnostics (why a vehicle on our side was NOT flagged)
      tr.decision = { t, cls, sightings: good.length, d: +last.d.toFixed(1), lateralM: +towardOncoming.toFixed(1), ownKmh: Math.round(ownMax),
        closingKmh: Math.round(closingKmh), sureKmh: Math.round(sure), neededKmh: Math.round(needed), ridden, lit, measured: !!measured,
        reason: !inOurLane ? 'other lane' : !near ? (last.d > cfg.triggerDistanceM ? 'still far' : 'too close') : sure < needed ? 'not clearly oncoming' : ownVelocityKmh > cfg.maxOwnVelocityKmh ? 'implausible speed' : 'flagged' };
      const pass = near && inOurLane && sure >= needed && ownVelocityKmh <= cfg.maxOwnVelocityKmh;
      // must hold on consecutive checks: one lucky fit on jittery boxes is not enough
      tr.passes = pass ? (tr.passes || 0) + 1 : 0;
      if (pass && tr.passes >= cfg.confirmChecks) {
        tr.fired = true;
        alerts.push({
          trackId: tr.id, vehicleClass: cls, type: LABELS[cls], category: WHEEL_CATEGORY[cls], box: tr.last.box,
          oncomingMinKmh: Math.round(ownVelocityMinKmh), sizeMeasured: measured ? +gs.sizeM.toFixed(2) : null,
          distanceM: +last.d.toFixed(1), lateralM: +towardOncoming.toFixed(1),
          closingKmh: Math.round(closingKmh), oncomingKmh: Math.round(ownVelocityKmh),
          ownSpeedKmh: ownSpeedKmh == null ? null : Math.round(ownSpeedKmh),
          score: +Math.max(...tr.obs.map((o) => o.score)).toFixed(2), sightings: good.length,
          fitR2: +r2.toFixed(2), spanS: +span.toFixed(1), riderOnly, ridden, headlamp: lit, uncertaintyKmh: Math.round(se * 3.6),
          // it closes faster than we move, so it is driving toward us: we should see its front
          direction: 'toward you', view: 'front',
        });
      }
    }
    return alerts;
  }

  return { update, get tracks() { return [...tracks.values()]; }, config: cfg, get camHeightM() { return camHeight; },
    get horizonFrac() { return horizonFrac; }, get nearMisses() { return nearMisses; } };
}

// ---------- browser loop ----------
// Region of the picture the detector looks at: the rider's own (left, for keep-left) side
// of the road, from the kerb to just past the centre where distant vehicles appear.
// Only this crop is analysed, which costs less than the whole frame and gives distant
// vehicles on the left more pixels. Returns [x, y, w, h] in source pixels.
// COCO-SSD (lite_mobilenet_v2) squeezes whatever it is given into 300 × 300 px. A tall
// portrait crop was squeezed 4× vertically and 2× horizontally, so a two-wheeler 20 m away
// shrank to ~20 px and was missed. The crop is now close to square (the band from just
// above the horizon to the near road), so nothing is squeezed more than ~1.3×.
export function watchRegion(keep, vw, vh) {
  const w = vw * 0.62, x = keep === 'left' ? 0 : vw - w;
  return [x, vh * 0.18, w, Math.min(vh * 0.7, w * 1.3)];
}

// Far tile: a zoomed view of the road around the horizon on the rider's side, where a
// wrong-side rider first appears. The main crop squeezes ~1300 px into the detector's
// 300 px, so a scooter was found only 5-13 m away: too late for 4 sightings at a closing
// speed of 60 km/h. This tile is ~2× finer and finds it at ~25-40 m. horizonFrac: where the
// horizon sits in the frame (learned from tracks; 0.42 until then).
export function farRegion(keep, vw, vh, horizonFrac = null) {
  const side = Math.min(vw, vh) * 0.42;
  const cx = keep === 'left' ? vw * 0.4 : vw * 0.6;
  const hy = (horizonFrac ?? 0.42) * vh;
  const x = Math.max(0, Math.min(vw - side, cx - side / 2));
  const y = Math.max(0, Math.min(vh - side, hy - side * 0.45));
  return [x, y, side, side];
}

// How long to wait before the next check (ms). Slow when stopped or when nothing is on
// the watched side; fast only while a vehicle there is close or approaching. Never faster
// than 2x the last inference time, so a hot, throttled phone backs off on its own.
export function nextInterval({ ownSpeedKmh, active, lastInferMs = 0 }) {
  // A wrong-side rider closing at 65 km/h (us 40 + them 25) crosses the 30 m → 6 m window in
  // about 1.3 s. Three clean sightings in that window need a check every ~0.3 s or faster.
  const base = ownSpeedKmh != null && ownSpeedKmh < 5 ? 1200 : active ? 150 : 250;
  return Math.min(2000, Math.max(base, 2 * lastInferMs));
}

// Region of a frame kept as evidence for one vehicle (video pixels): the vehicle plus room
// above for a rider's head and helmet, and a margin so a slightly late box still holds it.
export function subjectCrop([x, y, w, h], vw, vh) {
  const x0 = Math.max(0, x - w * 0.35), y0 = Math.max(0, y - h * 0.6);
  const x1 = Math.min(vw, x + w * 1.35), y1 = Math.min(vh, y + h * 1.15);
  return [x0, y0, x1 - x0, y1 - y0];
}

// Follows each alerted vehicle after the alert, keeping the shots where it is largest
// (closest: the number plate has the most pixels there). Pure bookkeeping, unit-tested.
export function createSubjectFollower({ followS = 2.5, keepShots = 6 } = {}) {
  const following = new Map();
  return {
    start(alert, t) { following.set(alert.trackId, { alert, shots: [], until: t + followS, context: null }); },
    has: (id) => following.has(id),
    get: (id) => following.get(id),
    add(id, shot) {
      const f = following.get(id); if (!f) return;
      f.shots.push(shot);
      if (f.shots.length > keepShots) { // drop the smallest view, but always keep the first
        let drop = 1;
        for (let i = 2; i < f.shots.length; i++) if (f.shots[i].areaPx < f.shots[drop].areaPx) drop = i;
        f.shots.splice(drop, 1);
      }
    },
    // ids whose vehicle has left the picture, is cut off by its edge, or ran out of time
    due(t, tracks) {
      const out = [];
      for (const [id, f] of following) {
        const tr = tracks.find((x) => x.id === id);
        if (!tr || t > f.until || (tr.last.clipped && t - tr.last.t < 0.01) || t - tr.last.t > 0.8) { out.push(f); following.delete(id); }
      }
      return out;
    },
  };
}

export function startAutoWatch({ video, overlay, loadDetector, getOwnSpeedKmh, keep = 'left', onAlert, onDetect, onStatus, focusOn, isPaused = () => false, isDiscreet = () => false }) {
  let stopped = false, frames = 0, lastStatus = 0, lastFocus = 0;
  const tracker = createWrongSideTracker({ keep });
  const follower = createSubjectFollower();
  const tileCanvas = [document.createElement('canvas'), document.createElement('canvas')];
  const hi = document.createElement('canvas'); // the full-resolution frame of this check (only while a vehicle is near)
  const hiCtx = hi.getContext('2d', { willReadFrequently: true });
  const lamp = document.createElement('canvas'); lamp.width = 40; lamp.height = 30;
  const lampCtx = lamp.getContext('2d', { willReadFrequently: true });
  let detector = null;
  loadDetector().then((d) => { detector = d; }).catch((e) => onStatus?.({ error: `Vehicle detector unavailable: ${e.message}` }));
  const started = performance.now();
  // ride diagnostics: how often the road was checked, how long each check took, what was seen
  const stats = { checks: 0, inferMsSum: 0, maxGapMs: 0, lastCheck: null, alerts: 0, vehiclesSeen: 0, lastIds: new Set() };

  const encode = (src, [x, y, w, h], maxSide, quality) => {
    const sc = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  };
  // a sensor-resolution crop around the vehicle, from the SAME frame its box came from
  async function shot(src, box, k, t, d) {
    const vb = box.map((v) => v / k); // detector frame → video pixels
    const crop = subjectCrop(vb, src.width || src.videoWidth, src.height || src.videoHeight);
    const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight;
    const blob = await encode(src, crop, 1600, 0.92);
    return blob && { blob, t: t * 1000, areaPx: vb[2] * vb[3], distanceM: d, subject: true,
      subjectBox: [(vb[0] - crop[0]) / crop[2], (vb[1] - crop[1]) / crop[3], vb[2] / crop[2], vb[3] / crop[3]].map((v) => +v.toFixed(4)),
      frameBox: [vb[0] / sw, vb[1] / sh, vb[2] / sw, vb[3] / sh].map((v) => +v.toFixed(4)) };
  }
  const focus = (box, k, t, vw, vh) => {
    if (!focusOn || t - lastFocus < 0.4) return;
    lastFocus = t;
    focusOn((box[0] + box[2] / 2) / k / vw, (box[1] + box[3] * 0.6) / k / vh); // a little low: the plate
  };

  let lastInferMs = 0, active = false;
  async function tick() {
    if (stopped) return;
    const cycleStart = performance.now();
    let wait = 500;
    try {
      if (!detector || !video.videoWidth || document.hidden || isPaused()) return; // paused while the camera is zoomed for a manual capture
      const vw = video.videoWidth, vh = video.videoHeight;
      const following = tracker.tracks.some((tr) => follower.has(tr.id));
      // The full-resolution copy of the frame (~33 MB at 4K) is only needed for evidence and
      // lamp checks while a vehicle is near or followed; copying it on every check starved the
      // page on 27 Nov. Otherwise the tiles are drawn straight from the video.
      const needHi = active || following;
      if (needHi) { if (hi.width !== vw || hi.height !== vh) { hi.width = vw; hi.height = vh; } hiCtx.drawImage(video, 0, 0, vw, vh); }
      const src = needHi ? hi : video;
      const main = watchRegion(keep, vw, vh);
      const own = getOwnSpeedKmh();
      // the far tile finds wrong-side riders 25-40 m away; skipped while stopped (nothing closes fast)
      const regions = own != null && own < 5 ? [main] : [main, farRegion(keep, vw, vh, tracker.horizonFrac)];
      const k = 384 / Math.max(main[2], main[3]); // detector frame scale (the detector resizes to 300 px anyway)
      const fw = vw * k, fh = vh * k;
      const preds = [];
      const t0 = performance.now();
      for (let i = 0; i < regions.length; i++) {
        const [rx, ry, rw, rh] = regions[i];
        const c = tileCanvas[i], kt = 384 / Math.max(rw, rh);
        c.width = Math.round(rw * kt); c.height = Math.round(rh * kt);
        c.getContext('2d').drawImage(src, rx, ry, rw, rh, 0, 0, c.width, c.height);
        const raw = await detector.detect(c, 20, 0.25); // busy roads: 10 boxes left out the faint ones
        const tile = [rx * k, ry * k, rw * k, rh * k];
        // back to full-frame coordinates (at scale k) so distance and lateral offset stay correct
        for (const p of raw) preds.push({ ...p, tile, bbox: [rx * k + (p.bbox[0] / kt) * k, ry * k + (p.bbox[1] / kt) * k, (p.bbox[2] / kt) * k, (p.bbox[3] / kt) * k] });
      }
      lastInferMs = performance.now() - t0;
      // lamps, sampled at full resolution: tail lamps on cars, buses and trucks (seen from
      // behind = going our way), headlamps on two-wheelers (running and facing us)
      for (const p of preds) {
        const four = ['car', 'bus', 'truck'].includes(p.class), two = p.class === 'motorcycle';
        if ((!four && !two) || p.bbox[2] / k < 24) continue;
        const [bx, by, bw, bh] = p.bbox.map((v) => v / k);
        lampCtx.drawImage(src, bx, by, bw, two ? bh * 0.75 : bh, 0, 0, lamp.width, lamp.height);
        const px = lampCtx.getImageData(0, 0, lamp.width, lamp.height);
        if (four) p.rear = looksLikeRear(tailLightScore(px)); else p.lit = looksLit(headlampScore(px));
      }
      frames++;
      const nowMs = performance.now();
      if (stats.lastCheck != null) stats.maxGapMs = Math.max(stats.maxGapMs, nowMs - stats.lastCheck);
      stats.lastCheck = nowMs; stats.checks++; stats.inferMsSum += lastInferMs;
      // portrait streams see a narrower horizontal angle than landscape ones
      tracker.config.fovDeg = vw >= vh ? 64 : 48;
      const tNow = Date.now() / 1000;
      const alerts = tracker.update(tNow * 1000, preds, fw, fh, own, [main[0] * k, main[1] * k, main[2] * k, main[3] * k]);
      for (const tr of tracker.tracks) if (!stats.lastIds.has(tr.id) && tr.obs.length >= 2) { stats.lastIds.add(tr.id); stats.vehiclesSeen++; }
      if (stats.lastIds.size > 500) stats.lastIds = new Set([...stats.lastIds].slice(-200));
      drawOverlay(overlay, { width: fw, height: fh }, tracker.tracks, alerts, isDiscreet());
      active = tracker.tracks.some((tr) => tNow - tr.last.t < 2 && tr.last.d < 45);
      // a new wrong-side vehicle: tell the rider now, keep the scene, and start following it
      for (const a of alerts) {
        stats.alerts++;
        if (!needHi) { if (hi.width !== vw || hi.height !== vh) { hi.width = vw; hi.height = vh; } hiCtx.drawImage(video, 0, 0, vw, vh); }
        follower.start({ ...a, frameW: fw, frameH: fh }, tNow);
        follower.get(a.trackId).context = { blob: await encode(hi, [0, 0, vw, vh], 1920, 0.88), t: tNow * 1000, frameBox: [a.box[0] / fw, a.box[1] / fh, a.box[2] / fw, a.box[3] / fh] };
        onDetect?.({ ...a, frameW: fw, frameH: fh });
      }
      // every followed vehicle seen in this check: a full-resolution shot, focus on it
      for (const tr of tracker.tracks) {
        if (!follower.has(tr.id) || Math.abs(tr.last.t - tNow) > 1e-3 || tr.last.clipped) continue;
        const sh = await shot(needHi ? hi : video, tr.last.box, k, tNow, +tr.last.d.toFixed(1));
        if (sh) follower.add(tr.id, sh);
        focus(tr.last.box, k, tNow, vw, vh);
      }
      // done following (closest view passed): hand over the evidence; none is dropped
      for (const f of follower.due(tNow, tracker.tracks)) onAlert?.({ ...f.alert, shots: f.shots, context: f.context });
      const now = performance.now();
      if (now - lastStatus > 1000) {
        lastStatus = now;
        const seen = tracker.tracks.filter((tr) => tNow - tr.last.t < 1);
        onStatus?.({ fps: frames / ((now - started) / 1000), vehicles: seen.length, inferMs: Math.round(lastInferMs), active, tiles: regions.length,
          tracks: seen.map((tr) => ({ cls: tr.cls, n: tr.obs.length, d: +tr.last.d.toFixed(1), lateral: +tr.last.lateral.toFixed(1), fired: tr.fired })) });
      }
      // the interval is start-to-start, so subtract the time this check already took
      wait = Math.max(0, nextInterval({ ownSpeedKmh: own, active: active || following, lastInferMs }) - (performance.now() - cycleStart));
    } catch (e) { onStatus?.({ error: e.message }); } finally { if (!stopped) setTimeout(tick, wait); }
  }
  tick();
  const stop = () => { stopped = true; overlay?.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
  // summary for the ride report: did the watcher get to look often enough, and what it passed on
  stop.diagnostics = () => ({
    minutes: +((performance.now() - started) / 60000).toFixed(1), checks: stats.checks,
    checksPerS: +(stats.checks / Math.max(1, (performance.now() - started) / 1000)).toFixed(2),
    avgInferMs: stats.checks ? Math.round(stats.inferMsSum / stats.checks) : null, maxGapMs: Math.round(stats.maxGapMs),
    vehiclesSeen: stats.vehiclesSeen, alerts: stats.alerts, nearMisses: tracker.nearMisses.slice(-25),
  });
  return stop;
}

function drawOverlay(overlay, frame, tracks, alerts, discreet = false) {
  if (!overlay) return;
  overlay.width = frame.width; overlay.height = frame.height;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const hot = new Set(alerts.map((a) => a.trackId));
  ctx.lineWidth = 3; ctx.font = '600 14px system-ui';
  for (const tr of tracks) {
    if (Date.now() / 1000 - tr.last.t > 0.8) continue;
    const [x, y, w, h] = tr.last.box;
    if (discreet) {
      // camera-style focus brackets only: nothing on screen says what is being looked for
      const c = Math.min(w, h) * 0.22;
      ctx.strokeStyle = hot.has(tr.id) || tr.fired ? 'rgba(255,214,10,.95)' : 'rgba(255,255,255,.6)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
        ctx.moveTo(px + dx * c, py); ctx.lineTo(px, py); ctx.lineTo(px, py + dy * c);
      }
      ctx.stroke();
      continue;
    }
    ctx.strokeStyle = hot.has(tr.id) || tr.fired ? '#e5484d' : 'rgba(255,255,255,.75)';
    ctx.strokeRect(x, y, w, h);
    const label = `${LABELS[tr.cls]} · ${Math.round(tr.last.d)} m`;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x, Math.max(0, y - 20), ctx.measureText(label).width + 10, 20);
    ctx.fillStyle = '#fff'; ctx.fillText(label, x + 5, Math.max(14, y - 5));
  }
}
