// Hands-free wrong-side detection.
//
// Pure tracking/decision logic (createWrongSideTracker) is DOM-free and unit-tested.
// The browser loop (startAutoWatch) feeds it COCO-SSD detections from the live camera.
//
// How a vehicle is judged "wrong side" (all estimates, never certainties):
//  1. Distance from apparent width: d = realWidth / (2·tan(FOV/2) · boxWidth/frameWidth),
//     using a typical real width per vehicle class.
//  2. Closing speed from the slope of distance over the last ≥3 sightings.
//  3. "Oncoming" when it closes faster than the rider is moving (it has its own
//     velocity toward us), so slower traffic we are catching up to doesn't count.
//  4. "In our lane" from the lateral offset in metres at that distance:
//     keep-left traffic (India) → oncoming traffic belongs on our right; an oncoming
//     vehicle at or left of our line of travel is on the wrong side.
// Every trigger is saved as "suspected" with the numbers behind it for human review.

export const REAL_WIDTH_M = { car: 1.75, motorcycle: 0.8, bicycle: 0.6, bus: 2.55, truck: 2.5 };
export const LABELS = { motorcycle: 'Two-wheeler', car: 'Car', bus: 'Bus', truck: 'Truck / tempo', bicycle: 'Cycle' };

// Overlap measured against the SMALLER box: an approaching vehicle's box can grow
// several-fold between checks, which plain IoU would treat as a different vehicle.
const overlap = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
};

