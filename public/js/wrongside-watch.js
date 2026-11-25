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

function slope(points) { // least squares d over t (seconds)
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n, md = points.reduce((s, p) => s + p.d, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mt) * (p.d - md); den += (p.t - mt) ** 2; }
  return den ? num / den : 0;
}

export function createWrongSideTracker(options = {}) {
  const cfg = {
    fovDeg: 60,            // horizontal field of view of the video stream
    keep: 'left',          // which side traffic keeps to ('left' for India/UK, 'right' elsewhere)
    triggerDistanceM: 30,  // decide only once the vehicle is this close
    ownLaneEdgeM: 1.0,     // lateral offset (towards the oncoming side) where our lane ends
    minOwnVelocityKmh: 8,  // the vehicle's own speed toward us must exceed this
    minScore: 0.45,
    ...options,
  };
  const tracks = new Map();
  let nextId = 1;
  const tanHalf = () => Math.tan((cfg.fovDeg * Math.PI) / 360);

  function update(tMs, detections, frameW, frameH, ownSpeedKmh = null) {
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
      const obs = { t, box: det.bbox, d, lateral, score: det.score };
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
    for (const tr of tracks.values()) {
      if (tr.fired || tr.obs.length < 2) continue;
      const span = tr.obs[tr.obs.length - 1].t - tr.obs[0].t;
      if (span < (tr.obs.length >= 3 ? 0.6 : 0.3)) continue; // 2 sightings allowed when spaced out
      const closingKmh = -slope(tr.obs) * 3.6;
      const own = ownSpeedKmh ?? 0;
      const ownVelocityKmh = closingKmh - own; // the other vehicle's own speed toward us
      const near = tr.last.d <= cfg.triggerDistanceM;
      // lateral offset toward the side oncoming traffic should use
      const towardOncoming = cfg.keep === 'left' ? tr.last.lateral : -tr.last.lateral;
      const inOurLane = towardOncoming < cfg.ownLaneEdgeM;
      const needed = cfg.minOwnVelocityKmh + (ownSpeedKmh == null ? 7 : 0); // stricter without GPS speed
      if (near && inOurLane && ownVelocityKmh >= needed) {
        tr.fired = true;
        alerts.push({
          trackId: tr.id, vehicleClass: tr.cls, type: LABELS[tr.cls], box: tr.last.box,
          distanceM: +tr.last.d.toFixed(1), lateralM: +towardOncoming.toFixed(1),
          closingKmh: Math.round(closingKmh), oncomingKmh: Math.round(ownVelocityKmh),
          ownSpeedKmh: ownSpeedKmh == null ? null : Math.round(ownSpeedKmh),
          score: +Math.max(...tr.obs.map((o) => o.score)).toFixed(2), sightings: tr.obs.length,
        });
      }
    }
    return alerts;
  }

  return { update, get tracks() { return [...tracks.values()]; }, config: cfg };
}

// ---------- browser loop ----------
export function startAutoWatch({ video, overlay, loadDetector, getOwnSpeedKmh, keep = 'left', onAlert, onStatus }) {
  let stopped = false, busy = false, frames = 0, lastStatus = 0, lastAlert = 0;
  const tracker = createWrongSideTracker({ keep });
  const canvas = document.createElement('canvas');
  let detector = null;
  loadDetector().then((d) => { detector = d; }).catch((e) => onStatus?.({ error: `Vehicle detector unavailable: ${e.message}` }));
  const started = performance.now();

  async function tick() {
    if (stopped) return;
    setTimeout(tick, 350);
    if (busy || !detector || !video.videoWidth || document.hidden) return;
    busy = true;
    try {
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      // Alternate the full frame with a 2x zoom on the centre of the road: distant vehicles
      // in our lane are only ~30-40 px wide in the full frame, below what the lightweight
      // detector reliably finds. Crop boxes are mapped back to full-frame coordinates.
      const zoom = frames % 2 === 1;
      const vw = video.videoWidth, vh = video.videoHeight;
      const src = zoom ? [vw * 0.25, vh * 0.25, vw * 0.5, vh * 0.5] : [0, 0, vw, vh];
      canvas.getContext('2d').drawImage(video, src[0], src[1], src[2], src[3], 0, 0, canvas.width, canvas.height);
      let preds = await detector.detect(canvas, 12, 0.4);
      if (zoom) {
        preds = preds.map((p) => ({ ...p, bbox: [canvas.width * 0.25 + p.bbox[0] / 2, canvas.height * 0.25 + p.bbox[1] / 2, p.bbox[2] / 2, p.bbox[3] / 2] }));
      }
      frames++;
      // portrait streams see a narrower horizontal angle than landscape ones
      tracker.config.fovDeg = canvas.width >= canvas.height ? 64 : 48;
      const alerts = tracker.update(Date.now(), preds, canvas.width, canvas.height, getOwnSpeedKmh());
      drawOverlay(overlay, canvas, tracker.tracks, alerts);
      const now = performance.now();
      for (const a of alerts) {
        if (Date.now() - lastAlert < 4000) continue; // one burst at a time
        lastAlert = Date.now();
        onAlert?.({ ...a, frameW: canvas.width, frameH: canvas.height });
      }
      if (now - lastStatus > 1000) {
        lastStatus = now;
        const seen = tracker.tracks.filter((tr) => Date.now() / 1000 - tr.last.t < 1);
        onStatus?.({ fps: frames / ((now - started) / 1000), vehicles: seen.length,
          tracks: seen.map((tr) => ({ cls: tr.cls, n: tr.obs.length, d: +tr.last.d.toFixed(1), lateral: +tr.last.lateral.toFixed(1), fired: tr.fired })) });
      }
    } catch (e) { onStatus?.({ error: e.message }); } finally { busy = false; }
  }
  tick();
  return () => { stopped = true; overlay?.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
}

function drawOverlay(overlay, frame, tracks, alerts) {
  if (!overlay) return;
  overlay.width = frame.width; overlay.height = frame.height;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const hot = new Set(alerts.map((a) => a.trackId));
  ctx.lineWidth = 3; ctx.font = '600 14px system-ui';
  for (const tr of tracks) {
    if (Date.now() / 1000 - tr.last.t > 0.8) continue;
    const [x, y, w, h] = tr.last.box;
    ctx.strokeStyle = hot.has(tr.id) || tr.fired ? '#e5484d' : 'rgba(255,255,255,.75)';
    ctx.strokeRect(x, y, w, h);
    const label = `${LABELS[tr.cls]} · ${Math.round(tr.last.d)} m`;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x, Math.max(0, y - 20), ctx.measureText(label).width + 10, 20);
    ctx.fillStyle = '#fff'; ctx.fillText(label, x + 5, Math.max(14, y - 5));
  }
}