function fit(points) { // least squares d over t (seconds): slope and how well a straight line explains it
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n, md = points.reduce((s, p) => s + p.d, 0) / n;
  let num = 0, den = 0, tot = 0;
  for (const p of points) { num += (p.t - mt) * (p.d - md); den += (p.t - mt) ** 2; tot += (p.d - md) ** 2; }
  const slope = den ? num / den : 0;
  let res = 0;
  for (const p of points) res += (p.d - (md + slope * (p.t - mt))) ** 2;
  return { slope, r2: tot ? 1 - res / tot : 0 };
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
    minOwnVelocityFrac: 0.25, // ...and this fraction of our speed (distance-from-width is ±25 %)
    maxOwnVelocityKmh: 140, // faster than this is a measurement glitch, not a vehicle
    minDistanceM: 4,       // closer than this the box is usually cut off by the picture edge
    minSightings: 3,       // seen at least this many times...
    minSpanS: 0.6,         // ...over at least this long...
    minFitR2: 0.6,         // ...closing steadily (distances on a straight line, not jitter)
    requireOwnSpeed: true, // without GPS speed we cannot tell oncoming from slower traffic
    minScore: 0.45,
    ...options,
  };
  const tracks = new Map();
  let nextId = 1;
  const tanHalf = () => Math.tan((cfg.fovDeg * Math.PI) / 360);

  // region: [x, y, w, h] of the analysed crop in frame coordinates. A box touching its
  // edge is cut off, so its width (and the distance from it) is wrong.
  function update(tMs, detections, frameW, frameH, ownSpeedKmh = null, region = [0, 0, frameW, frameH]) {
    const edge = 0.015 * frameW;
    const clippedBox = ([x, y, w, h]) => x <= region[0] + edge || x + w >= region[0] + region[2] - edge || y + h >= region[1] + region[3] - edge;
    const t = tMs / 1000;
    const vehicles = detections.filter((d) => REAL_WIDTH_M[d.class] && d.score >= cfg.minScore);
    // associate detections with tracks (greedy by IoU, same class)
    const free = new Set(tracks.keys());
    for (const det of vehicles) {
      let best = null;
      for (const id of free) {
        const tr = tracks.get(id);
        if (tr.cls !== det.class) continue;
        const o = overlap(tr.last.box, det.bbox);
        if (o > 0.5 && (!best || o > best.o)) best = { id, o };
      }
      const wFrac = det.bbox[2] / frameW;
      const d = REAL_WIDTH_M[det.class] / (2 * tanHalf() * Math.max(wFrac, 1e-3));
      const cx = (det.bbox[0] + det.bbox[2] / 2) / frameW;
      const lateral = (cx - 0.5) * 2 * d * tanHalf(); // metres, + = right of our line of travel
      const obs = { t, box: det.bbox, d, lateral, score: det.score, clipped: clippedBox(det.bbox) };
      if (best) {
        free.delete(best.id);
        const tr = tracks.get(best.id);
        tr.obs.push(obs); if (tr.obs.length > 10) tr.obs.shift();
        tr.last = obs;
      } else {
        const id = nextId++;
        tracks.set(id, { id, cls: det.class, obs: [obs], last: obs, fired: false });
      }
    }
    for (const [id, tr] of tracks) if (t - tr.last.t > 1.5) tracks.delete(id);

    const alerts = [];
    if (ownSpeedKmh == null && cfg.requireOwnSpeed) return alerts;
    for (const tr of tracks.values()) {
      if (tr.fired || tr.last.clipped) continue;
      const good = tr.obs.filter((o) => !o.clipped);
      if (good.length < cfg.minSightings) continue;
      const span = good[good.length - 1].t - good[0].t;
      if (span < cfg.minSpanS) continue;
      const { slope, r2 } = fit(good);
      if (r2 < cfg.minFitR2) continue;
      const closingKmh = -slope * 3.6;
      const own = ownSpeedKmh ?? 0;
      const ownVelocityKmh = closingKmh - own; // the other vehicle's own speed toward us
      const near = tr.last.d <= cfg.triggerDistanceM && tr.last.d >= cfg.minDistanceM;
      // lateral offset toward the side oncoming traffic should use
      const towardOncoming = cfg.keep === 'left' ? tr.last.lateral : -tr.last.lateral;
      const inOurLane = towardOncoming <= cfg.sideEdgeM;
      const needed = Math.max(cfg.minOwnVelocityKmh + (ownSpeedKmh == null ? 7 : 0), cfg.minOwnVelocityFrac * own);
      if (near && inOurLane && ownVelocityKmh >= needed && ownVelocityKmh <= cfg.maxOwnVelocityKmh) {
        tr.fired = true;
        alerts.push({
          trackId: tr.id, vehicleClass: tr.cls, type: LABELS[tr.cls], box: tr.last.box,
          distanceM: +tr.last.d.toFixed(1), lateralM: +towardOncoming.toFixed(1),
          closingKmh: Math.round(closingKmh), oncomingKmh: Math.round(ownVelocityKmh),
          ownSpeedKmh: ownSpeedKmh == null ? null : Math.round(ownSpeedKmh),
          score: +Math.max(...tr.obs.map((o) => o.score)).toFixed(2), sightings: good.length,
          fitR2: +r2.toFixed(2), spanS: +span.toFixed(1),
          // it closes faster than we move, so it is driving toward us: we see its front
          direction: 'toward you', view: 'front',
        });
      }
    }
    return alerts;
  }

  return { update, get tracks() { return [...tracks.values()]; }, config: cfg };
}

// ---------- browser loop ----------
// Region of the picture the detector looks at: the rider's own (left, for keep-left) side
// of the road, from the kerb to just past the centre where distant vehicles appear.
// Only this crop is analysed, which costs less than the whole frame and gives distant
// vehicles on the left more pixels. Returns [x, y, w, h] in source pixels.
export function watchRegion(keep, vw, vh) {
  const w = vw * 0.62, x = keep === 'left' ? 0 : vw - w;
  return [x, vh * 0.18, w, vh * 0.7];
}

// How long to wait before the next check (ms). Slow when stopped or when nothing is on
// the watched side; fast only while a vehicle there is close or approaching. Never faster
// than 2x the last inference time, so a hot, throttled phone backs off on its own.
export function nextInterval({ ownSpeedKmh, active, lastInferMs = 0 }) {
  // A wrong-side vehicle closing at 50 km/h covers the last 15 m (where it is recognisable) in
  // about a second, so a moving rider needs a check every ~0.5 s to see it at least twice.
  const base = ownSpeedKmh != null && ownSpeedKmh < 5 ? 1200 : active ? 300 : 500;
  return Math.min(2000, Math.max(base, 2 * lastInferMs));
}

export function startAutoWatch({ video, overlay, loadDetector, getOwnSpeedKmh, keep = 'left', onAlert, onStatus, isPaused = () => false, isDiscreet = () => false }) {
  let stopped = false, frames = 0, lastStatus = 0, lastAlert = 0;
  const tracker = createWrongSideTracker({ keep });
  const canvas = document.createElement('canvas');
  let detector = null;
  loadDetector().then((d) => { detector = d; }).catch((e) => onStatus?.({ error: `Vehicle detector unavailable: ${e.message}` }));
  const started = performance.now();

  let lastInferMs = 0, active = false;
  async function tick() {
    if (stopped) return;
    const cycleStart = performance.now();
    let wait = 500;
    try {
      if (!detector || !video.videoWidth || document.hidden || isPaused()) return; // paused while the camera is zoomed for evidence
      const vw = video.videoWidth, vh = video.videoHeight;
      const [rx, ry, rw, rh] = watchRegion(keep, vw, vh);
      const k = 576 / rw; // crop always fed at 576 px wide: low-res cameras get enlarged, which helps the detector find small, distant vehicles
      canvas.width = Math.round(rw * k); canvas.height = Math.round(rh * k);
      canvas.getContext('2d').drawImage(video, rx, ry, rw, rh, 0, 0, canvas.width, canvas.height);
      const t0 = performance.now();
      const raw = await detector.detect(canvas, 10, 0.4);
      lastInferMs = performance.now() - t0;
      // back to full-frame coordinates (at scale k) so distance and lateral offset stay correct
      const fw = vw * k, fh = vh * k;
      const preds = raw.map((p) => ({ ...p, bbox: [rx * k + p.bbox[0], ry * k + p.bbox[1], p.bbox[2], p.bbox[3]] }));
      frames++;
      // portrait streams see a narrower horizontal angle than landscape ones
      tracker.config.fovDeg = vw >= vh ? 64 : 48;
      const own = getOwnSpeedKmh();
      const alerts = tracker.update(Date.now(), preds, fw, fh, own, [rx * k, ry * k, rw * k, rh * k]);
      drawOverlay(overlay, { width: fw, height: fh }, tracker.tracks, alerts, isDiscreet());
      const nowS = Date.now() / 1000;
      active = tracker.tracks.some((tr) => nowS - tr.last.t < 2 && tr.last.d < 45);
      for (const a of alerts) {
        if (Date.now() - lastAlert < 4000) continue; // one burst at a time
        lastAlert = Date.now();
        onAlert?.({ ...a, frameW: fw, frameH: fh });
      }
      const now = performance.now();
      if (now - lastStatus > 1000) {
        lastStatus = now;
        const seen = tracker.tracks.filter((tr) => nowS - tr.last.t < 1);
        onStatus?.({ fps: frames / ((now - started) / 1000), vehicles: seen.length, inferMs: Math.round(lastInferMs), active,
          tracks: seen.map((tr) => ({ cls: tr.cls, n: tr.obs.length, d: +tr.last.d.toFixed(1), lateral: +tr.last.lateral.toFixed(1), fired: tr.fired })) });
      }
      // the interval is start-to-start, so subtract the time this check already took
      wait = Math.max(0, nextInterval({ ownSpeedKmh: own, active, lastInferMs }) - (performance.now() - cycleStart));
    } catch (e) { onStatus?.({ error: e.message }); } finally { if (!stopped) setTimeout(tick, wait); }
  }
  tick();
  return () => { stopped = true; overlay?.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
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
